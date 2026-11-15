import { sha256Hex } from "./crypto";

export interface RateLimitPolicy {
  /** Max requests per window. */
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetAt: Date;
  /** Seconds until the window resets (for Retry-After). */
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  /** Counts one hit against `key` and reports whether it is within the policy. */
  consume(key: string, policy: RateLimitPolicy): Promise<RateLimitResult>;
}

export function windowStart(now: Date, windowSeconds: number): Date {
  const ms = windowSeconds * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

function result(count: number, policy: RateLimitPolicy, start: Date, now: Date): RateLimitResult {
  const resetAt = new Date(start.getTime() + policy.windowSeconds * 1000);
  return {
    allowed: count <= policy.limit,
    remaining: Math.max(0, policy.limit - count),
    resetAt,
    retryAfterSeconds: Math.max(1, Math.ceil((resetAt.getTime() - now.getTime()) / 1000)),
  };
}

/** Process-local fixed-window limiter. Tests and single-process dev only. */
export class MemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, number>();
  constructor(private readonly now: () => Date = () => new Date()) {}

  async consume(key: string, policy: RateLimitPolicy): Promise<RateLimitResult> {
    const now = this.now();
    const start = windowStart(now, policy.windowSeconds);
    const bucket = `${key}@${start.getTime()}`;
    const count = (this.buckets.get(bucket) ?? 0) + 1;
    this.buckets.set(bucket, count);
    return result(count, policy, start, now);
  }
}

/** Storage port for the DB-backed limiter (implemented over bnl.rate_limit_buckets by the app). */
export interface FixedWindowStore {
  /** Atomically increments and returns the hit count for (key, windowStart). */
  increment(key: string, windowStart: Date, windowSeconds: number): Promise<number>;
}

/** Shared fixed-window limiter backed by the database; correct across serverless instances. */
export class StoreRateLimiter implements RateLimiter {
  constructor(
    private readonly store: FixedWindowStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async consume(key: string, policy: RateLimitPolicy): Promise<RateLimitResult> {
    const now = this.now();
    const start = windowStart(now, policy.windowSeconds);
    const count = await this.store.increment(key, start, policy.windowSeconds);
    return result(count, policy, start, now);
  }
}

/** Builds a bucket key that never stores raw identifiers (IPs, emails) — only a truncated hash. */
export function rateLimitKey(scope: string, identifier: string): string {
  return `${scope}:${sha256Hex(identifier.toLowerCase()).slice(0, 32)}`;
}
