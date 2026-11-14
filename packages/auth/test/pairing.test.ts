import { describe, expect, it } from "vitest";
import { PAIRING_CODE_ALPHABET, PAIRING_CODE_TTL_SECONDS, PairingCode, PairingCodeResponse } from "@bnl/contracts";
import {
  MAX_PAIRING_FAILED_ATTEMPTS,
  createPairingCode,
  deriveServerKeys,
  generatePairingCode,
  generatePollSecret,
  hashPairingCode,
  normalizePairingCode,
  pairingExpiry,
  pairingState,
  verifyPollSecret,
} from "../src/index";

const keys = deriveServerKeys(new TextEncoder().encode("pairing-secret-0123456789abcdefghijklmnop"));
const T0 = new Date("2026-11-14T10:00:00Z");

describe("pairing codes", () => {
  it("are 8 chars from the contract alphabet and match the contract regex", () => {
    for (let i = 0; i < 2000; i++) {
      const code = generatePairingCode();
      expect(code).toHaveLength(8);
      for (const ch of code) expect(PAIRING_CODE_ALPHABET).toContain(ch);
      expect(PairingCode.safeParse(code).success).toBe(true);
    }
  });

  it("never contain ambiguous characters and use the whole alphabet", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) for (const ch of generatePairingCode()) seen.add(ch);
    for (const bad of ["0", "O", "1", "I", "L"]) expect(seen.has(bad)).toBe(false);
    expect(seen.size).toBe(PAIRING_CODE_ALPHABET.length);
  });

  it("are effectively unique", () => {
    const codes = new Set(Array.from({ length: 5000 }, generatePairingCode));
    expect(codes.size).toBe(5000);
  });

  it("expire after 600 s", () => {
    expect(PAIRING_CODE_TTL_SECONDS).toBe(600);
    expect(pairingExpiry(T0).toISOString()).toBe("2026-11-14T10:10:00.000Z");
  });

  it("are stored as keyed HMAC hashes, never in clear", () => {
    const p = createPairingCode(keys.pairingCode, T0, () => "c0000000-0000-4000-8000-000000000001");
    expect(p.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.codeHash).not.toContain(p.code);
    expect(hashPairingCode(keys.pairingCode, p.code)).toBe(p.codeHash);
    expect(hashPairingCode(keys.refreshToken, p.code)).not.toBe(p.codeHash);
    expect(
      PairingCodeResponse.safeParse({ pairing_id: p.pairingId, code: p.code, poll_secret: p.pollSecret, expires_at: p.expiresAt.toISOString() }).success,
    ).toBe(true);
  });

  it("normalises guardian input and rejects invalid codes", () => {
    expect(normalizePairingCode("abcd-efgh")).toBe("ABCDEFGH");
    expect(normalizePairingCode(" 23 45 67 89 ")).toBe("23456789");
    expect(normalizePairingCode("ABCDEFG0")).toBeNull();
    expect(normalizePairingCode("ABCDEFG")).toBeNull();
    expect(normalizePairingCode("<script>")).toBeNull();
  });

  it("poll secrets are ≥32 bytes and verified in constant time against a hash", () => {
    const s = generatePollSecret();
    expect(Buffer.from(s, "base64url").length).toBe(32);
    expect(s.length).toBeGreaterThanOrEqual(32);
    const p = createPairingCode(keys.pairingCode, T0, () => "c0000000-0000-4000-8000-000000000001");
    expect(verifyPollSecret(p.pollSecret, p.pollSecretHash)).toBe(true);
    expect(verifyPollSecret(generatePollSecret(), p.pollSecretHash)).toBe(false);
  });

  it("have a one-time lifecycle: pending → approved → redeemed; expired/locked are terminal", () => {
    const base = { expiresAt: pairingExpiry(T0), approvedAt: null, redeemedAt: null, failedAttempts: 0 };
    expect(pairingState(base, T0)).toBe("pending");
    expect(pairingState({ ...base, approvedAt: T0 }, T0)).toBe("approved");
    expect(pairingState({ ...base, approvedAt: T0, redeemedAt: T0 }, T0)).toBe("redeemed");
    expect(pairingState(base, new Date(T0.getTime() + 600_000))).toBe("expired");
    expect(MAX_PAIRING_FAILED_ATTEMPTS).toBe(5);
    expect(pairingState({ ...base, failedAttempts: 4 }, T0)).toBe("pending");
    expect(pairingState({ ...base, failedAttempts: 5 }, T0)).toBe("locked");
  });
});
