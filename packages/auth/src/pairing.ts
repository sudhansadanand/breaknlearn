import { randomBytes } from "node:crypto";
import { PAIRING_CODE_ALPHABET, PAIRING_CODE_TTL_SECONDS, PairingCode } from "@bnl/contracts";
import { constantTimeEqual, hmacSha256Hex, randomBase64Url, sha256Hex } from "./crypto";

export const PAIRING_CODE_LENGTH = 8;
/** After this many failed attempts against one code it is permanently unusable. */
export const MAX_PAIRING_FAILED_ATTEMPTS = 5;
/** 32 random bytes => 43 base64url chars (contract: 32..128). */
export const POLL_SECRET_BYTES = 32;

/** Crypto-random code over the contract alphabet, unbiased via rejection sampling. */
export function generatePairingCode(): string {
  const n = PAIRING_CODE_ALPHABET.length;
  const limit = 256 - (256 % n); // largest multiple of n below 256
  let out = "";
  while (out.length < PAIRING_CODE_LENGTH) {
    for (const byte of randomBytes(PAIRING_CODE_LENGTH * 2)) {
      if (byte >= limit) continue;
      out += PAIRING_CODE_ALPHABET[byte % n];
      if (out.length === PAIRING_CODE_LENGTH) break;
    }
  }
  return out;
}

/**
 * Normalises what a guardian typed (case, spaces, hyphens) and validates it
 * against the contract. Returns null when it cannot be a valid code.
 */
export function normalizePairingCode(input: string): string | null {
  if (typeof input !== "string" || input.length > 32) return null;
  const cleaned = input.replace(/[\s-]/g, "").toUpperCase();
  return PairingCode.safeParse(cleaned).success ? cleaned : null;
}

/** Keyed hash stored in device_pairing_codes.code_hash (the code itself is never stored). */
export function hashPairingCode(key: Uint8Array, code: string): string {
  return hmacSha256Hex(key, code);
}

export function generatePollSecret(): string {
  return randomBase64Url(POLL_SECRET_BYTES);
}

export function hashPollSecret(secret: string): string {
  return sha256Hex(secret);
}

export function verifyPollSecret(secret: string, storedHash: string): boolean {
  return constantTimeEqual(hashPollSecret(secret), storedHash);
}

export function pairingExpiry(now: Date): Date {
  return new Date(now.getTime() + PAIRING_CODE_TTL_SECONDS * 1000);
}

export interface PairingCodeRowState {
  readonly expiresAt: Date | string;
  readonly approvedAt: Date | string | null;
  readonly redeemedAt: Date | string | null;
  readonly failedAttempts: number;
}

export type PairingState = "pending" | "approved" | "redeemed" | "expired" | "locked";

/** Single place that turns a pairing row into its lifecycle state. */
export function pairingState(row: PairingCodeRowState, now: Date): PairingState {
  if (row.redeemedAt !== null) return "redeemed";
  if (row.failedAttempts >= MAX_PAIRING_FAILED_ATTEMPTS) return "locked";
  if (new Date(row.expiresAt).getTime() <= now.getTime()) return "expired";
  return row.approvedAt === null ? "pending" : "approved";
}

export interface NewPairingCode {
  readonly pairingId: string;
  readonly code: string;
  readonly codeHash: string;
  readonly pollSecret: string;
  readonly pollSecretHash: string;
  readonly expiresAt: Date;
}

export function createPairingCode(key: Uint8Array, now: Date, uuid: () => string): NewPairingCode {
  const code = generatePairingCode();
  const pollSecret = generatePollSecret();
  return {
    pairingId: uuid(),
    code,
    codeHash: hashPairingCode(key, code),
    pollSecret,
    pollSecretHash: hashPollSecret(pollSecret),
    expiresAt: pairingExpiry(now),
  };
}
