/**
 * Guardian self-service data rights (A9-PRIV-01, OPS-005):
 *   GET  /api/v1/admin/privacy/export             owner or guardian; attachment JSON, no-store, audited
 *   GET  /api/v1/admin/privacy/deletion-requests  owner or guardian; the household's requests and their status
 *   POST /api/v1/admin/privacy/deletion-requests  owner only; CSRF; explicit confirmation; audited
 * Deletion is executed by scripts/jobs/process-deletion-requests.mjs (bnl_job) at its next nightly run.
 */
import { HttpError, rateLimitKey, type RateLimitPolicy } from "@bnl/auth";
import { Uuid } from "@bnl/contracts";
import { z } from "zod";
import { requireAdult, requireCsrf, withAdultHousehold } from "../authn";
import { NO_STORE, json, readJson, validationFailed, type Ctx } from "../http";
import { CONSENT_VERSION } from "./consent-text";
import { privacyRepo, type DeletionRequestRow } from "./repo";

export const PRIVACY_POLICIES = {
  exportByUser: { limit: 10, windowSeconds: 3600 },
  deletionRequestByUser: { limit: 10, windowSeconds: 3600 },
} as const satisfies Record<string, RateLimitPolicy>;

/** Documented processing target: the next nightly job run, and never later than this. */
export const DELETION_TARGET_DAYS = 7;
/** What the owner must type to confirm a deletion request. */
export const DELETION_CONFIRMATION = "DELETE";
const HOUSEHOLD_TZ = "Asia/Kolkata";

async function limit(c: Ctx, scope: keyof typeof PRIVACY_POLICIES, userId: string): Promise<void> {
  const r = await c.deps.rateLimiter.consume(rateLimitKey(scope, userId), PRIVACY_POLICIES[scope]);
  if (!r.allowed) {
    throw new HttpError(429, "rate_limited", "Too many requests; try again later", { retry_after_seconds: r.retryAfterSeconds }, {
      "Retry-After": String(r.retryAfterSeconds),
    });
  }
}

const localDate = (d: Date): string => new Intl.DateTimeFormat("en-CA", { timeZone: HOUSEHOLD_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

/** Counts only: export rows are never logged or audited. */
function rowCount(tables: Record<string, unknown[]>): number {
  return Object.values(tables).reduce((n, rows) => n + (Array.isArray(rows) ? rows.length : 0), 0);
}

export async function exportHandler(req: Request, c: Ctx): Promise<Response> {
  const adult = await requireAdult(req, c);
  await limit(c, "exportByUser", adult.userId);
  const now = c.deps.now();
  const out = await withAdultHousehold(c, adult, async (sql, m) => {
    const data = await privacyRepo().exportHousehold(sql, m.householdId);
    if (data.household_id !== m.householdId) throw new Error("export: household mismatch");
    await c.deps.repos.audit.insert(sql, {
      actorAuthId: adult.userId,
      householdId: m.householdId,
      action: "privacy.exported",
      targetType: "household",
      targetId: m.householdId,
      metadata: { role: m.role, tables: Object.keys(data.tables).length, rows: rowCount(data.tables) },
    });
    return data;
  });
  const body = {
    format: "breaknlearn-household-export",
    format_version: 1,
    consent_text_version: CONSENT_VERSION,
    household_id: out.household_id,
    generated_at: out.generated_at,
    notes: [
      "Every row the BreakNLearn database holds for your household, one key per table.",
      "Sign-in secrets, device tokens and hashes are never exported; 24-hour replay caches are not included.",
      "Your adult sign-in account (email) is held by the authentication provider, not in these tables.",
      "School documents you uploaded are listed under syllabus_uploads; open them from the School imports page.",
    ],
    tables: out.tables,
  };
  return json(c, body, 200, {
    "content-disposition": `attachment; filename="breaknlearn-export-${localDate(now)}.json"`,
    "cache-control": NO_STORE,
  });
}

const DeletionRequestBody = z
  .object({
    scope: z.enum(["learner", "household", "telemetry_only"]),
    learner_id: Uuid.optional(),
    confirmation: z.string().max(20),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.scope === "learner" && !b.learner_id) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["learner_id"], message: "required" });
    if (b.scope === "household" && b.learner_id) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["learner_id"], message: "not allowed" });
  });

export function toApiDeletionRequest(r: DeletionRequestRow) {
  const target = new Date(r.requestedAt.getTime() + DELETION_TARGET_DAYS * 86_400_000);
  return {
    id: r.id,
    scope: r.scope,
    learner_id: r.learnerId,
    status: r.status,
    requested_at: r.requestedAt.toISOString(),
    complete_by: target.toISOString(),
    completed_at: r.completedAt ? r.completedAt.toISOString() : null,
    // Row counts (and, for a rejected request, the reason); never names.
    result: r.result,
  };
}

export async function createDeletionRequestHandler(req: Request, c: Ctx): Promise<Response> {
  const adult = await requireAdult(req, c);
  requireCsrf(req, c);
  await limit(c, "deletionRequestByUser", adult.userId);
  const body = await readJson(req, DeletionRequestBody);
  if (body.confirmation !== DELETION_CONFIRMATION) {
    throw validationFailed([{ path: ["confirmation"], code: "confirmation_mismatch" }], `Type ${DELETION_CONFIRMATION} to confirm the deletion request`);
  }
  const learnerId = body.learner_id ?? null;
  const row = await withAdultHousehold(c, adult, async (sql, m) => {
    if (m.role !== "owner") throw new HttpError(403, "forbidden", "Only the household owner can request deletion");
    const repo = privacyRepo();
    if (learnerId && !(await repo.learnerInHousehold(sql, m.householdId, learnerId))) throw new HttpError(404, "not_found", "Child profile not found");
    const open = await repo.openDeletionRequest(sql, m.householdId, body.scope, learnerId);
    if (open) throw new HttpError(409, "conflict", "The same deletion request is already waiting to be processed", { deletion_request_id: open.id });
    const created = await repo.insertDeletionRequest(sql, { householdId: m.householdId, requestedBy: adult.userId, scope: body.scope, learnerId });
    await c.deps.repos.audit.insert(sql, {
      actorAuthId: adult.userId,
      householdId: m.householdId,
      action: "privacy.deletion_requested",
      targetType: "data_deletion_request",
      targetId: created.id,
      metadata: { scope: body.scope, learner_id: learnerId, role: m.role },
    });
    return created;
  });
  return json(c, { deletion_request: toApiDeletionRequest(row), processing: `next nightly run, at most ${DELETION_TARGET_DAYS} days` }, 202);
}

export async function listDeletionRequestsHandler(req: Request, c: Ctx): Promise<Response> {
  const adult = await requireAdult(req, c);
  const rows = await withAdultHousehold(c, adult, (sql, m) => privacyRepo().listDeletionRequests(sql, m.householdId));
  return json(c, { items: rows.map(toApiDeletionRequest) });
}
