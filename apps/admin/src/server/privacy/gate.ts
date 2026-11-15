/**
 * Consent enforcement (A9-PRIV-01): data-ingesting endpoints answer 403 `consent_required` unless the household holds
 * an unrevoked consent_records row for every required scope. Always called AFTER authentication (an unauthenticated
 * caller still gets 401, SEC-001) and inside the request's own DB transaction, so a withdrawal takes effect on the
 * very next request.
 *
 * - Device context: `bnl.household_has_consent(scope)` (SECURITY DEFINER, bnl_device only) answers for the caller's
 *   own household from the verified token context; it never takes a household id, so it cannot probe another one.
 * - Adult context: consent_records is readable under RLS for the adult's own household.
 *
 * Any unrevoked version counts (a newer notice prompts parents to review; it does not cut off a child's TV).
 */
import { HttpError } from "@bnl/auth";
import type { Sql } from "../db-port";
import type { ConsentScope } from "./consent-text";

export interface ConsentGate {
  /** Scopes of `scopes` the device's household has NOT consented to. */
  missingForDevice(sql: Sql, scopes: readonly ConsentScope[]): Promise<ConsentScope[]>;
  /** Scopes of `scopes` the (adult-visible) household has NOT consented to. */
  missingForHousehold(sql: Sql, householdId: string, scopes: readonly ConsentScope[]): Promise<ConsentScope[]>;
}

export const sqlConsentGate: ConsentGate = {
  async missingForDevice(sql, scopes) {
    const rows = await sql<{ scope: ConsentScope; ok: boolean }[]>`
      select s as scope, bnl.household_has_consent(s) as ok from unnest(${scopes as string[]}::text[]) s`;
    return scopes.filter((s) => !rows.some((r) => r.scope === s && r.ok === true));
  },
  async missingForHousehold(sql, householdId, scopes) {
    const rows = await sql<{ scope: ConsentScope }[]>`
      select distinct scope from bnl.consent_records
       where household_id = ${householdId} and revoked_at is null and scope = any(${scopes as string[]}::text[])`;
    return scopes.filter((s) => !rows.some((r) => r.scope === s));
  },
};

let override: ConsentGate | null = null;

export function consentGate(): ConsentGate {
  return override ?? sqlConsentGate;
}

/** Test seam (route suites that are not about consent run with a permissive gate, see test/setup-flags.ts). */
export function setConsentGateForTesting(gate: ConsentGate | null): void {
  override = gate;
}

/** A gate that reports every scope as granted. Tests only. */
export const allowAllConsentGate: ConsentGate = {
  missingForDevice: async () => [],
  missingForHousehold: async () => [],
};

export function consentRequired(missing: readonly ConsentScope[]): HttpError {
  return new HttpError(403, "consent_required", "A parent has not given consent for this in the BreakNLearn portal (Privacy page)", {
    scopes: [...missing],
  });
}

/** Device endpoints: throws 403 consent_required unless the device's household consented to every scope. */
export async function requireDeviceConsent(sql: Sql, scopes: readonly ConsentScope[]): Promise<void> {
  const missing = await consentGate().missingForDevice(sql, scopes);
  if (missing.length > 0) throw consentRequired(missing);
}

/** Adult endpoints: throws 403 consent_required unless the adult's household consented to every scope. */
export async function requireHouseholdConsent(sql: Sql, householdId: string, scopes: readonly ConsentScope[]): Promise<void> {
  const missing = await consentGate().missingForHousehold(sql, householdId, scopes);
  if (missing.length > 0) throw consentRequired(missing);
}
