import { z } from "zod";

/** All ids are UUIDs; never derived from display names. */
export const Uuid = z.string().uuid();
export type Uuid = z.infer<typeof Uuid>;

/** Server timestamps are ISO-8601 UTC. */
export const IsoDateTime = z.string().datetime({ offset: true });

export const Grade = z.union([z.literal(2), z.literal(6)]);
export type Grade = z.infer<typeof Grade>;

export const ErrorCode = z.enum([
  "unauthorized",
  "forbidden",
  "not_found",
  "validation_failed",
  "conflict",
  "rate_limited",
  "payload_too_large",
  "unsupported_media_type",
  "idempotency_conflict",
  "feature_disabled",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** Every API failure uses this envelope and never includes PII. */
export const ApiError = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string().max(300),
    request_id: z.string().min(1),
    details: z.record(z.unknown()).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

export const PageQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const IdempotencyKey = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
