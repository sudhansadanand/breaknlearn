/** Store-backed consent gate and privacy repo fakes for the A9-PRIV-01 route tests (no database). */
import type { DbContext, Sql } from "../../src/server/db-port";
import type { ConsentGate } from "../../src/server/privacy/gate";
import type { DeletionRequestRow, PrivacyRepo } from "../../src/server/privacy/repo";
import type { Store } from "../fakes";

const ctxOf = (sql: Sql): DbContext => (sql as unknown as { ctx: DbContext }).ctx;
const has = (store: Store, householdId: string, scope: string) =>
  store.consent.some((c) => c.householdId === householdId && c.scope === scope && c.revokedAt === null);

/** Mirrors bnl.household_has_consent: a device sees only its own household; nothing else may call it. */
export function storeConsentGate(store: Store, calls: string[] = []): ConsentGate {
  return {
    async missingForDevice(sql, scopes) {
      const ctx = ctxOf(sql);
      if (ctx.kind !== "device") throw new Error("household_has_consent is granted to bnl_device only");
      calls.push(`device:${ctx.householdId}`);
      return scopes.filter((s) => !has(store, ctx.householdId, s));
    },
    async missingForHousehold(sql, householdId, scopes) {
      const ctx = ctxOf(sql);
      if (ctx.kind !== "adult") throw new Error("adult context expected");
      calls.push(`adult:${householdId}`);
      return scopes.filter((s) => !has(store, householdId, s));
    },
  };
}

export interface PrivacyFakeStore {
  requests: DeletionRequestRow[];
  exports: string[];
}

export function fakePrivacyRepo(store: Store, ps: PrivacyFakeStore, now: () => Date): PrivacyRepo {
  const visible = (sql: Sql, householdId: string) => {
    const ctx = ctxOf(sql);
    return ctx.kind === "adult" && store.memberships.some((m) => m.userId === ctx.userId && m.active && m.householdId === householdId);
  };
  return {
    async exportHousehold(sql, householdId) {
      if (!visible(sql, householdId)) throw Object.assign(new Error("bnl: not a member of this household"), { code: "42501" });
      ps.exports.push(householdId);
      return {
        household_id: householdId,
        generated_at: now().toISOString(),
        tables: {
          learner_profiles: store.profiles.filter((p) => p.householdId === householdId).map((p) => ({ id: p.id, household_id: p.householdId, display_name: p.displayName })),
          consent_records: store.consent.filter((c) => c.householdId === householdId).map((c) => ({ household_id: c.householdId, scope: c.scope })),
        },
      };
    },
    async learnerInHousehold(sql, householdId, learnerId) {
      return visible(sql, householdId) && store.profiles.some((p) => p.id === learnerId && p.householdId === householdId);
    },
    async openDeletionRequest(sql, householdId, scope, learnerId) {
      if (!visible(sql, householdId)) return null;
      return ps.requests.find((r) => r.householdId === householdId && r.scope === scope && r.learnerId === learnerId && (r.status === "requested" || r.status === "processing")) ?? null;
    },
    async insertDeletionRequest(sql, p) {
      const ctx = ctxOf(sql);
      // RLS adult_request: owner of the household, requested_by = the caller.
      if (ctx.kind !== "adult" || ctx.userId !== p.requestedBy || !store.memberships.some((m) => m.userId === ctx.userId && m.householdId === p.householdId && m.role === "owner")) {
        throw Object.assign(new Error("new row violates row-level security policy"), { code: "42501" });
      }
      const row: DeletionRequestRow = { id: crypto.randomUUID(), ...p, status: "requested", requestedAt: now(), completedAt: null, result: {} };
      ps.requests.push(row);
      return row;
    },
    async listDeletionRequests(sql, householdId) {
      return visible(sql, householdId) ? ps.requests.filter((r) => r.householdId === householdId) : [];
    },
  };
}
