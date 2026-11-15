/**
 * Owner bootstrap follow-up: the forced-password-change flag (Supabase app_metadata.bnl_must_change_password)
 * is parsed into AdultIdentity, the dev provider mirrors it, and the Supabase provider changes the password
 * through the user endpoint and clears the flag through the admin endpoint.
 */
import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import {
  DEV_SYNTHETIC_USERS,
  DevAuthProvider,
  MUST_CHANGE_PASSWORD_CLAIM,
  PasswordChangeRejected,
  SupabaseJwtProvider,
  identityFromClaims,
  passwordPolicyIssues,
  type FetchLike,
} from "../src/index";

const URL_ = "http://127.0.0.1:54321";
const JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const USER = "5f2b8c1e-3a4d-4e6f-8a9b-0c1d2e3f4a5b";

const token = (claims: Record<string, unknown> = {}) =>
  new SignJWT({ email: "owner@example.test", role: "authenticated", ...claims })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(USER)
    .setIssuer(`${URL_}/auth/v1`)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(JWT_SECRET));

describe("identityFromClaims: must-change flag", () => {
  it("is set only by a literal boolean true in app_metadata", () => {
    const base = { sub: USER, email: "a@b.test" };
    expect(identityFromClaims({ ...base, app_metadata: { [MUST_CHANGE_PASSWORD_CLAIM]: true } })?.mustChangePassword).toBe(true);
    for (const v of [false, "true", 1, null, undefined]) {
      expect(identityFromClaims({ ...base, app_metadata: { [MUST_CHANGE_PASSWORD_CLAIM]: v } })).toEqual({ userId: USER, email: "a@b.test" });
    }
    // user_metadata is user-editable and must never set it.
    expect(identityFromClaims({ ...base, user_metadata: { [MUST_CHANGE_PASSWORD_CLAIM]: true } })?.mustChangePassword).toBeUndefined();
    expect(identityFromClaims({ ...base, app_metadata: "x" })?.mustChangePassword).toBeUndefined();
  });

  it("SupabaseJwtProvider surfaces the flag from a verified token", async () => {
    const p = new SupabaseJwtProvider({ supabaseUrl: URL_, jwtSecret: JWT_SECRET });
    expect(await p.verifySession(await token({ app_metadata: { provider: "email", [MUST_CHANGE_PASSWORD_CLAIM]: true } }))).toEqual({
      userId: USER,
      email: "owner@example.test",
      mustChangePassword: true,
    });
    expect((await p.verifySession(await token({ app_metadata: { provider: "email" } })))?.mustChangePassword).toBeUndefined();
  });
});

describe("SupabaseJwtProvider.changePassword", () => {
  type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
  const fake = (statuses: { user?: number; admin?: number } = {}) => {
    const calls: Call[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body) });
      const status = url.includes("/admin/") ? (statuses.admin ?? 200) : (statuses.user ?? 200);
      return { ok: status < 300, status, json: async () => ({}) };
    };
    return { calls, fetch };
  };
  const make = (f: FetchLike, serviceRoleKey = "service-key") =>
    new SupabaseJwtProvider({ supabaseUrl: URL_, jwtSecret: JWT_SECRET, anonKey: "anon", serviceRoleKey, fetch: f });

  it("PUTs the password with the user's token, then clears the flag with the service-role key", async () => {
    const { calls, fetch } = fake();
    await make(fetch).changePassword({ accessToken: "user-access-token", userId: USER, newPassword: "a brand new passphrase" });
    expect(calls).toEqual([
      {
        url: `${URL_}/auth/v1/user`,
        method: "PUT",
        headers: { "content-type": "application/json", apikey: "anon", authorization: "Bearer user-access-token" },
        body: { password: "a brand new passphrase" },
      },
      {
        url: `${URL_}/auth/v1/admin/users/${USER}`,
        method: "PUT",
        headers: { "content-type": "application/json", apikey: "service-key", authorization: "Bearer service-key" },
        body: { app_metadata: { [MUST_CHANGE_PASSWORD_CLAIM]: false } },
      },
    ]);
    // The service-role key never travels with the password, and the admin call never carries one.
    expect(JSON.stringify(calls[1])).not.toContain("passphrase");
  });

  it("does not clear the flag when the password update fails; maps policy refusals to PasswordChangeRejected", async () => {
    const weak = fake({ user: 422 });
    await expect(make(weak.fetch).changePassword({ accessToken: "t", userId: USER, newPassword: "x".repeat(12) })).rejects.toBeInstanceOf(PasswordChangeRejected);
    expect(weak.calls).toHaveLength(1);
    const down = fake({ user: 500 });
    await expect(make(down.fetch).changePassword({ accessToken: "t", userId: USER, newPassword: "x".repeat(12) })).rejects.not.toBeInstanceOf(PasswordChangeRejected);
    const adminDown = fake({ admin: 500 });
    await expect(make(adminDown.fetch).changePassword({ accessToken: "t", userId: USER, newPassword: "x".repeat(12) })).rejects.toThrow(/admin update responded 500/);
  });

  it("refuses without a service-role key or with a non-uuid user id", async () => {
    const { calls, fetch } = fake();
    await expect(make(fetch, "").changePassword({ accessToken: "t", userId: USER, newPassword: "x".repeat(12) })).rejects.toThrow(/SERVICE_ROLE/);
    await expect(make(fetch).changePassword({ accessToken: "t", userId: "../../x", newPassword: "x".repeat(12) })).rejects.toThrow(/invalid user id/);
    expect(calls).toHaveLength(0);
  });
});

describe("DevAuthProvider must-change support", () => {
  const sessionKey = new TextEncoder().encode("dev-session-key-0123456789abcdefghijklmn");
  const devEnv = { NODE_ENV: "development", BNL_DEV_AUTH: "true", BNL_DEV_AUTH_PASSWORD: "local-only-password" };
  const owner = DEV_SYNTHETIC_USERS[0];
  const guardian = DEV_SYNTHETIC_USERS[1];

  it("is off by default; BNL_DEV_AUTH_MUST_CHANGE=true flags every synthetic user, a list flags only those", async () => {
    const off = DevAuthProvider.fromEnv(devEnv, sessionKey);
    expect((await off.signInWithPassword(owner.email, "local-only-password"))?.identity.mustChangePassword).toBeUndefined();
    const all = DevAuthProvider.fromEnv({ ...devEnv, BNL_DEV_AUTH_MUST_CHANGE: "true" }, sessionKey);
    expect((await all.signInWithPassword(guardian.email, "local-only-password"))?.identity.mustChangePassword).toBe(true);
    const some = DevAuthProvider.fromEnv({ ...devEnv, BNL_DEV_AUTH_MUST_CHANGE: ` ${owner.email} ` }, sessionKey);
    expect((await some.signInWithPassword(owner.email, "local-only-password"))?.identity.mustChangePassword).toBe(true);
    expect((await some.signInWithPassword(guardian.email, "local-only-password"))?.identity.mustChangePassword).toBeUndefined();
  });

  it("changePassword replaces the password and clears the flag, also for sessions issued before", async () => {
    const p = DevAuthProvider.fromEnv({ ...devEnv, BNL_DEV_AUTH_MUST_CHANGE: "true" }, sessionKey);
    const s = (await p.signInWithPassword(owner.email, "local-only-password"))!;
    expect(await p.verifySession(s.token)).toEqual({ ...owner, mustChangePassword: true });
    await p.changePassword({ accessToken: s.token, userId: owner.userId, newPassword: "my own new passphrase" });
    expect(await p.verifySession(s.token)).toEqual(owner);
    expect(await p.signInWithPassword(owner.email, "local-only-password")).toBeNull();
    expect((await p.signInWithPassword(owner.email, "my own new passphrase"))?.identity).toEqual(owner);
  });

  it("changePassword refuses a session for another user, a bad token and a short password", async () => {
    const p = DevAuthProvider.fromEnv(devEnv, sessionKey);
    const s = (await p.signInWithPassword(guardian.email, "local-only-password"))!;
    await expect(p.changePassword({ accessToken: s.token, userId: owner.userId, newPassword: "long enough password" })).rejects.toThrow();
    await expect(p.changePassword({ accessToken: "x.y.z", userId: guardian.userId, newPassword: "long enough password" })).rejects.toThrow();
    await expect(p.changePassword({ accessToken: s.token, userId: guardian.userId, newPassword: "short" })).rejects.toThrow();
    expect(await p.signInWithPassword(guardian.email, "local-only-password")).not.toBeNull();
  });
});

describe("passwordPolicyIssues", () => {
  it("enforces length bounds and rejects the email local part, case-insensitively", () => {
    expect(passwordPolicyIssues("correct horse battery", "owner@example.test")).toEqual([]);
    expect(passwordPolicyIssues("short", "owner@example.test")).toEqual(["too_short"]);
    expect(passwordPolicyIssues("x".repeat(129), "owner@example.test")).toEqual(["too_long"]);
    expect(passwordPolicyIssues("MyOWNERpassword!", "owner@example.test")).toEqual(["contains_email"]);
    // Very short local parts are not treated as a rule (they would match too much).
    expect(passwordPolicyIssues("ab-correct-horse", "ab@example.test")).toEqual([]);
  });
});
