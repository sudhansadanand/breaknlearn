import { HttpError, rateLimitKey, type RateLimitPolicy } from "@bnl/auth";
import type { Ctx } from "./http";

/** Fixed-window policies (SEC-008/009). Keys store only truncated hashes of IPs/emails/user ids. */
export const POLICIES = {
  /** Unauthenticated code creation, per IP. */
  pairingCodeByIp: { limit: 10, windowSeconds: 600 },
  /** TV polling (~every 3–5 s for up to 10 min), per IP. */
  tokenPollByIp: { limit: 120, windowSeconds: 60 },
  refreshByIp: { limit: 30, windowSeconds: 60 },
  /** Guardian code approvals (bounds code guessing), per adult. */
  approveByUser: { limit: 10, windowSeconds: 600 },
  loginByIp: { limit: 10, windowSeconds: 900 },
  loginByEmail: { limit: 5, windowSeconds: 900 },
} as const satisfies Record<string, RateLimitPolicy>;

export async function enforceRateLimit(c: Ctx, scope: keyof typeof POLICIES, identifier: string): Promise<void> {
  const policy = POLICIES[scope];
  const r = await c.deps.rateLimiter.consume(rateLimitKey(scope, identifier), policy);
  if (!r.allowed) {
    throw new HttpError(429, "rate_limited", "Too many requests; try again later", { retry_after_seconds: r.retryAfterSeconds }, {
      "Retry-After": String(r.retryAfterSeconds),
    });
  }
}
