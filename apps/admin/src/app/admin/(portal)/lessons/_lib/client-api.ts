/**
 * Same-origin JSON calls for the lessons UI: double-submit CSRF header, and an Idempotency-Key
 * for publishing actions (generated once per click, so a retried click is a new intent).
 */
export interface Result<T> {
  readonly ok: boolean;
  readonly status: number;
  readonly data: T | null;
  readonly message: string | null;
  readonly details: Record<string, unknown> | null;
}

function csrfToken(): string {
  const match = document.cookie.split(";").map((p) => p.trim()).find((p) => p.startsWith("bnl_csrf="));
  return match ? decodeURIComponent(match.slice("bnl_csrf=".length)) : "";
}

export async function call<T>(method: "GET" | "POST", path: string, body?: unknown, opts: { idempotent?: boolean } = {}): Promise<Result<T>> {
  const headers: Record<string, string> = { "X-CSRF-Token": csrfToken() };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (opts.idempotent) headers["Idempotency-Key"] = `ui-${crypto.randomUUID()}`;
  const res = await fetch(path, { method, credentials: "same-origin", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const payload: unknown = await res.json().catch(() => null);
  if (res.ok) return { ok: true, status: res.status, data: payload as T, message: null, details: null };
  const err = (payload as { error?: { message?: string; details?: Record<string, unknown> } } | null)?.error;
  return { ok: false, status: res.status, data: null, message: err?.message ?? `Request failed (${res.status})`, details: err?.details ?? null };
}

export function errorList(details: Record<string, unknown> | null): { path: string; message: string }[] {
  const v = details?.validation_errors;
  return Array.isArray(v) ? (v as { path: string; message: string }[]) : [];
}
