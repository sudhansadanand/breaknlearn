/**
 * SEC-009: login brute-force protection and CSRF/Origin protection for cookie-session mutations.
 * (Plus per-IP limits on the unauthenticated pairing bootstrap, SEC-008 "excessive requests".)
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "@bnl/contracts";
import { setDepsForTesting } from "../src/server/deps";
import { OWNER_A, makeTestEnv, req, type ReqOpts, type TestEnv } from "./fakes";
import { params, routes } from "./routes";

let env: TestEnv;
let owner: string;
beforeEach(() => {
  env = makeTestEnv();
  setDepsForTesting(env.deps);
  owner = env.auth.sessionFor(OWNER_A);
});
afterEach(() => setDepsForTesting(null));

type Mutation = [string, (o: ReqOpts) => Promise<Response>];
const MUTATIONS: Mutation[] = [
  ["pair", (o) => routes.pair.POST(req("POST", "/api/v1/devices/pair", { body: { code: "ABCDEFGH", device_label: "TV" }, ...o }))],
  ["revoke", (o) => routes.revoke.POST(req("POST", "/api/v1/devices/d0000000-0000-4000-8000-000000000001/revoke", o), params({ deviceId: "d0000000-0000-4000-8000-000000000001" }))],
  ["profiles", (o) => routes.profiles.POST(req("POST", "/api/v1/profiles", { body: { id: "f1000000-0000-4000-8000-000000000001", slot: 1, display_name: "A", grade: 2, avatar_id: "fox" }, ...o }))],
  ["consent", (o) => routes.consent.POST(req("POST", "/api/v1/admin/consent", { body: { consent_version: "2026-11", decision: "grant" }, ...o }))],
  ["logout", (o) => routes.logout.POST(req("POST", "/api/v1/auth/logout", o))],
  ["login", (o) => routes.login.POST(req("POST", "/api/v1/auth/login", { body: { email: OWNER_A.email, password: "correct horse battery" }, ...o }))],
];

async function expectCsrfReject(res: Response, reason: string) {
  expect(res.status).toBe(403);
  const body = ApiError.parse(await res.json());
  expect(body.error).toMatchObject({ code: "forbidden", details: { reason } });
}

describe("SEC-009 CSRF / Origin", () => {
  it.each(MUTATIONS)("%s rejects a foreign Origin", async (_n, call) => {
    await expectCsrfReject(await call({ session: owner, origin: "https://evil.example" }), "origin_mismatch");
  });
  it.each(MUTATIONS)("%s rejects a missing Origin and Referer", async (_n, call) => {
    await expectCsrfReject(await call({ session: owner, origin: null }), "origin_missing");
  });
  it.each(MUTATIONS)("%s rejects a missing X-CSRF-Token", async (_n, call) => {
    await expectCsrfReject(await call({ session: owner, csrfHeader: null }), "token_missing");
  });
  it.each(MUTATIONS)("%s rejects a mismatched X-CSRF-Token", async (_n, call) => {
    await expectCsrfReject(await call({ session: owner, csrfHeader: "A".repeat(43) }), "token_mismatch");
  });
  it("a rejected mutation changes nothing", async () => {
    await routes.consent.POST(req("POST", "/api/v1/admin/consent", { session: owner, origin: "https://evil.example", body: { consent_version: "v1", decision: "grant" } }));
    expect(env.store.consent).toHaveLength(0);
    expect(env.store.audit).toHaveLength(0);
  });
  it("accepts same-origin mutations with a matching token", async () => {
    const res = await routes.consent.POST(req("POST", "/api/v1/admin/consent", { session: owner, body: { consent_version: "2026-11", decision: "grant" } }));
    expect(res.status).toBe(200);
    expect(env.store.consent).toHaveLength(1);
    expect(env.store.audit.at(-1)).toMatchObject({ action: "consent.granted", actorAuthId: OWNER_A.userId });
    const revoked = await routes.consent.POST(req("POST", "/api/v1/admin/consent", { session: owner, body: { consent_version: "2026-11", decision: "revoke" } }));
    expect(await revoked.json()).toMatchObject({ decision: "revoke", changed: true });
    expect(env.store.consent[0]!.revokedAt).not.toBeNull();
  });
  it("bearer-authenticated device writes are not subject to cookie CSRF (no ambient credential)", async () => {
    const res = await routes.profiles.POST(req("POST", "/api/v1/profiles", { bearer: "x.y.z", csrf: false, body: {} }));
    expect(res.status).toBe(401); // bad token, but not a CSRF 403
  });
});

describe("SEC-009 login", () => {
  it("sets an httpOnly SameSite=Strict session cookie on success; generic 401 on failure", async () => {
    const ok = await routes.login.POST(req("POST", "/api/v1/auth/login", { body: { email: OWNER_A.email, password: "correct horse battery" } }));
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^bnl_admin_session=/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    const bad = await routes.login.POST(req("POST", "/api/v1/auth/login", { body: { email: OWNER_A.email, password: "nope" } }));
    expect(bad.status).toBe(401);
    const unknown = await routes.login.POST(req("POST", "/api/v1/auth/login", { body: { email: "nobody@bnl.test", password: "nope" } }));
    expect(ApiError.parse(await unknown.json()).error.message).toBe(ApiError.parse(await bad.json()).error.message);
  });

  it("locks an email after 5 attempts per window, even with the right password, from any IP", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await routes.login.POST(req("POST", "/api/v1/auth/login", { ip: `198.51.100.${i}`, body: { email: OWNER_A.email, password: `guess-${i}` } }));
      expect(r.status).toBe(401);
    }
    const locked = await routes.login.POST(req("POST", "/api/v1/auth/login", { ip: "198.51.100.99", body: { email: OWNER_A.email, password: "correct horse battery" } }));
    expect(locked.status).toBe(429);
    expect(ApiError.parse(await locked.json()).error.code).toBe("rate_limited");
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    env.advance(15 * 60 * 1000);
    const later = await routes.login.POST(req("POST", "/api/v1/auth/login", { body: { email: OWNER_A.email, password: "correct horse battery" } }));
    expect(later.status).toBe(200);
  });

  it("limits attempts per IP across many emails", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await routes.login.POST(req("POST", "/api/v1/auth/login", { ip: "192.0.2.1", body: { email: `u${i}@bnl.test`, password: "x" } }));
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe("rate limits on the pairing bootstrap", () => {
  it("pairing-code creation is limited per IP (429 + Retry-After)", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await routes.pairingCode.POST(req("POST", "/api/v1/devices/pairing-code", { csrf: false, ip: "192.0.2.50" }))).status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(10);
    expect(statuses[10]).toBe(429);
    expect(env.store.pairing).toHaveLength(10);
    // Another IP is unaffected.
    expect((await routes.pairingCode.POST(req("POST", "/api/v1/devices/pairing-code", { csrf: false, ip: "192.0.2.51" }))).status).toBe(201);
  });

  it("approval attempts are limited per adult (bounds code guessing)", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await routes.pair.POST(req("POST", "/api/v1/devices/pair", { session: owner, body: { code: "ABCDEFGH", device_label: "TV" } }))).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
