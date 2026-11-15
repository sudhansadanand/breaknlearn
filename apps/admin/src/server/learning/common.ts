/** Shared request plumbing for the learning endpoints (telemetry, progress, legacy import). */
import { createHash } from "node:crypto";
import { HttpError, rateLimitKey, type RateLimitPolicy } from "@bnl/auth";
import { IDEMPOTENCY_HEADER, IdempotencyKey, Uuid } from "@bnl/contracts";
import { validationFailed, type Ctx } from "../http";

export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export type Env = Readonly<Record<string, string | undefined>>;

/** FEATURE_TELEMETRY must be exactly "true"; anything else (unset, typo) keeps ingestion off. */
export function telemetryEnabled(env: Env = process.env): boolean {
  return env.FEATURE_TELEMETRY === "true";
}

/** Per-device fixed-window limits for the learning endpoints (SEC-008). */
export const LEARNING_POLICIES = {
  /** The client flushes every 25 events / 30 s; 60 batches a minute leaves room for an offline backlog. */
  telemetryByDevice: { limit: 60, windowSeconds: 60 },
  progressSyncByDevice: { limit: 120, windowSeconds: 60 },
  progressReadByCaller: { limit: 120, windowSeconds: 60 },
  legacyImportByDevice: { limit: 10, windowSeconds: 3600 },
} as const satisfies Record<string, RateLimitPolicy>;

export async function enforceLearningRateLimit(c: Ctx, scope: keyof typeof LEARNING_POLICIES, identifier: string): Promise<void> {
  const r = await c.deps.rateLimiter.consume(rateLimitKey(scope, identifier), LEARNING_POLICIES[scope]);
  if (!r.allowed) {
    throw new HttpError(429, "rate_limited", "Too many requests; try again later", { retry_after_seconds: r.retryAfterSeconds }, {
      "Retry-After": String(r.retryAfterSeconds),
    });
  }
}

/** ADR-0002 A2: Idempotency-Key is required on every learning mutation. */
export function requireIdempotencyKey(req: Request): string {
  const raw = req.headers.get(IDEMPOTENCY_HEADER);
  if (raw === null || raw === "") throw validationFailed([{ path: ["Idempotency-Key"], code: "required" }], "Idempotency-Key header is required");
  const parsed = IdempotencyKey.safeParse(raw);
  if (!parsed.success) throw validationFailed([{ path: ["Idempotency-Key"], code: "invalid_string" }], "Idempotency-Key header is invalid");
  return parsed.data;
}

/**
 * Reads a JSON body bounded by `maxBytes` (413 above it, checked on the declared length first and
 * then on the actual bytes). Returns the parsed value; schema validation is the caller's job.
 */
export async function readBoundedJson(req: Request, maxBytes: number): Promise<unknown> {
  const type = req.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) throw new HttpError(415, "unsupported_media_type", "Expected application/json");
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new HttpError(413, "payload_too_large", "Request body too large", { max_bytes: maxBytes });
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new HttpError(413, "payload_too_large", "Request body too large", { max_bytes: maxBytes });
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "validation_failed", "Malformed JSON");
  }
}

export const isUuid = (v: unknown): v is string => Uuid.safeParse(v).success;

export const uniqueUuids = (values: readonly unknown[]): string[] => [...new Set(values.filter(isUuid))];

const iso = (d: Date | string): string => new Date(d).toISOString();
export { iso };
