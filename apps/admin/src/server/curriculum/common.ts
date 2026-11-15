import { HttpError, rateLimitKey, type RateLimitPolicy } from "@bnl/auth";
import type { ZodType, ZodTypeDef } from "zod";
import { z } from "zod";
import { validationFailed, type Ctx } from "../http";

/** Fixed-window policies for this feature (SEC-008: excessive requests). */
export const CURRICULUM_POLICIES = {
  /** Syllabus imports, per adult. */
  importByUser: { limit: 20, windowSeconds: 3600 },
  /** Mapping review submissions, per adult. */
  mappingReviewByUser: { limit: 120, windowSeconds: 600 },
  /** Curriculum review actions, per staff user. */
  curriculumReviewByUser: { limit: 120, windowSeconds: 600 },
} as const satisfies Record<string, RateLimitPolicy>;

export async function enforceCurriculumRateLimit(c: Ctx, scope: keyof typeof CURRICULUM_POLICIES, identifier: string): Promise<void> {
  const r = await c.deps.rateLimiter.consume(rateLimitKey(`curriculum.${scope}`, identifier), CURRICULUM_POLICIES[scope]);
  if (!r.allowed) {
    throw new HttpError(429, "rate_limited", "Too many requests; try again later", { retry_after_seconds: r.retryAfterSeconds }, {
      "Retry-After": String(r.retryAfterSeconds),
    });
  }
}

const UUID = z.string().uuid();

/** Path ids must be UUIDs; anything else is a plain 404 (no oracle, no echo). */
export function pathUuid(value: string): string {
  const r = UUID.safeParse(value);
  if (!r.success) throw new HttpError(404, "not_found", "Not found");
  return r.data.toLowerCase();
}

export const payloadTooLarge = () => new HttpError(413, "payload_too_large", "Request body too large");

/** Reads at most `max` bytes of the body; 413 as soon as the declared or streamed size exceeds it. */
export async function readBodyBounded(req: Request, max: number): Promise<Uint8Array> {
  const declared = req.headers.get("content-length");
  if (declared !== null && /^[0-9]+$/.test(declared) && Number(declared) > max) throw payloadTooLarge();
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw payloadTooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const ch of chunks) {
    out.set(ch, o);
    o += ch.byteLength;
  }
  return out;
}

/** Bounded JSON body validated with a Zod schema (for bodies larger than the shared 16 KB reader allows). */
export async function readJsonBounded<T>(req: Request, schema: ZodType<T, ZodTypeDef, unknown>, max: number): Promise<T> {
  const type = req.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) throw new HttpError(415, "unsupported_media_type", "Expected application/json");
  const bytes = await readBodyBounded(req, max);
  return parseJsonBytes(bytes, schema);
}

export function parseJsonBytes<T>(bytes: Uint8Array, schema: ZodType<T, ZodTypeDef, unknown>): T {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (err) {
    if (err instanceof SyntaxError || err instanceof TypeError) throw new HttpError(400, "validation_failed", "Malformed JSON");
    throw err;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw validationFailed(parsed.error.issues);
  return parsed.data;
}

/** SQLSTATE of a postgres error, or null. */
export function pgCode(err: unknown): string | null {
  if (err instanceof Error && "code" in err && typeof (err as { code: unknown }).code === "string") {
    const code = (err as { code: string }).code;
    return /^[0-9A-Z]{5}$/.test(code) ? code : null;
  }
  return null;
}

/** Maps the DB SQLSTATE contract (supabase/README.md) to API errors; anything else is rethrown. */
export function mapDbError(err: unknown): never {
  switch (pgCode(err)) {
    case "42501":
      throw new HttpError(403, "forbidden", "Not allowed");
    case "P0002":
      throw new HttpError(404, "not_found", "Not found");
    case "22023":
    case "23514":
      throw new HttpError(422, "validation_failed", "The change is not valid");
    case "55000":
      throw new HttpError(409, "conflict", "The record cannot be changed in its current state");
    case "23505":
      throw new HttpError(409, "conflict", "A conflicting record already exists");
    case "23503":
      throw new HttpError(404, "not_found", "A referenced record was not found");
    default:
      throw err;
  }
}

/** Runs one DB call and maps contract SQLSTATEs to HttpErrors. */
export async function db<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    return mapDbError(err);
  }
}

/** Plain-text field: trimmed, no markup, no control characters. */
export const PlainText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    // eslint-disable-next-line no-control-regex
    .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), { message: "control characters are not allowed" })
    .refine((s) => !/<\s*[a-zA-Z!/?]|javascript\s*:/i.test(s), { message: "markup is not allowed" });
