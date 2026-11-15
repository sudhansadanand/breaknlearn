/**
 * Progress sync and read (M09). Identity is (learner, lesson, theme, attempt); clocks are untrusted,
 * server revisions decide (ADR-0002 G1). Completion never regresses within an attempt (merge rule +
 * row trigger). The learner must belong to the caller's household (SEC-003 → 403).
 */
import { HttpError, type AdultIdentity } from "@bnl/auth";
import { PageQuery, ProgressState, ProgressSyncRequest, ProgressSyncResponse, Uuid, type DeviceTokenClaims } from "@bnl/contracts";
import { mergeProgress, slideIndexOf } from "@bnl/student-progress";
import type { z } from "zod";
import { hasBearer, requireAdult, verifyDeviceBearer, withAdultHousehold, withDevice } from "../authn";
import type { Sql } from "../db-port";
import { json, validationFailed, type Ctx } from "../http";
import { enforceLearningRateLimit, readBoundedJson, requireIdempotencyKey } from "./common";
import { REPLAY_HEADER, idempotent, requestSha } from "./idempotency";
import { learningRepo, type LearningRepo, type ProgressRow } from "./index";

const SYNC_MAX_BYTES = 8 * 1024;

export function toProgressState(row: ProgressRow): ProgressState {
  if (row.themeKey === null) throw new Error("progress row without theme_key cannot be expressed in ProgressState v1");
  return ProgressState.parse({
    learner_id: row.learnerId,
    lesson_id: row.lessonId,
    lesson_version_id: row.lessonVersionId,
    theme_key: row.themeKey,
    attempt_id: row.attemptId,
    slide_id: row.slideId,
    position_seconds: row.positionSeconds,
    completed: row.completed,
    server_revision: row.serverRevision,
    updated_at: new Date(row.updatedAt).toISOString(),
  });
}

const forbiddenLearner = () => new HttpError(403, "forbidden", "Learner is not in your household");

async function assertLearnerInHousehold(sql: Sql, repo: LearningRepo, householdId: string, learnerId: string): Promise<void> {
  const learners = await repo.learnerIdsInHousehold(sql, householdId);
  if (!learners.includes(learnerId)) throw forbiddenLearner();
}

/** POST /api/v1/progress/sync — device only, Idempotency-Key required. */
export async function progressSyncHandler(req: Request, c: Ctx): Promise<Response> {
  const claims = await verifyDeviceBearer(req, c);
  const key = requireIdempotencyKey(req);
  await enforceLearningRateLimit(c, "progressSyncByDevice", claims.sub);
  const raw = await readBoundedJson(req, SYNC_MAX_BYTES);
  const parsed = ProgressSyncRequest.safeParse(raw);
  if (!parsed.success) throw validationFailed(parsed.error.issues);
  const body = parsed.data;
  const repo = learningRepo();
  const now = c.deps.now();

  const result = await withDevice(c, claims, (sql) =>
    idempotent(sql, repo, { scope: "progress.sync", key, ownerId: claims.sub, householdId: claims.hid, requestSha256: requestSha(raw), now }, async () => {
      await assertLearnerInHousehold(sql, repo, claims.hid, body.learner_id);
      return { status: 200, body: await applySync(sql, repo, claims, body) };
    }),
  );
  return json(c, result.body, result.status, result.replayed ? { [REPLAY_HEADER]: "true" } : {});
}

async function applySync(sql: Sql, repo: LearningRepo, claims: DeviceTokenClaims, body: ProgressSyncRequest): Promise<z.infer<typeof ProgressSyncResponse>> {
  const [known] = await repo.knownLessonIds(sql, [body.lesson_id]);
  if (!known) throw validationFailed([{ path: ["lesson_id"], code: "lesson_unknown" }], "Unknown lesson");
  if (body.lesson_version_id) {
    const versions = await repo.knownVersions(sql, [body.lesson_version_id]);
    if (versions.get(body.lesson_version_id) !== body.lesson_id) {
      throw validationFailed([{ path: ["lesson_version_id"], code: "lesson_unknown" }], "Unknown lesson version");
    }
  }
  const k = { learnerId: body.learner_id, lessonId: body.lesson_id, themeKey: body.theme_key, attemptId: body.attempt_id };
  const write = {
    ...k,
    householdId: claims.hid,
    lessonVersionId: body.lesson_version_id ?? null,
    slideId: body.slide_id ?? null,
    positionSeconds: body.position_seconds ?? 0,
    completed: body.completed,
    clientRevision: body.client_revision,
  };
  const incoming = {
    slide_index: slideIndexOf(body.slide_id),
    position_seconds: body.position_seconds ?? 0,
    completed: body.completed,
    client_revision: body.client_revision,
    base_server_revision: body.base_server_revision,
  };

  // Two passes at most: a concurrent first write turns our insert into an update of its row.
  for (let pass = 0; pass < 2; pass++) {
    const current = await repo.getProgressForUpdate(sql, k);
    if (!current) {
      if (body.base_server_revision !== null) {
        // The client claims a server state that does not exist (MIG-006: safe conflict, nothing written).
        throw new HttpError(409, "conflict", "base_server_revision does not match any server state", { server_revision: null });
      }
      const inserted = await repo.insertProgress(sql, write);
      if (inserted) return { outcome: "applied", state: toProgressState(inserted) };
      continue;
    }
    if (body.base_server_revision !== null && body.base_server_revision > current.serverRevision) {
      throw new HttpError(409, "conflict", "base_server_revision is ahead of the server", { server_revision: current.serverRevision });
    }
    const merged = mergeProgress(
      {
        slide_index: slideIndexOf(current.slideId),
        position_seconds: current.positionSeconds,
        completed: current.completed,
        server_revision: current.serverRevision,
        client_revision: current.clientRevision,
      },
      incoming,
    );
    if (merged.outcome === "stale_ignored") return { outcome: "stale_ignored", state: toProgressState(current) };
    const incomingWins = merged.next.slide_index === incoming.slide_index && merged.next.position_seconds === incoming.position_seconds;
    const updated = await repo.updateProgress(sql, current.id, current.serverRevision, {
      ...write,
      slideId: incomingWins ? (write.slideId ?? current.slideId) : current.slideId,
      positionSeconds: merged.next.position_seconds,
      completed: merged.next.completed,
      clientRevision: merged.next.client_revision,
    });
    if (!updated) throw new Error("progress row changed while locked");
    return { outcome: merged.outcome, state: toProgressState(updated) };
  }
  throw new HttpError(409, "conflict", "Concurrent progress write; retry");
}

const ListQuery = PageQuery.extend({ learner_id: Uuid });

/** GET /api/v1/progress?learner_id= — paired device, or adult (own household). */
export async function listProgressHandler(req: Request, c: Ctx): Promise<Response> {
  const url = new URL(req.url);
  const parsed = ListQuery.safeParse(Object.fromEntries(url.searchParams));
  const repo = learningRepo();
  const caller: { kind: "device"; claims: DeviceTokenClaims } | { kind: "adult"; adult: AdultIdentity } = hasBearer(req)
    ? { kind: "device", claims: await verifyDeviceBearer(req, c) }
    : { kind: "adult", adult: await requireAdult(req, c) };
  await enforceLearningRateLimit(c, "progressReadByCaller", caller.kind === "device" ? caller.claims.sub : caller.adult.userId);
  if (!parsed.success) throw validationFailed(parsed.error.issues);
  const q = parsed.data;
  if (q.cursor !== undefined && !Uuid.safeParse(q.cursor).success) throw validationFailed([{ path: ["cursor"], code: "invalid_string" }]);

  const read = async (sql: Sql, householdId: string) => {
    await assertLearnerInHousehold(sql, repo, householdId, q.learner_id);
    return repo.listProgress(sql, q.learner_id, q.cursor ?? null, q.limit + 1);
  };
  const rows =
    caller.kind === "device"
      ? await withDevice(c, caller.claims, (sql) => read(sql, caller.claims.hid))
      : await withAdultHousehold(c, caller.adult, (sql, m) => read(sql, m.householdId));
  const page = rows.slice(0, q.limit).filter((r) => r.themeKey !== null);
  const last = rows.length > q.limit ? rows[q.limit - 1] : undefined;
  return json(c, { items: page.map(toProgressState), next_cursor: last ? last.id : null });
}
