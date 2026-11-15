import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import { DeviceTokenClaims } from "@bnl/contracts";

/** Device access tokens live 15 minutes (spec M01: short-lived credential). */
export const DEVICE_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const DEVICE_TOKEN_ISSUER = "bnl";
export const DEVICE_TOKEN_AUDIENCE = "bnl:device";
const ALG = "HS256";

export type DeviceTokenFailure = "malformed" | "expired" | "invalid_signature" | "invalid_claims" | "revoked";

export class DeviceTokenError extends Error {
  override readonly name = "DeviceTokenError";
  constructor(readonly reason: DeviceTokenFailure) {
    super(`device token rejected: ${reason}`);
  }
}

export interface IssuedAccessToken {
  readonly token: string;
  readonly claims: DeviceTokenClaims;
  readonly expiresAt: Date;
}

export interface DeviceTokenSubject {
  readonly deviceId: string;
  readonly householdId: string;
  /** Current paired_devices.token_version. */
  readonly tokenVersion: number;
}

export async function signDeviceAccessToken(
  key: Uint8Array,
  subject: DeviceTokenSubject,
  now: Date = new Date(),
): Promise<IssuedAccessToken> {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + DEVICE_ACCESS_TOKEN_TTL_SECONDS;
  const claims = DeviceTokenClaims.parse({
    sub: subject.deviceId,
    hid: subject.householdId,
    ver: subject.tokenVersion,
    scope: "device",
    iat,
    exp,
  });
  const token = await new SignJWT({ hid: claims.hid, ver: claims.ver, scope: claims.scope })
    .setProtectedHeader({ alg: ALG, typ: "JWT" })
    .setSubject(claims.sub)
    .setIssuer(DEVICE_TOKEN_ISSUER)
    .setAudience(DEVICE_TOKEN_AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(key);
  return { token, claims, expiresAt: new Date(exp * 1000) };
}

/**
 * Verifies signature (HS256 only), issuer/audience, expiry and claim shape.
 * Does NOT check revocation: callers must also call {@link assertTokenCurrent}
 * with the device row read under the device's DB context.
 */
export async function verifyDeviceAccessToken(
  key: Uint8Array,
  token: string,
  now: Date = new Date(),
): Promise<DeviceTokenClaims> {
  if (typeof token !== "string" || token.length === 0 || token.length > 4096 || token.split(".").length !== 3) {
    throw new DeviceTokenError("malformed");
  }
  let payload: unknown;
  try {
    const result = await jwtVerify(token, key, {
      algorithms: [ALG],
      issuer: DEVICE_TOKEN_ISSUER,
      audience: DEVICE_TOKEN_AUDIENCE,
      typ: "JWT",
      currentDate: now,
      clockTolerance: 0,
      requiredClaims: ["sub", "iat", "exp"],
    });
    payload = result.payload;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) throw new DeviceTokenError("expired");
    if (err instanceof joseErrors.JWSSignatureVerificationFailed) throw new DeviceTokenError("invalid_signature");
    if (err instanceof joseErrors.JOSEError) throw new DeviceTokenError("invalid_claims");
    throw err;
  }
  const parsed = DeviceTokenClaims.safeParse(payload);
  if (!parsed.success) throw new DeviceTokenError("invalid_claims");
  return parsed.data;
}

export interface DeviceRevocationState {
  readonly tokenVersion: number;
  readonly revokedAt: Date | string | null;
}

/** Revocation check: `ver` must equal the current token_version and the device must not be revoked. */
export function assertTokenCurrent(claims: DeviceTokenClaims, state: DeviceRevocationState | null): void {
  if (state === null) throw new DeviceTokenError("revoked");
  if (state.revokedAt !== null) throw new DeviceTokenError("revoked");
  if (state.tokenVersion !== claims.ver) throw new DeviceTokenError("revoked");
}

/** Extracts a bearer token from an Authorization header value; null when absent or not Bearer. */
export function bearerToken(authorization: string | null | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(authorization.trim());
  return match?.[1] ?? null;
}
