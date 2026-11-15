/**
 * Owner bootstrap: an account flagged with a one-time password (app_metadata.bnl_must_change_password) can only
 * reach GET /api/v1/admin/me, POST /api/v1/auth/password and POST /api/v1/auth/logout; every other adult API is
 * 403 forbidden/password_change_required, and portal pages redirect to /admin/change-password. Unauthenticated
 * stays 401 (SEC-001). POST /api/v1/auth/password: CSRF, rate limits, policy, generic refusals, cookie rotation.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PasswordChangeRejected, type AdultIdentity } from "@bnl/auth";
import { ApiError } from "@bnl/contracts";
import * as password from "../src/app/api/v1/auth/password/route";
import { setDepsForTesting } from "../src/server/deps";
import { OWNER_A, makeTestEnv, req, type ReqOpts, type TestEnv } from "./fakes";
import { params, routes } from "./routes";

const appDir = fileURLToPath(new URL("../src/app", import.meta.url));
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));

const ONE_TIME = "Xq7-one-time-PW-2026-abc";
const NEW_PW = "a long passphrase of my own";
const FLAGGED: AdultIdentity = { ...OWNER_A, mustChangePassword: true };

let env: TestEnv;
let flagged: string;
let logs: string[];
beforeEach(() => {
  env = makeTestEnv();
  logs = [];
  env.deps = { ...env.deps, log: (e) => logs.push(JSON.stringify(e)) };
  setDepsForTesting(env.deps);
  env.auth.passwords.set(OWNER_A.email, { password: ONE_TIME, identity: FLAGGED });
  flagged = env.auth.sessionFor(FLAGGED);
});
afterEach(() => setDepsForTesting(null));

type AnyHandler = (r: Request, ctx: ReturnType<typeof params>) => Promise<Response>;
const DEVICE = "d0000000-0000-4000-8000-000000000001";

async function expectPasswordChangeRequired(res: Response, label: string) {
  expect(res.status, label).toBe(403);
  expect(res.headers.get("cache-control"), label).toBe("no-store");
  const body = ApiError.parse(await res.json());
  expect(body.error, label).toMatchObject({ code: "forbidden", details: { reason: "password_change_required" } });
}

const changePw = (body: unknown, o: ReqOpts = {}) => password.POST(req("POST", "/api/v1/auth/password", { session: flagged, body, ...o }));

describe("gating while the one-time password is pending", () => {
  const adminRouteFiles = walk(join(appDir, "api/v1/admin"))
    .filter((f) => f.endsWith("route.ts"))
    .map((f) => relative(appDir, f))
    .filter((f) => f !== "api/v1/admin/me/route.ts")
    .sort();
  const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
  const ANY_PARAMS = {
    rest: ["lessons"], nodeId: "a0000000-0000-4000-8000-000000000001", jobId: "a0000000-0000-4000-8000-000000000002",
    lessonId: "a0000000-0000-4000-8000-000000000003", versionId: "a0000000-0000-4000-8000-000000000004", revision: "1", id: "a0000000-0000-4000-8000-000000000005",
  };

  it.each(adminRouteFiles)("%s: every method with a flagged session → 403 password_change_required", async (file) => {
    const mod = (await import(join(appDir, file))) as Partial<Record<(typeof METHODS)[number], AnyHandler>>;
    for (const m of METHODS.filter((x) => typeof mod[x] === "function")) {
      const res = await mod[m]!(req(m, `/${file.replace(/\/route\.ts$/, "")}`, { session: flagged, body: m === "GET" ? undefined : {}, csrf: true }), params(ANY_PARAMS));
      await expectPasswordChangeRequired(res, `${m} ${file}`);
    }
    expect(env.store.audit).toHaveLength(0);
  });

  it.each<[string, () => Promise<Response>]>([
    ["GET /api/v1/devices", () => routes.devices.GET(req("GET", "/api/v1/devices", { session: flagged }))],
    ["POST /api/v1/devices/pair", () => routes.pair.POST(req("POST", "/api/v1/devices/pair", { session: flagged, body: { code: "ABCDEFGH", device_label: "TV" } }))],
    ["POST revoke", () => routes.revoke.POST(req("POST", `/api/v1/devices/${DEVICE}/revoke`, { session: flagged }), params({ deviceId: DEVICE }))],
    ["GET /api/v1/profiles", () => routes.profiles.GET(req("GET", "/api/v1/profiles", { session: flagged }))],
    ["POST /api/v1/profiles", () => routes.profiles.POST(req("POST", "/api/v1/profiles", { session: flagged, body: {} }))],
    ["POST /api/v1/admin/consent", () => routes.consent.POST(req("POST", "/api/v1/admin/consent", { session: flagged, body: { consent_version: "2026-11", decision: "grant" } }))],
    // Path tricks do not reach the allow-list: only the exact GET /api/v1/admin/me is exempt.
    ["GET with a trailing slash on another path", () => routes.devices.GET(req("GET", "/api/v1/devices/", { session: flagged }))],
    ["POST to the me path (only GET is exempt)", () => routes.consent.POST(req("POST", "/api/v1/admin/me", { session: flagged, body: { consent_version: "2026-11", decision: "grant" } }))],
  ])("%s → 403", async (label, call) => {
    await expectPasswordChangeRequired(await call(), label);
  });

  it("unauthenticated stays 401, never 403 (SEC-001)", async () => {
    const res = await routes.devices.GET(req("GET", "/api/v1/devices"));
    expect(res.status).toBe(401);
    expect((await password.POST(req("POST", "/api/v1/auth/password", { body: { current_password: "x", new_password: NEW_PW } }))).status).toBe(401);
    expect((await password.POST(req("POST", "/api/v1/auth/password", { session: "forged", body: { current_password: "x", new_password: NEW_PW } }))).status).toBe(401);
  });

  it("GET /api/v1/admin/me still answers, with must_change_password: true; logout still works", async () => {
    const me = await routes.me.GET(req("GET", "/api/v1/admin/me", { session: flagged }));
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ user_id: OWNER_A.userId, must_change_password: true, households: [{ role: "owner" }] });
    const plain = await routes.me.GET(req("GET", "/api/v1/admin/me", { session: env.auth.sessionFor(OWNER_A) }));
    expect(await plain.json()).not.toHaveProperty("must_change_password");
    const out = await routes.logout.POST(req("POST", "/api/v1/auth/logout", { session: flagged }));
    expect(out.status).toBe(204);
  });

  it("login tells the client to go to the change-password page", async () => {
    const res = await routes.login.POST(req("POST", "/api/v1/auth/login", { body: { email: OWNER_A.email, password: ONE_TIME } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: OWNER_A.userId, must_change_password: true });
  });
});

describe("pages while the one-time password is pending", () => {
  it("portal pages redirect to /admin/change-password; the change-password page itself is reachable", async () => {
    let cookie: string | undefined;
    vi.doMock("next/headers", () => ({ cookies: async () => ({ get: () => (cookie === undefined ? undefined : { value: cookie }) }) }));
    vi.doMock("next/navigation", () => ({
      redirect: (to: string) => {
        throw new Error(`REDIRECT:${to}`);
      },
    }));
    vi.resetModules();
    const { setDepsForTesting: setDeps } = await import("../src/server/deps");
    setDeps(env.deps);
    const { requireAdultPage } = await import("../src/server/page-auth");
    cookie = flagged;
    await expect(requireAdultPage()).rejects.toThrow("REDIRECT:/admin/change-password");
    await expect(requireAdultPage({ allowPendingPasswordChange: true })).resolves.toEqual(FLAGGED);
    cookie = undefined;
    await expect(requireAdultPage({ allowPendingPasswordChange: true })).rejects.toThrow("REDIRECT:/admin/login");
    cookie = "forged";
    await expect(requireAdultPage({ allowPendingPasswordChange: true })).rejects.toThrow("REDIRECT:/admin/login");
    cookie = env.auth.sessionFor(OWNER_A);
    await expect(requireAdultPage()).resolves.toEqual(OWNER_A);
    setDeps(null);
    vi.doUnmock("next/headers");
    vi.doUnmock("next/navigation");
  });
});

describe("POST /api/v1/auth/password", () => {
  it("changes the password, clears the flag, rotates the cookie and audits without the password", async () => {
    const res = await changePw({ current_password: ONE_TIME, new_password: NEW_PW });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: OWNER_A.userId, must_change_password: false });
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^bnl_admin_session=sess-[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+/);
    const rotated = decodeURIComponent(/^bnl_admin_session=([^;]+)/.exec(setCookie)![1]!);
    expect(rotated).not.toBe(flagged);
    // The provider was called with the fresh token from re-verifying the current password, not the cookie.
    expect(env.auth.passwordChanges).toEqual([{ userId: OWNER_A.userId, accessToken: expect.not.stringMatching(flagged) }]);
    expect(await env.auth.verifySession(rotated)).toEqual(OWNER_A);

    // The new session works everywhere; the old password no longer signs in; the new one does, unflagged.
    expect((await routes.devices.GET(req("GET", "/api/v1/devices", { session: rotated }))).status).toBe(200);
    expect(await env.auth.signInWithPassword(OWNER_A.email, ONE_TIME)).toBeNull();
    expect((await env.auth.signInWithPassword(OWNER_A.email, NEW_PW))?.identity.mustChangePassword).toBeUndefined();

    expect(env.store.audit).toEqual([
      { actorAuthId: OWNER_A.userId, householdId: expect.any(String), action: "auth.password_changed", targetType: "auth_user", targetId: OWNER_A.userId, metadata: { forced: true } },
    ]);
    const everything = JSON.stringify([env.store.audit, logs]);
    expect(everything).not.toContain(NEW_PW);
    expect(everything).not.toContain(ONE_TIME);
  });

  it("works for an unflagged adult too (voluntary change)", async () => {
    env.auth.passwords.set(OWNER_A.email, { password: ONE_TIME, identity: OWNER_A });
    const res = await changePw({ current_password: ONE_TIME, new_password: NEW_PW }, { session: env.auth.sessionFor(OWNER_A) });
    expect(res.status).toBe(200);
    expect(env.store.audit[0]?.metadata).toEqual({ forced: false });
  });

  it("wrong current password and new == current get the same generic refusal; nothing changes", async () => {
    const wrong = await changePw({ current_password: "not-the-password", new_password: NEW_PW });
    const same = await changePw({ current_password: ONE_TIME, new_password: ONE_TIME });
    expect(wrong.status).toBe(422);
    expect(same.status).toBe(422);
    const [a, b] = [ApiError.parse(await wrong.json()).error, ApiError.parse(await same.json()).error];
    expect(a.message).toBe(b.message);
    expect(a.details).toBeUndefined();
    expect(b.details).toBeUndefined();
    expect(wrong.headers.get("set-cookie")).toBeNull();
    expect(env.auth.passwordChanges).toHaveLength(0);
    expect(env.store.audit).toHaveLength(0);
  });

  it.each<[string, string]>([
    ["too_short", "short-pw"],
    ["contains_email", "my-OWNER-passphrase-2026"],
    ["too_long", "x".repeat(129)],
  ])("rejects a weak new password (%s) before verifying the current one", async (code, pw) => {
    const res = await changePw({ current_password: ONE_TIME, new_password: pw });
    expect(res.status).toBe(422);
    const body = ApiError.parse(await res.json());
    expect(body.error.details).toEqual({ issues: [{ path: "new_password", code }] });
    expect(JSON.stringify(body)).not.toContain(pw);
    expect(env.auth.passwordChanges).toHaveLength(0);
  });

  it("maps a refusal from the auth server's own policy to 422 without changing the cookie", async () => {
    env.auth.changePassword = async () => {
      throw new PasswordChangeRejected(422);
    };
    const res = await changePw({ current_password: ONE_TIME, new_password: NEW_PW });
    expect(res.status).toBe(422);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("CSRF: foreign Origin, missing Origin and missing token are rejected before any password check", async () => {
    const spy = vi.spyOn(env.auth, "signInWithPassword");
    const body = { current_password: ONE_TIME, new_password: NEW_PW };
    for (const [o, reason] of [
      [{ origin: "https://evil.example" }, "origin_mismatch"],
      [{ origin: null }, "origin_missing"],
      [{ csrfHeader: null }, "token_missing"],
    ] as const) {
      const res = await changePw(body, o);
      expect(res.status).toBe(403);
      expect(ApiError.parse(await res.json()).error).toMatchObject({ code: "forbidden", details: { reason } });
    }
    const noCsrf = await changePw(body, { csrf: false });
    expect(noCsrf.status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
    expect(env.auth.passwordChanges).toHaveLength(0);
  });

  it("is rate-limited per user (5 per 15 minutes) and per IP", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await changePw({ current_password: `guess-${i}`, new_password: NEW_PW }, { ip: `198.51.100.${i}` })).status).toBe(422);
    }
    const locked = await changePw({ current_password: ONE_TIME, new_password: NEW_PW }, { ip: "198.51.100.77" });
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(env.auth.passwordChanges).toHaveLength(0);
    env.advance(15 * 60 * 1000);
    expect((await changePw({ current_password: ONE_TIME, new_password: NEW_PW })).status).toBe(200);

    // Per IP: 10 requests (any session, even forged) then 429.
    for (let i = 0; i < 10; i++) await changePw({ current_password: "x", new_password: NEW_PW }, { ip: "192.0.2.50", session: "forged" });
    expect((await changePw({ current_password: "x", new_password: NEW_PW }, { ip: "192.0.2.50" })).status).toBe(429);
  });

  it("rejects non-JSON and malformed bodies", async () => {
    expect((await password.POST(req("POST", "/api/v1/auth/password", { session: flagged, rawBody: "a=b", contentType: "application/x-www-form-urlencoded" }))).status).toBe(415);
    expect((await changePw({ current_password: ONE_TIME })).status).toBe(422);
  });
});
