import { HttpError, newRequestId, type AdultIdentity } from "@bnl/auth";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, adultFromSessionToken, withAdultHousehold, type HouseholdMembership } from "./authn";
import type { Sql } from "./db-port";
import { getDeps } from "./deps";
import type { Ctx } from "./http";

export const LOGIN_PATH = "/admin/login";
export const CHANGE_PASSWORD_PATH = "/admin/change-password";

export interface RequireAdultPageOptions {
  /** Only the change-password page sets this: it must stay reachable while the one-time password is pending. */
  readonly allowPendingPasswordChange?: boolean;
}

/**
 * Server-side gate for every /admin page except login (SEC-001): no session => redirect to login, no data.
 * An account that must still replace its one-time password is sent to the change-password page.
 */
export async function requireAdultPage(opts: RequireAdultPageOptions = {}): Promise<AdultIdentity> {
  const store = await cookies();
  const identity = await adultFromSessionToken(getDeps(), store.get(SESSION_COOKIE)?.value);
  if (!identity) redirect(LOGIN_PATH);
  if (identity.mustChangePassword && !opts.allowPendingPasswordChange) redirect(CHANGE_PASSWORD_PATH);
  return identity;
}

export type HouseholdView<T> = { kind: "ok"; data: T; membership: HouseholdMembership } | { kind: "no_household"; message: string };

/** Loads household-scoped data for a page under the adult's DB context. */
export async function loadForHousehold<T>(adult: AdultIdentity, fn: (sql: Sql, m: HouseholdMembership, c: Ctx) => Promise<T>): Promise<HouseholdView<T>> {
  const c: Ctx = { requestId: newRequestId(), deps: getDeps() };
  try {
    return await withAdultHousehold(c, adult, async (sql, m) => ({ kind: "ok" as const, data: await fn(sql, m, c), membership: m }));
  } catch (err) {
    // Only "no/ambiguous household" is a normal page state; everything else is a real error.
    if (err instanceof HttpError && (err.status === 403 || err.status === 409)) return { kind: "no_household", message: err.message };
    throw err;
  }
}
