import { HttpError, REQUEST_ID_HEADER, apiError, newRequestId, redact } from "@bnl/auth";
import type { ZodType, ZodTypeDef } from "zod";
import { getDeps, type AppDeps } from "./deps";

export interface Ctx {
  readonly requestId: string;
  readonly deps: AppDeps;
}

export const NO_STORE = "no-store";
const MAX_JSON_BYTES = 16 * 1024;

/**
 * Route boundary: assigns a request id, resolves deps, converts HttpError to
 * the contract envelope and anything unexpected to a redacted log + 500.
 * Every response carries X-Request-Id and Cache-Control: no-store.
 */
export async function handle(fn: (c: Ctx) => Promise<Response>): Promise<Response> {
  const requestId = newRequestId();
  let deps: AppDeps | null = null;
  try {
    deps = getDeps();
    return await fn({ requestId, deps });
  } catch (err) {
    if (err instanceof HttpError) {
      return apiError(err.code, err.message, err.status, err.details, { requestId, ...(err.headers ? { headers: err.headers } : {}) });
    }
    const entry = { level: "error", request_id: requestId, err: redact(err) };
    if (deps) deps.log(entry);
    else console.error(JSON.stringify(entry));
    return apiError("internal", "Internal error", 500, undefined, { requestId });
  }
}

export function json(c: Ctx, body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": NO_STORE,
      [REQUEST_ID_HEADER]: c.requestId,
      ...headers,
    },
  });
}

export function empty(c: Ctx, status = 204, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { "cache-control": NO_STORE, [REQUEST_ID_HEADER]: c.requestId, ...headers } });
}

/** Validation error details carry paths and codes only — never submitted values. */
export function validationFailed(issues: readonly { path: (string | number)[]; code: string }[], message = "Request body is invalid"): HttpError {
  return new HttpError(422, "validation_failed", message, {
    issues: issues.slice(0, 20).map((i) => ({ path: i.path.join("."), code: i.code })),
  });
}

/** Reads a bounded JSON body and validates it with a contracts schema. */
export async function readJson<T>(req: Request, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
  const type = req.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) throw new HttpError(415, "unsupported_media_type", "Expected application/json");
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_JSON_BYTES) throw new HttpError(413, "payload_too_large", "Request body too large");
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) throw new HttpError(413, "payload_too_large", "Request body too large");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new HttpError(400, "validation_failed", "Malformed JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw validationFailed(parsed.error.issues);
  return parsed.data;
}

/** Client IP as seen by the platform edge (Vercel sets x-forwarded-for / x-real-ip). */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  if (first) return first;
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}
