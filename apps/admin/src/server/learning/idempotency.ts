import { HttpError } from "@bnl/auth";
import { canonicalJson } from "@bnl/student-progress";
import type { Sql } from "../db-port";
import { sha256Hex } from "./common";
import type { LearningRepo } from "./repo";

export interface IdempotentResult {
  readonly status: number;
  readonly body: unknown;
  /** True when the stored response of an earlier identical request was returned. */
  readonly replayed: boolean;
}

/** Request fingerprint: sha256 of canonical JSON, so key order does not matter. */
export const requestSha = (body: unknown): string => sha256Hex(canonicalJson(body));

/**
 * Runs `fn` at most once per (scope, owner, key) inside the caller's transaction (ADR-0002 A2).
 * - first use: runs `fn`, stores its 2xx response with the key (commits atomically with the writes);
 * - same key + same request: returns the stored response, `fn` is not run;
 * - same key + different request: 409 idempotency_conflict.
 * Errors thrown by `fn` roll the whole transaction back, so failures are never cached.
 */
export async function idempotent<T>(
  sql: Sql,
  repo: LearningRepo,
  claim: { scope: string; key: string; ownerId: string; householdId: string | null; requestSha256: string; now: Date },
  fn: () => Promise<{ status: number; body: T }>,
): Promise<IdempotentResult> {
  const state = await repo.claimIdempotency(sql, claim);
  if (state.kind === "mismatch") {
    throw new HttpError(409, "idempotency_conflict", "Idempotency-Key was already used for a different request");
  }
  if (state.kind === "replay") return { status: state.status, body: state.body, replayed: true };
  const out = await fn();
  await repo.completeIdempotency(sql, { scope: claim.scope, key: claim.key, ownerId: claim.ownerId, status: out.status, body: out.body });
  return { status: out.status, body: out.body, replayed: false };
}

export const REPLAY_HEADER = "Idempotent-Replayed";
