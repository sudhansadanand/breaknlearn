import { describe, expect, it } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { ConfigError, DEV_SYNTHETIC_USERS, DevAuthProvider, SupabaseJwtProvider, assertDevAuthAllowed, type FetchLike } from "../src/index";

const URL_ = "http://127.0.0.1:54321";
const JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const USER = "5f2b8c1e-3a4d-4e6f-8a9b-0c1d2e3f4a5b";

function supabaseToken(overrides: Record<string, unknown> = {}, exp = "1h") {
  return new SignJWT({ email: "Parent@Example.test", role: "authenticated", ...overrides })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(USER)
    .setIssuer(`${URL_}/auth/v1`)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(JWT_SECRET));
}

describe("SupabaseJwtProvider (HS256 secret)", () => {
  const provider = new SupabaseJwtProvider({ supabaseUrl: URL_, jwtSecret: JWT_SECRET });

  it("returns user id + email for a valid access token", async () => {
    expect(await provider.verifySession(await supabaseToken())).toEqual({ userId: USER, email: "parent@example.test" });
  });

  it("rejects expired, anon-role, wrong-issuer and tampered tokens", async () => {
    expect(await provider.verifySession(await supabaseToken({}, "-1m"))).toBeNull();
    expect(await provider.verifySession(await supabaseToken({ role: "anon" }))).toBeNull();
    const wrongIss = await new SignJWT({ email: "a@b.test", role: "authenticated" })
      .setProtectedHeader({ alg: "HS256" }).setSubject(USER).setIssuer("https://evil.example/auth/v1")
      .setAudience("authenticated").setExpirationTime("1h").sign(new TextEncoder().encode(JWT_SECRET));
    expect(await provider.verifySession(wrongIss)).toBeNull();
    const t = await supabaseToken();
    expect(await provider.verifySession(t.slice(0, -2) + (t.endsWith("AA") ? "BB" : "AA"))).toBeNull();
    expect(await provider.verifySession("")).toBeNull();
  });

  it("refuses a short secret", () => {
    expect(() => new SupabaseJwtProvider({ supabaseUrl: URL_, jwtSecret: "short" })).toThrow(ConfigError);
  });

  it("password sign-in posts to GoTrue and verifies the returned token", async () => {
    const token = await supabaseToken();
    const calls: string[] = [];
    const fetchOk: FetchLike = async (url, init) => {
      calls.push(url);
      expect(init.headers.apikey).toBe("anon");
      return { ok: true, status: 200, json: async () => ({ access_token: token }) };
    };
    const p = new SupabaseJwtProvider({ supabaseUrl: URL_, jwtSecret: JWT_SECRET, anonKey: "anon", fetch: fetchOk });
    const session = await p.signInWithPassword("parent@example.test", "pw");
    expect(session?.identity.userId).toBe(USER);
    expect(calls[0]).toBe(`${URL_}/auth/v1/token?grant_type=password`);

    const fetchBad: FetchLike = async () => ({ ok: false, status: 400, json: async () => ({}) });
    const p2 = new SupabaseJwtProvider({ supabaseUrl: URL_, jwtSecret: JWT_SECRET, anonKey: "anon", fetch: fetchBad });
    expect(await p2.signInWithPassword("parent@example.test", "wrong")).toBeNull();

    const fetchDown: FetchLike = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const p3 = new SupabaseJwtProvider({ supabaseUrl: URL_, jwtSecret: JWT_SECRET, anonKey: "anon", fetch: fetchDown });
    await expect(p3.signInWithPassword("parent@example.test", "pw")).rejects.toThrow(/503/);
  });
});

describe("SupabaseJwtProvider (JWKS)", () => {
  it("verifies asymmetric tokens via the JWKS resolver", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256" };
    const provider = new SupabaseJwtProvider({ supabaseUrl: URL_, jwks: createLocalJWKSet({ keys: [jwk] }) });
    const token = await new SignJWT({ email: "p@example.test", role: "authenticated" })
      .setProtectedHeader({ alg: "ES256", kid: "k1" }).setSubject(USER).setIssuer(`${URL_}/auth/v1`)
      .setAudience("authenticated").setExpirationTime("1h").sign(privateKey);
    expect((await provider.verifySession(token))?.userId).toBe(USER);
    // An HS256 token signed with a guessable secret must not pass in JWKS mode.
    expect(await provider.verifySession(await supabaseToken())).toBeNull();
  });
});

describe("DevAuthProvider", () => {
  const sessionKey = new TextEncoder().encode("dev-session-key-0123456789abcdefghijklmn");
  const devEnv = { NODE_ENV: "development", BNL_DEV_AUTH: "true", BNL_DEV_AUTH_PASSWORD: "local-only-password" };

  it("refuses to construct in production or without the explicit flag", () => {
    expect(() => assertDevAuthAllowed({ ...devEnv, NODE_ENV: "production" })).toThrow(ConfigError);
    expect(() => assertDevAuthAllowed({ ...devEnv, VERCEL_ENV: "production" })).toThrow(ConfigError);
    expect(() => assertDevAuthAllowed({ ...devEnv, BNL_DEV_AUTH: undefined })).toThrow(ConfigError);
    expect(() => assertDevAuthAllowed({ ...devEnv, BNL_DEV_AUTH: "1" })).toThrow(ConfigError);
    expect(() => DevAuthProvider.fromEnv({ ...devEnv, NODE_ENV: "production" }, sessionKey)).toThrow(ConfigError);
    expect(() => new DevAuthProvider({ env: { ...devEnv, VERCEL_ENV: "production" }, sessionKey, users: [] })).toThrow(ConfigError);
  });

  it("has no default password", () => {
    expect(() => DevAuthProvider.fromEnv({ ...devEnv, BNL_DEV_AUTH_PASSWORD: undefined }, sessionKey)).toThrow(/BNL_DEV_AUTH_PASSWORD/);
    expect(() => DevAuthProvider.fromEnv({ ...devEnv, BNL_DEV_AUTH_PASSWORD: "short" }, sessionKey)).toThrow(ConfigError);
  });

  it("signs in seeded synthetic users with scrypt-checked passwords", async () => {
    const p = DevAuthProvider.fromEnv(devEnv, sessionKey);
    const owner = DEV_SYNTHETIC_USERS[0];
    const s = await p.signInWithPassword(owner.email.toUpperCase(), "local-only-password");
    expect(s?.identity).toEqual(owner);
    expect(await p.verifySession(s!.token)).toEqual(owner);
    expect(await p.signInWithPassword(owner.email, "wrong-password-xx")).toBeNull();
    expect(await p.signInWithPassword("nobody@bnl.test", "local-only-password")).toBeNull();
    expect(await p.verifySession("x.y.z")).toBeNull();
  });

  it("dev sessions do not verify under a different key", async () => {
    const a = DevAuthProvider.fromEnv(devEnv, sessionKey);
    const b = DevAuthProvider.fromEnv(devEnv, new TextEncoder().encode("another-dev-key-0123456789abcdefghijklmn"));
    const s = await a.signInWithPassword(DEV_SYNTHETIC_USERS[1].email, "local-only-password");
    expect(await b.verifySession(s!.token)).toBeNull();
  });
});
