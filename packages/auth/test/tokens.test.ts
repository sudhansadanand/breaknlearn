import { describe, expect, it } from "vitest";
import { SignJWT, UnsecuredJWT } from "jose";
import {
  ConfigError,
  DEVICE_ACCESS_TOKEN_TTL_SECONDS,
  DeviceTokenError,
  assertTokenCurrent,
  bearerToken,
  decideRefresh,
  deriveServerKeys,
  hashRefreshToken,
  issueRefreshToken,
  loadServerKeys,
  loadServerSecret,
  parseRefreshToken,
  signDeviceAccessToken,
  verifyDeviceAccessToken,
} from "../src/index";

const SECRET = "test-secret-0123456789abcdefghijklmnopqrstuvwxyz";
const keys = deriveServerKeys(new TextEncoder().encode(SECRET));
const HID = "a0000000-0000-4000-8000-000000000001";
const DID = "d0000000-0000-4000-8000-000000000001";
const T0 = new Date("2026-11-14T10:00:00Z");

async function expectReason(p: Promise<unknown>, reason: string) {
  await expect(p).rejects.toBeInstanceOf(DeviceTokenError);
  await expect(p).rejects.toMatchObject({ reason });
}

describe("server secret", () => {
  it("throws at startup when missing, placeholder or short", () => {
    expect(() => loadServerSecret({})).toThrow(ConfigError);
    expect(() => loadServerSecret({ DEVICE_TOKEN_SIGNING_SECRET: "" })).toThrow(ConfigError);
    expect(() => loadServerSecret({ DEVICE_TOKEN_SIGNING_SECRET: "replace-with-32+-random-bytes-base64" })).toThrow(ConfigError);
    expect(() => loadServerSecret({ DEVICE_TOKEN_SIGNING_SECRET: "x".repeat(31) })).toThrow(/at least 32 bytes/);
    expect(loadServerSecret({ DEVICE_TOKEN_SIGNING_SECRET: "x".repeat(32) }).byteLength).toBe(32);
  });
  it("derives distinct per-purpose keys", () => {
    const k = loadServerKeys({ DEVICE_TOKEN_SIGNING_SECRET: SECRET });
    const all = [k.deviceToken, k.pairingCode, k.refreshToken, k.devSession].map((b) => Buffer.from(b).toString("hex"));
    expect(new Set(all).size).toBe(4);
  });
});

describe("device access token", () => {
  const subject = { deviceId: DID, householdId: HID, tokenVersion: 3 };

  it("signs contract claims with a 15-minute TTL and verifies them", async () => {
    const issued = await signDeviceAccessToken(keys.deviceToken, subject, T0);
    expect(DEVICE_ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(issued.expiresAt.toISOString()).toBe("2026-11-14T10:15:00.000Z");
    const claims = await verifyDeviceAccessToken(keys.deviceToken, issued.token, new Date(T0.getTime() + 60_000));
    expect(claims).toMatchObject({ sub: DID, hid: HID, ver: 3, scope: "device" });
    expect(claims.exp - claims.iat).toBe(900);
  });

  it("rejects an expired token", async () => {
    const { token } = await signDeviceAccessToken(keys.deviceToken, subject, T0);
    await expectReason(verifyDeviceAccessToken(keys.deviceToken, token, new Date(T0.getTime() + 900_000)), "expired");
  });

  it("rejects a tampered payload and a wrong key", async () => {
    const { token } = await signDeviceAccessToken(keys.deviceToken, subject, T0);
    const [h, p, s] = token.split(".") as [string, string, string];
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    payload.hid = "b0000000-0000-4000-8000-000000000002";
    const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${s}`;
    await expectReason(verifyDeviceAccessToken(keys.deviceToken, forged, T0), "invalid_signature");
    await expectReason(verifyDeviceAccessToken(keys.pairingCode, token, T0), "invalid_signature");
  });

  it("rejects alg=none and non-HS256 algorithms", async () => {
    const none = new UnsecuredJWT({ hid: HID, ver: 1, scope: "device" })
      .setSubject(DID).setIssuer("bnl").setAudience("bnl:device").setIssuedAt().setExpirationTime("10m").encode();
    await expectReason(verifyDeviceAccessToken(keys.deviceToken, none), "invalid_claims");
    const hs512 = await new SignJWT({ hid: HID, ver: 1, scope: "device" })
      .setProtectedHeader({ alg: "HS512", typ: "JWT" })
      .setSubject(DID).setIssuer("bnl").setAudience("bnl:device").setIssuedAt().setExpirationTime("10m")
      .sign(keys.deviceToken);
    await expectReason(verifyDeviceAccessToken(keys.deviceToken, hs512), "invalid_claims");
  });

  it("rejects wrong scope, wrong audience and malformed tokens", async () => {
    const base = () => new SignJWT({ hid: HID, ver: 1, scope: "admin" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" }).setSubject(DID).setIssuer("bnl").setIssuedAt().setExpirationTime("10m");
    await expectReason(verifyDeviceAccessToken(keys.deviceToken, await base().setAudience("bnl:device").sign(keys.deviceToken)), "invalid_claims");
    const otherAud = await new SignJWT({ hid: HID, ver: 1, scope: "device" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" }).setSubject(DID).setIssuer("bnl").setAudience("authenticated")
      .setIssuedAt().setExpirationTime("10m").sign(keys.deviceToken);
    await expectReason(verifyDeviceAccessToken(keys.deviceToken, otherAud), "invalid_claims");
    await expectReason(verifyDeviceAccessToken(keys.deviceToken, "not-a-jwt"), "malformed");
    await expectReason(verifyDeviceAccessToken(keys.deviceToken, ""), "malformed");
  });

  it("enforces token_version and revocation", async () => {
    const { claims } = await signDeviceAccessToken(keys.deviceToken, subject, T0);
    expect(() => assertTokenCurrent(claims, { tokenVersion: 3, revokedAt: null })).not.toThrow();
    expect(() => assertTokenCurrent(claims, { tokenVersion: 4, revokedAt: null })).toThrow(DeviceTokenError);
    expect(() => assertTokenCurrent(claims, { tokenVersion: 3, revokedAt: new Date() })).toThrow(DeviceTokenError);
    expect(() => assertTokenCurrent(claims, null)).toThrow(DeviceTokenError);
  });

  it("parses bearer headers strictly", () => {
    expect(bearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken("Bearer")).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });
});

describe("refresh tokens", () => {
  it("issues opaque tokens with 32 random bytes and stores only sha256", () => {
    const a = issueRefreshToken(keys.refreshToken, HID, DID);
    const b = issueRefreshToken(keys.refreshToken, HID, DID);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).toBe(hashRefreshToken(a.token));
    const secretPart = a.token.split(".")[2]!;
    expect(Buffer.from(secretPart, "base64url").length).toBe(32);
    expect(a.token.length).toBeGreaterThanOrEqual(32);
    expect(a.token.length).toBeLessThanOrEqual(512);
  });

  it("authenticates the envelope and rejects forgeries without side effects", () => {
    const t = issueRefreshToken(keys.refreshToken, HID, DID);
    expect(parseRefreshToken(keys.refreshToken, t.token)).toEqual({ householdId: HID, deviceId: DID, hash: t.hash });
    const parts = t.token.split(".");
    parts[0] = "b0000000-0000-4000-8000-000000000002"; // move token to another household
    expect(parseRefreshToken(keys.refreshToken, parts.join("."))).toBeNull();
    expect(parseRefreshToken(keys.pairingCode, t.token)).toBeNull();
    expect(parseRefreshToken(keys.refreshToken, "garbage")).toBeNull();
  });

  it("rotates on current hash, detects reuse of a superseded token, refuses revoked devices", () => {
    const first = issueRefreshToken(keys.refreshToken, HID, DID);
    const second = issueRefreshToken(keys.refreshToken, HID, DID);
    expect(decideRefresh(first.hash, { refreshTokenHash: first.hash, revokedAt: null })).toBe("rotate");
    // After rotation the device holds `second`; replaying `first` is reuse.
    expect(decideRefresh(first.hash, { refreshTokenHash: second.hash, revokedAt: null })).toBe("reuse_detected");
    expect(decideRefresh(second.hash, { refreshTokenHash: second.hash, revokedAt: new Date() })).toBe("revoked");
    expect(decideRefresh(second.hash, { refreshTokenHash: null, revokedAt: null })).toBe("revoked");
  });
});
