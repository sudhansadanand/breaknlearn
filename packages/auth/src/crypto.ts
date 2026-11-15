import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function randomBase64Url(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hmacSha256Hex(key: Uint8Array, value: string): string {
  return createHmac("sha256", key).update(value, "utf8").digest("hex");
}

export function hmacSha256Base64Url(key: Uint8Array, value: string): string {
  return createHmac("sha256", key).update(value, "utf8").digest("base64url");
}

/**
 * Constant-time string comparison. Length differences return false without
 * short-circuiting on content (lengths of hashes/tokens are not secret).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Still burn a comparison so timing does not depend on where content differs.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
