import { HttpError, newRequestId, type AdultIdentity } from "@bnl/auth";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, adultFromSessionToken, withAdultHousehold, type HouseholdMembership } from "./authn";
import type { Sql } from "./db-port";
import { getDeps } from "./deps";
import type { Ctx } from "./http";

export const LOGIN_PATH = "/admin/login";

/** Server-side gate for every /admin page except login (SEC-001): no session => redirect, no data. */
export async function requireAdultPage(): Promise<AdultIdentity> {
  const store = await cookies();
  const identity = await adultFromSessionToken(getDeps(), store.get(SESSION_COOKIE)?.value);
  if (!identity) redirect(LOGIN_PATH);
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
