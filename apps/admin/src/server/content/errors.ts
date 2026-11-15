import { HttpError } from "@bnl/auth";

/**
 * SQLSTATE contract of the bnl workflow functions (supabase/README.md) → API errors.
 * Only these known codes are translated; anything else propagates (500, redacted log).
 */
const MAP: Readonly<Record<string, { status: number; code: "forbidden" | "not_found" | "validation_failed" | "conflict"; message: string }>> = {
  "42501": { status: 403, code: "forbidden", message: "Not permitted for your role" },
  P0002: { status: 404, code: "not_found", message: "Not found" },
  "22023": { status: 422, code: "validation_failed", message: "The content or request is invalid" },
  "55000": { status: 409, code: "conflict", message: "Not allowed in the current state" },
  "23505": { status: 409, code: "conflict", message: "Already exists" },
  "23503": { status: 404, code: "not_found", message: "Referenced record not found" },
};

export function sqlState(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

/** Runs a database call and converts known SQLSTATEs (never the DB message text) into HttpErrors. */
export async function mapDbErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const state = sqlState(err);
    const mapped = state ? MAP[state] : undefined;
    if (!mapped) throw err;
    throw new HttpError(mapped.status, mapped.code, mapped.message, { sqlstate: state });
  }
}
