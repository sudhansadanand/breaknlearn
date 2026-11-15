/**
 * POST /api/v1/progress/legacy-import (spec §10.2–10.4, ADR-0002 L1–L3, MIG-002..004).
 * The device uploads its untouched localStorage snapshot; the server re-computes the fingerprint,
 * converts it with the shared lossless converter, and writes only learner_progress rows (one legacy
 * attempt per learner/lesson/theme) plus migration_runs/migration_aliases. Never fabricates sessions,
 * events or quiz scores; never regresses newer server progress; idempotent by
 * (migration_run_id, legacy_fingerprint) and by Idempotency-Key.
 */
import { HttpError } from "@bnl/auth";
import { LegacyImportReceipt, LegacyImportRequest, MULTIPLICATION_LESSON_IDS, Uuid } from "@bnl/contracts";
import {
  convertLegacy,
  legacyFingerprintInput,
  planLegacyImport,
  type ImportTarget,
  type StoredProgressRow,
} from "@bnl/student-progress";
import { z } from "zod";
import { verifyDeviceBearer, withDevice } from "../authn";
import type { Sql } from "../db-port";
import { json, validationFailed, type Ctx } from "../http";
import { enforceLearningRateLimit, readBoundedJson, requireIdempotencyKey, sha256Hex } from "./common";
import { REPLAY_HEADER, idempotent, requestSha } from "./idempotency";
import { learningRepo, type LearningRepo } from "./index";
import { legacyAttemptId } from "./uuid";

/** Two profiles × 60 lesson entries plus historical keys fit comfortably. */
export const LEGACY_IMPORT_MAX_BYTES = 128 * 1024;

/**
 * Additive request field (proposal docs/adr/proposals/A6-learning-contract-additions.md):
 * the guardian's explicit assignment of historical-key (×3, profile-less) entries to one learner.
 */
export const LegacyImportRequestV1A = LegacyImportRequest.extend({ historical_learner_id: Uuid.nullable().optional() });

/** Receipt plus the additive `historical` block (same proposal). */
export const LegacyImportReceiptV1A = LegacyImportReceipt.extend({
  historical: z.object({
    entries_found: z.number().int().min(0),
    entries_pending_assignment: z.number().int().min(0),
    entries_unrecognized: z.number().int().min(0),
  }),
});
export type LegacyImportReceiptV1A = z.infer<typeof LegacyImportReceiptV1A>;

const lessonIdForTable = (table: number): string | null => MULTIPLICATION_LESSON_IDS[table] ?? null;

export async function legacyImportHandler(req: Request, c: Ctx): Promise<Response> {
  const claims = await verifyDeviceBearer(req, c);
  const key = requireIdempotencyKey(req);
  await enforceLearningRateLimit(c, "legacyImportByDevice", claims.sub);
  const raw = await readBoundedJson(req, LEGACY_IMPORT_MAX_BYTES);
  const parsed = LegacyImportRequestV1A.safeParse(raw);
  if (!parsed.success) throw validationFailed(parsed.error.issues);
  const body = parsed.data;

  // The fingerprint is re-computed over the snapshot the server actually received.
  if (sha256Hex(legacyFingerprintInput(body.raw)) !== body.legacy_fingerprint) {
    throw validationFailed([{ path: ["legacy_fingerprint"], code: "fingerprint_mismatch" }], "legacy_fingerprint does not match raw");
  }
  const conversion = convertLegacy(body.raw);

  // Mapping rules (M06 ambiguity rule): explicit, one-to-one, and every profile with entries is mapped.
  const localIds = new Set(conversion.profiles.map((p) => p.local_profile_id));
  const mapping = new Map<string, string>();
  const issues: { path: (string | number)[]; code: string }[] = [];
  body.profile_mapping.forEach((m, i) => {
    if (!localIds.has(m.local_profile_id)) issues.push({ path: ["profile_mapping", i, "local_profile_id"], code: "unknown_local_profile" });
    else if (mapping.has(m.local_profile_id) || [...mapping.values()].includes(m.learner_id)) issues.push({ path: ["profile_mapping", i], code: "duplicate_mapping" });
    else mapping.set(m.local_profile_id, m.learner_id);
  });
  conversion.profiles.forEach((p) => {
    if (p.entries.length > 0 && !mapping.has(p.local_profile_id)) issues.push({ path: ["profile_mapping"], code: "profile_mapping_missing" });
  });
  if (issues.length > 0) throw validationFailed(issues, "profile_mapping is incomplete or ambiguous");
  const historicalLearnerId = body.historical_learner_id ?? null;

  const repo = learningRepo();
  const now = c.deps.now();
  const result = await withDevice(c, claims, (sql) =>
    idempotent(sql, repo, { scope: "progress.legacy_import", key, ownerId: claims.sub, householdId: claims.hid, requestSha256: requestSha(raw), now }, async () => {
      const learners = new Set(await repo.learnerIdsInHousehold(sql, claims.hid));
      const wanted = [...mapping.values(), ...(historicalLearnerId ? [historicalLearnerId] : [])];
      if (wanted.some((l) => !learners.has(l))) throw new HttpError(403, "forbidden", "Learner is not in your household");

      const prior = await repo.findMigrationRun(sql, claims.hid, body.migration_run_id, body.legacy_fingerprint);
      if (prior) return { status: 200, body: alreadyImported(prior.receipt) };

      const aliases = await repo.aliasesForDevice(sql, claims.sub);
      for (const [local, learner] of mapping) {
        const a = aliases.find((x) => x.localProfileId === local);
        if (a && a.learnerId !== learner) {
          throw new HttpError(409, "conflict", "This device's local profile is already linked to a different learner", { local_profile_id: local });
        }
      }

      const runId = await repo.insertMigrationRun(sql, { householdId: claims.hid, deviceId: claims.sub, migrationRunId: body.migration_run_id, fingerprint: body.legacy_fingerprint });
      if (!runId) {
        // A concurrent identical import committed first; its receipt is final once our insert returned.
        const winner = await repo.findMigrationRun(sql, claims.hid, body.migration_run_id, body.legacy_fingerprint);
        if (!winner) throw new Error("migration run vanished after conflict");
        return { status: 200, body: alreadyImported(winner.receipt) };
      }

      const receipt = await importRows(sql, repo, claims.hid, conversion, mapping, historicalLearnerId, body.migration_run_id);
      await repo.setMigrationReceipt(sql, runId, receipt);
      for (const [local, learner] of mapping) {
        if (!aliases.some((x) => x.localProfileId === local)) {
          await repo.insertAlias(sql, { householdId: claims.hid, deviceId: claims.sub, localProfileId: local, learnerId: learner, migrationRunServerId: runId, fingerprint: body.legacy_fingerprint });
        }
      }
      await c.deps.repos.audit.insert(sql, {
        actorAuthId: claims.sub,
        householdId: claims.hid,
        action: "progress.legacy_imported",
        targetType: "migration_run",
        targetId: runId,
        // Counts only: never names, raw keys or progress values.
        metadata: {
          profiles: receipt.per_profile.length,
          entries_imported: receipt.per_profile.reduce((n, p) => n + p.entries_imported, 0),
          entries_skipped: receipt.per_profile.reduce((n, p) => n + p.entries_skipped_newer_on_server, 0),
          historical_pending: receipt.historical.entries_pending_assignment,
        },
      });
      return { status: 200, body: receipt };
    }),
  );
  return json(c, result.body, result.status, result.replayed ? { [REPLAY_HEADER]: "true" } : {});
}

function alreadyImported(stored: unknown): LegacyImportReceiptV1A {
  return LegacyImportReceiptV1A.parse({ ...LegacyImportReceiptV1A.parse(stored), outcome: "already_imported" });
}

async function importRows(
  sql: Sql,
  repo: LearningRepo,
  householdId: string,
  conversion: ReturnType<typeof convertLegacy>,
  mapping: ReadonlyMap<string, string>,
  historicalLearnerId: string | null,
  migrationRunId: string,
): Promise<LegacyImportReceiptV1A> {
  const learnerIds = [...new Set([...mapping.values(), ...(historicalLearnerId ? [historicalLearnerId] : [])])];
  const lessonIds = Object.values(MULTIPLICATION_LESSON_IDS);
  const stored = await repo.progressForLearners(sql, learnerIds, lessonIds);
  const existing = (t: ImportTarget): StoredProgressRow[] =>
    stored
      .filter((r) => r.learnerId === t.learner_id && r.lessonId === t.lesson_id && r.themeKey === t.theme_key)
      .map((r) => ({ attempt_id: r.attemptId, slide_id: r.slideId, position_seconds: r.positionSeconds, completed: r.completed, server_revision: r.serverRevision, client_revision: r.clientRevision }));

  const plan = planLegacyImport({
    conversion,
    mapping,
    historicalLearnerId,
    lessonIdForTable,
    attemptIdFor: (t) => legacyAttemptId(t.learner_id, t.lesson_id, t.theme_key),
    existing,
  });

  for (const w of plan.writes) {
    const write = {
      householdId,
      learnerId: w.target.learner_id,
      lessonId: w.target.lesson_id,
      themeKey: w.target.theme_key,
      attemptId: w.attempt_id,
      lessonVersionId: null,
      slideId: w.slide_id,
      positionSeconds: w.position_seconds,
      completed: w.completed,
      clientRevision: 0,
    };
    if (w.kind === "insert") {
      if (!(await repo.insertProgress(sql, write))) throw new HttpError(409, "conflict", "Concurrent progress write; retry the import");
    } else {
      const row = stored.find((r) => r.attemptId === w.attempt_id && r.learnerId === w.target.learner_id && r.lessonId === w.target.lesson_id && r.themeKey === w.target.theme_key);
      if (!row || !(await repo.updateProgress(sql, row.id, w.expected_server_revision, write))) {
        throw new HttpError(409, "conflict", "Concurrent progress write; retry the import");
      }
    }
  }

  return LegacyImportReceiptV1A.parse({
    migration_run_id: migrationRunId,
    outcome: "imported",
    per_profile: plan.per_profile.map((p) => ({ ...p })),
    historical: plan.historical,
  });
}
