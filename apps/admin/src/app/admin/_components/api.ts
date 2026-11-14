/**
 * Browser helper for same-origin admin API calls with the double-submit CSRF header.
 * Must stay a `fetch` (mode "cors" for same-origin): under `Referrer-Policy: no-referrer`
 * browsers still send the real `Origin` for such requests, whereas classic <form> POSTs
 * would send `Origin: null` and be rejected by the CSRF check.
 */
export interface ApiResult<T> {
  readonly ok: boolean;
  readonly status: number;
  readonly data: T | null;
  readonly message: string | null;
}

function csrfToken(): string {
  const match = document.cookie.split(";").map((p) => p.trim()).find((p) => p.startsWith("bnl_csrf="));
  return match ? decodeURIComponent(match.slice("bnl_csrf=".length)) : "";
}

export async function apiPost<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", "X-CSRF-Token": csrfToken() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload: unknown = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.ok) return { ok: true, status: res.status, data: payload as T, message: null };
  const message = (payload as { error?: { message?: string } } | null)?.error?.message ?? `Request failed (${res.status})`;
  return { ok: false, status: res.status, data: null, message };
}
