import { describe, expect, it } from "vitest";
import { ApiError } from "@bnl/contracts";
import {
  HttpError,
  MemoryRateLimiter,
  REDACTED,
  StoreRateLimiter,
  apiError,
  checkCsrf,
  generateCsrfToken,
  rateLimitKey,
  readCookie,
  redact,
  type FixedWindowStore,
} from "../src/index";

const ORIGIN = "http://localhost:3000";
const TOKEN = generateCsrfToken();

describe("CSRF", () => {
  const ok = { method: "POST", origin: ORIGIN, referer: null, cookieToken: TOKEN, headerToken: TOKEN };

  it("accepts a same-origin mutation with matching double-submit token", () => {
    expect(checkCsrf(ok, ORIGIN)).toEqual({ ok: true });
    expect(checkCsrf({ ...ok, origin: null, referer: `${ORIGIN}/admin/devices` }, ORIGIN)).toEqual({ ok: true });
  });

  it("skips safe methods", () => {
    expect(checkCsrf({ ...ok, method: "GET", origin: "https://evil.example", headerToken: null }, ORIGIN).ok).toBe(true);
  });

  it("rejects foreign, null or missing origins", () => {
    expect(checkCsrf({ ...ok, origin: "https://evil.example" }, ORIGIN)).toEqual({ ok: false, reason: "origin_mismatch" });
    expect(checkCsrf({ ...ok, origin: "http://localhost:3000.evil.example" }, ORIGIN).ok).toBe(false);
    expect(checkCsrf({ ...ok, origin: "null" }, ORIGIN).ok).toBe(false);
    expect(checkCsrf({ ...ok, origin: null, referer: "https://evil.example/x" }, ORIGIN).ok).toBe(false);
    expect(checkCsrf({ ...ok, origin: null, referer: null }, ORIGIN)).toEqual({ ok: false, reason: "origin_missing" });
  });

  it("rejects missing or mismatched tokens", () => {
    expect(checkCsrf({ ...ok, headerToken: null }, ORIGIN)).toEqual({ ok: false, reason: "token_missing" });
    expect(checkCsrf({ ...ok, cookieToken: undefined }, ORIGIN)).toEqual({ ok: false, reason: "token_missing" });
    expect(checkCsrf({ ...ok, headerToken: generateCsrfToken() }, ORIGIN)).toEqual({ ok: false, reason: "token_mismatch" });
  });

  it("reads cookies", () => {
    expect(readCookie(`a=1; bnl_csrf=${TOKEN}; b=2`, "bnl_csrf")).toBe(TOKEN);
    expect(readCookie("a=1", "bnl_csrf")).toBeNull();
    expect(readCookie(null, "x")).toBeNull();
  });
});

describe("rate limiting", () => {
  it("memory limiter allows `limit` hits per fixed window then blocks", async () => {
    let now = new Date("2026-11-14T10:00:05Z");
    const rl = new MemoryRateLimiter(() => now);
    const policy = { limit: 3, windowSeconds: 60 };
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await rl.consume("k", policy));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results[3]!.retryAfterSeconds).toBe(55);
    expect((await rl.consume("other", policy)).allowed).toBe(true);
    now = new Date("2026-11-14T10:01:00Z");
    expect((await rl.consume("k", policy)).allowed).toBe(true);
  });

  it("store limiter delegates atomic increments per (key, window)", async () => {
    const seen: string[] = [];
    const counts = new Map<string, number>();
    const store: FixedWindowStore = {
      async increment(key, start) {
        const k = `${key}|${start.toISOString()}`;
        seen.push(k);
        counts.set(k, (counts.get(k) ?? 0) + 1);
        return counts.get(k)!;
      },
    };
    const rl = new StoreRateLimiter(store, () => new Date("2026-11-14T10:00:30Z"));
    expect((await rl.consume("ip:x", { limit: 1, windowSeconds: 60 })).allowed).toBe(true);
    expect((await rl.consume("ip:x", { limit: 1, windowSeconds: 60 })).allowed).toBe(false);
    expect(seen[0]).toBe("ip:x|2026-11-14T10:00:00.000Z");
  });

  it("keys never contain the raw identifier", () => {
    const k = rateLimitKey("login-email", "Parent@Example.test");
    expect(k).toMatch(/^login-email:[0-9a-f]{32}$/);
    expect(k).toBe(rateLimitKey("login-email", "parent@example.test"));
  });
});

describe("apiError", () => {
  it("produces a contract ApiError with request id and no-store", async () => {
    const res = apiError("forbidden", "Not allowed", 403, { field: "id" }, { requestId: "req-1" });
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-request-id")).toBe("req-1");
    const body = await res.json();
    expect(ApiError.parse(body)).toEqual({ error: { code: "forbidden", message: "Not allowed", request_id: "req-1", details: { field: "id" } } });
  });
  it("generates a request id when none is given", async () => {
    const body = (await apiError("internal", "x", 500).json()) as { error: { request_id: string } };
    expect(body.error.request_id.length).toBeGreaterThan(0);
  });
  it("HttpError carries status/code", () => {
    const e = new HttpError(429, "rate_limited", "slow down");
    expect([e.status, e.code]).toEqual([429, "rate_limited"]);
  });
});

describe("redact", () => {
  it("strips display names, answers, tokens and emails", () => {
    const out = redact({
      display_name: "Aadhya",
      displayName: "Aadhya",
      learner: { name: "Ravi", grade: 2 },
      answers: [{ selected_option_id: "b" }],
      refresh_token: "abc",
      accessToken: "x",
      headers: { authorization: "Bearer abc.def", cookie: "bnl_admin_session=x" },
      note: "contact parent@example.test with Bearer eyJabcdefgh.eyJabcdefgh.sigsigsig",
      code: "ABCDEFGH",
      device_id: "d0000000-0000-4000-8000-000000000001",
      err: new Error("failed for parent@example.test"),
    }) as Record<string, unknown>;
    const json = JSON.stringify(out);
    for (const secret of ["Aadhya", "Ravi", "abc.def", "parent@example.test", "eyJabcdefgh", "ABCDEFGH", "bnl_admin_session"]) {
      expect(json).not.toContain(secret);
    }
    expect(out.display_name).toBe(REDACTED);
    expect((out.learner as Record<string, unknown>).grade).toBe(2);
    expect(out.device_id).toBe("d0000000-0000-4000-8000-000000000001");
  });
});
