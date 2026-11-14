import { constantTimeEqual, randomBase64Url } from "./crypto";

/** Double-submit cookie (readable by same-origin JS, never httpOnly) and its mirror header. */
export const CSRF_COOKIE = "bnl_csrf";
export const CSRF_HEADER = "X-CSRF-Token";
export const CSRF_TOKEN_BYTES = 32;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function generateCsrfToken(): string {
  return randomBase64Url(CSRF_TOKEN_BYTES);
}

export interface CsrfInput {
  readonly method: string;
  readonly origin: string | null;
  readonly referer: string | null;
  readonly cookieToken: string | null | undefined;
  readonly headerToken: string | null | undefined;
}

export type CsrfResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "origin_mismatch" | "origin_missing" | "token_missing" | "token_mismatch" };

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * CSRF check for cookie-authenticated mutations (SEC-009, ADR-0002 A4):
 * 1. Origin must equal ADMIN_ORIGIN; if the browser sent no Origin, the
 *    Referer's origin must. Neither present => reject.
 * 2. X-CSRF-Token header must equal the bnl_csrf cookie (constant time).
 * Safe methods pass.
 */
export function checkCsrf(input: CsrfInput, adminOrigin: string): CsrfResult {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return { ok: true };
  const expected = originOf(adminOrigin);
  if (expected === null) throw new TypeError("ADMIN_ORIGIN is not a valid origin");

  if (input.origin !== null && input.origin !== "") {
    if (input.origin === "null" || originOf(input.origin) !== expected || input.origin.replace(/\/$/, "") !== expected) {
      return { ok: false, reason: "origin_mismatch" };
    }
  } else if (input.referer !== null && input.referer !== "") {
    if (originOf(input.referer) !== expected) return { ok: false, reason: "origin_mismatch" };
  } else {
    return { ok: false, reason: "origin_missing" };
  }

  const cookie = input.cookieToken ?? "";
  const header = input.headerToken ?? "";
  if (cookie.length < 16 || header.length < 16) return { ok: false, reason: "token_missing" };
  return constantTimeEqual(cookie, header) ? { ok: true } : { ok: false, reason: "token_mismatch" };
}

/** Minimal Cookie header parser (first occurrence wins). */
export function readCookie(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      const raw = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return null;
      }
    }
  }
  return null;
}
