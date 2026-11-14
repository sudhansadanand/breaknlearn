import { constantTimeEqual, hmacSha256Base64Url, randomBase64Url, sha256Hex } from "./crypto";

/**
 * Opaque device refresh tokens.
 *
 * Wire format (opaque to clients): `<household_id>.<device_id>.<secret>.<mac>`
 *   - secret: 32 crypto-random bytes, base64url
 *   - mac:    HMAC-SHA256(refreshKey, "<hid>.<did>.<secret>"), base64url
 *
 * Only sha256(token) is stored (paired_devices.refresh_token_hash). The MAC lets
 * the server tell a genuinely issued-but-superseded token (reuse => revoke the
 * device) from a forged one (plain 401, no state change) without storing a
 * history of old hashes, and the embedded ids let the refresh step run under
 * the device's own RLS context instead of a privileged one.
 */
export const REFRESH_SECRET_BYTES = 32;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64URL = /^[A-Za-z0-9_-]+$/;

export interface IssuedRefreshToken {
  readonly token: string;
  /** sha256 hex of the full token; the only value persisted. */
  readonly hash: string;
}

export interface ParsedRefreshToken {
  readonly householdId: string;
  readonly deviceId: string;
  readonly hash: string;
}

export function issueRefreshToken(key: Uint8Array, householdId: string, deviceId: string): IssuedRefreshToken {
  if (!UUID.test(householdId) || !UUID.test(deviceId)) throw new TypeError("household/device id must be UUIDs");
  const body = `${householdId.toLowerCase()}.${deviceId.toLowerCase()}.${randomBase64Url(REFRESH_SECRET_BYTES)}`;
  const token = `${body}.${hmacSha256Base64Url(key, body)}`;
  return { token, hash: sha256Hex(token) };
}

export function hashRefreshToken(token: string): string {
  return sha256Hex(token);
}

/**
 * Authenticates the envelope. Returns null for anything the server did not
 * issue (wrong shape or MAC); such tokens must be rejected with no side effects.
 */
export function parseRefreshToken(key: Uint8Array, token: string): ParsedRefreshToken | null {
  if (typeof token !== "string" || token.length > 512) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [hid, did, secret, mac] = parts as [string, string, string, string];
  if (!UUID.test(hid) || !UUID.test(did) || !B64URL.test(secret) || !B64URL.test(mac)) return null;
  const expected = hmacSha256Base64Url(key, `${hid}.${did}.${secret}`);
  if (!constantTimeEqual(mac, expected)) return null;
  return { householdId: hid.toLowerCase(), deviceId: did.toLowerCase(), hash: sha256Hex(token) };
}

export type RefreshDecision = "rotate" | "reuse_detected" | "revoked";

/**
 * Decides what to do with an authenticated refresh token given the device row.
 * - revoked device (or no current hash)  => "revoked" (401, no state change)
 * - hash matches current                 => "rotate"
 * - authentic but superseded token       => "reuse_detected" (revoke the device)
 */
export function decideRefresh(
  presentedHash: string,
  device: { readonly refreshTokenHash: string | null; readonly revokedAt: Date | string | null },
): RefreshDecision {
  if (device.revokedAt !== null || device.refreshTokenHash === null) return "revoked";
  return constantTimeEqual(presentedHash, device.refreshTokenHash) ? "rotate" : "reuse_detected";
}
