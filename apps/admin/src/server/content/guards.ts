import { HttpError, rateLimitKey, type RateLimitPolicy } from "@bnl/auth";
import { z } from "zod";
import type { Sql } from "../db-port";
import type { Ctx } from "../http";
import { canonicalSha256 } from "./canonical";
import { contentRepo } from "./port";

/** Same rule as the OpenAPI IdempotencyKey parameter. */
const IdempotencyKeyHeader = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);

export function requireIdempotencyKey(req: Request): string {
  const parsed = IdempotencyKeyHeader.safeParse(req.headers.get("idempotency-key") ?? "");
  if (!parsed.success) {
    throw new HttpError(422, "validation_failed", "A valid Idempotency-Key header is required", { header: "Idempotency-Key" });
  }
  return parsed.data;
}

export interface IdempotentResult {
  readonly status: number;
  readonly body: unknown;
  readonly replayed: boolean;
}

/**
 * Runs `run` at most once per (scope, actor, key) inside the caller's transaction. The stored row
 * and the effect commit together, so a failed call stores nothing and may be retried; a replay with
 * the same request returns the stored response; a different request under the same key is a 409.
 */
export async function idempotent(
  sql: Sql,
  c: Ctx,
  p: { scope: string; actor: string; key: string; request: unknown },
  run: () => Promise<{ status: number; body: unknown }>,
): Promise<IdempotentResult> {
  const repo = contentRepo();
  const requestSha256 = canonicalSha256(p.request);
  const claim = await repo.claimIdempotency(sql, { scope: p.scope, actor: p.actor, key: p.key, requestSha256, now: c.deps.now() });
  if (claim.kind === "conflict") {
    throw new HttpError(409, "idempotency_conflict", "This Idempotency-Key was already used for a different request");
  }
  if (claim.kind === "replay") return { status: claim.status, body: claim.body, replayed: true };
  const result = await run();
  await repo.completeIdempotency(sql, { scope: p.scope, actor: p.actor, key: p.key, status: result.status, body: result.body });
  return { ...result, replayed: false };
}

/** Publishing actions are rate limited per actor (M12). Keys hold only a hash of the user id. */
const PUBLISH_POLICY: RateLimitPolicy = { limit: 30, windowSeconds: 600 };
const SAVE_POLICY: RateLimitPolicy = { limit: 120, windowSeconds: 600 };

export async function enforceContentRateLimit(c: Ctx, kind: "publish" | "save", userId: string): Promise<void> {
  const policy = kind === "publish" ? PUBLISH_POLICY : SAVE_POLICY;
  const r = await c.deps.rateLimiter.consume(rateLimitKey(`content_${kind}_by_user`, userId), policy);
  if (!r.allowed) {
    throw new HttpError(429, "rate_limited", "Too many requests; try again later", { retry_after_seconds: r.retryAfterSeconds }, {
      "Retry-After": String(r.retryAfterSeconds),
    });
  }
}
