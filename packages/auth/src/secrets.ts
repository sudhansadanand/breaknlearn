import { createHmac } from "node:crypto";

/** Minimum length of DEVICE_TOKEN_SIGNING_SECRET, in bytes (UTF-8). */
export const MIN_SECRET_BYTES = 32;

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/**
 * Keys derived from the single server secret (DEVICE_TOKEN_SIGNING_SECRET).
 * Each purpose gets its own HMAC-derived key so a key leak or oracle in one
 * mechanism cannot be replayed against another (domain separation).
 */
export interface ServerKeys {
  /** HS256 key for device access tokens. */
  readonly deviceToken: Uint8Array;
  /** HMAC-SHA256 key for stored pairing-code hashes. */
  readonly pairingCode: Uint8Array;
  /** HMAC-SHA256 key that authenticates refresh-token envelopes. */
  readonly refreshToken: Uint8Array;
  /** HS256 key for DevAuthProvider sessions (local only). */
  readonly devSession: Uint8Array;
}

const PLACEHOLDER = /^replace-with/i;

/**
 * Reads and validates the server secret. Throws at startup (fail closed) when
 * it is missing, a template placeholder, or shorter than 32 bytes.
 */
export function loadServerSecret(env: Readonly<Record<string, string | undefined>>): Uint8Array {
  const raw = env.DEVICE_TOKEN_SIGNING_SECRET;
  if (raw === undefined || raw.trim() === "") {
    throw new ConfigError("DEVICE_TOKEN_SIGNING_SECRET is not set");
  }
  if (PLACEHOLDER.test(raw)) {
    throw new ConfigError("DEVICE_TOKEN_SIGNING_SECRET still holds the .env.example placeholder");
  }
  const bytes = new TextEncoder().encode(raw);
  if (bytes.byteLength < MIN_SECRET_BYTES) {
    throw new ConfigError(`DEVICE_TOKEN_SIGNING_SECRET must be at least ${MIN_SECRET_BYTES} bytes`);
  }
  return bytes;
}

function derive(secret: Uint8Array, label: string): Uint8Array {
  return new Uint8Array(createHmac("sha256", secret).update(`bnl/v1/${label}`).digest());
}

export function deriveServerKeys(secret: Uint8Array): ServerKeys {
  if (secret.byteLength < MIN_SECRET_BYTES) {
    throw new ConfigError(`server secret must be at least ${MIN_SECRET_BYTES} bytes`);
  }
  return {
    deviceToken: derive(secret, "device-access-token"),
    pairingCode: derive(secret, "pairing-code"),
    refreshToken: derive(secret, "refresh-token"),
    devSession: derive(secret, "dev-admin-session"),
  };
}

export function loadServerKeys(env: Readonly<Record<string, string | undefined>>): ServerKeys {
  return deriveServerKeys(loadServerSecret(env));
}
