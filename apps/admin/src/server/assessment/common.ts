/** Shared plumbing for the assessment endpoints: feature flag, rate limits, optional Idempotency-Key. */
import { HttpError, rateLimitKey, type RateLimitPolicy } from "@bnl/auth";
import { IDEMPOTENCY_HEADER, IdempotencyKey } from "@bnl/contracts";
import { canonicalJson } from "@bnl/student-progress";
import type { Sql } from "../db-port";
import { validationFailed, type Ctx } from "../http";
import { sha256Hex } from "../learning/common";
import type { AssessmentRepo } from "./repo";

export type Env = Readonly<Record<string, string | undefined>>;

/** FEATURE_ASSESSMENTS must be exactly "true"; anything else keeps the endpoints off (spec §10.5, M13). */
export function assessmentsEnabled(env: Env = process.env): boolean {
  return env.FEATURE_ASSESSMENTS === "true";
}

export function requireAssessmentsEnabled(): void {
  if (!assessmentsEnabled()) throw new HttpError(503, "feature_disabled", "Assessments are not enabled");
}

/** Per-device fixed windows (SEC-008). A quiz is 3–5 answers; these leave room for retries, not for scraping. */
export const ASSESSMENT_POLICIES = {
  assessmentStartByDevice: { limit: 30, windowSeconds: 60 },
  assessmentAnswerByDevice: { limit: 120, windowSeconds: 60 },
  assessmentFinishByDevice: { limit: 30, windowSeconds: 60 },
  assessmentDueByDevice: { limit: 60, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitPolicy>;

export async function enforceAssessmentRateLimit(c: Ctx, scope: keyof typeof ASSESSMENT_POLICIES, deviceId: string): Promise<void> {
  const r = await c.deps.rateLimiter.consume(rateLimitKey(scope, deviceId), ASSESSMENT_POLICIES[scope]);
  if (!r.allowed) {
    throw new HttpError(429, "rate_limited", "Too many requests; try again later", { retry_after_seconds: r.retryAfterSeconds }, {
      "Retry-After": String(r.retryAfterSeconds),
    });
  }
}

/**
 * Idempotency-Key is OPTIONAL on assessment mutations (they are naturally idempotent: client_attempt_id,
 * one answer per question, finish once). When sent, it must be valid and is honoured like on the learning
 * endpoints (bnl.idempotency_keys, replay header, 409 on a different body).
 */
export function optionalIdempotencyKey(req: Request): string | null {
  const raw = req.headers.get(IDEMPOTENCY_HEADER);
  if (raw === null) return null;
  const parsed = IdempotencyKey.safeParse(raw);
  if (!parsed.success) throw validationFailed([{ path: ["Idempotency-Key"], code: "invalid_string" }], "Idempotency-Key header is invalid");
  return parsed.data;
}

export const REPLAY_HEADER = "Idempotent-Replayed";

export interface Outcome<T> {
  readonly status: number;
  readonly body: T;
  readonly replayed: boolean;
}

/** Runs `fn` once per (scope, device, key) in the caller's transaction; without a key it just runs `fn`. */
export async function maybeIdempotent<T>(
  sql: Sql,
  repo: AssessmentRepo,
  claim: { scope: string; key: string | null; ownerId: string; householdId: string; request: unknown; now: Date },
  fn: () => Promise<Outcome<T>>,
): Promise<Outcome<unknown>> {
  if (claim.key === null) return fn();
  const c = { scope: claim.scope, key: claim.key, ownerId: claim.ownerId, householdId: claim.householdId, requestSha256: sha256Hex(canonicalJson(claim.request)), now: claim.now };
  const state = await repo.claimIdempotency(sql, c);
  if (state.kind === "mismatch") throw new HttpError(409, "idempotency_conflict", "Idempotency-Key was already used for a different request");
  if (state.kind === "replay") return { status: state.status, body: state.body, replayed: true };
  const out = await fn();
  await repo.completeIdempotency(sql, { scope: c.scope, key: c.key, ownerId: c.ownerId, status: out.status, body: out.body });
  return out;
}

/** Maps SQLSTATEs raised by the bnl assessment functions/triggers to the API error contract. */
export function mapDbError(err: unknown): never {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  if (code === "P0002" || code === "42501") throw new HttpError(403, "forbidden", "Attempt is not available");
  if (code === "22023") throw validationFailed([{ path: [], code: "invalid_answer" }], "Answer is not valid for this attempt");
  if (code === "55000") throw new HttpError(409, "conflict", "Attempt is already finished", { reason: "attempt_finished" });
  throw err;
}
