import { HouseholdRole, StaffRole } from "@bnl/contracts";
import { redact } from "@bnl/auth";
import type { AuditRepo, ConsentRepo, ConsentScopeName, MembershipRepo, RateLimitRepo } from "./types";

/** bnl.household_memberships + bnl.staff_roles (ADR-0003). */
export const sqlMembershipRepo: MembershipRepo = {
  async activeMemberships(sql, userId) {
    const rows = await sql<{ householdId: string; role: string }[]>`
      select household_id as "householdId", role from bnl.household_memberships
       where auth_user_id = ${userId} and active = true
       order by household_id`;
    // Unknown role values fail closed (parse throws) rather than granting access.
    return rows.map((r) => ({ householdId: r.householdId, role: HouseholdRole.parse(r.role) }));
  },
  async activeStaffRoles(sql, userId) {
    const rows = await sql<{ role: string }[]>`
      select role from bnl.staff_roles where auth_user_id = ${userId} and revoked_at is null order by role`;
    return rows.map((r) => StaffRole.parse(r.role));
  },
};

/** bnl.consent_records. */
export const sqlConsentRepo: ConsentRepo = {
  async grant(sql, p) {
    await sql`
      insert into bnl.consent_records (household_id, guardian_auth_user_id, consent_version, scope)
      values (${p.householdId}, ${p.userId}, ${p.consentVersion}, ${p.scope ?? "learning_data"})`;
  },
  async revoke(sql, p) {
    const rows = p.scope
      ? await sql`
          update bnl.consent_records set revoked_at = ${p.at}
           where household_id = ${p.householdId} and scope = ${p.scope} and revoked_at is null
           returning 1`
      : await sql`
          update bnl.consent_records set revoked_at = ${p.at}
           where household_id = ${p.householdId} and guardian_auth_user_id = ${p.userId}
             and consent_version = ${p.consentVersion} and revoked_at is null
           returning 1`;
    return rows.length;
  },
  async active(sql, householdId) {
    const rows = await sql<{ scope: ConsentScopeName; consentVersion: string; guardianUserId: string; grantedAt: Date }[]>`
      select scope, consent_version as "consentVersion", guardian_auth_user_id as "guardianUserId", granted_at as "grantedAt"
        from bnl.consent_records
       where household_id = ${householdId} and revoked_at is null
       order by granted_at desc, id`;
    return rows.map((r) => ({ ...r, grantedAt: new Date(r.grantedAt) }));
  },
};

/** bnl.audit_logs. Metadata is redacted again here as defence in depth. */
export const sqlAuditRepo: AuditRepo = {
  async insert(sql, e) {
    const metadata = redact(e.metadata) as Parameters<typeof sql.json>[0];
    await sql`
      insert into bnl.audit_logs (actor_auth_id, household_id, action, target_type, target_id, metadata)
      values (${e.actorAuthId}, ${e.householdId}, ${e.action}, ${e.targetType}, ${e.targetId}, ${sql.json(metadata)})`;
  },
};

/** bnl.rate_limit_buckets(key, window_start, window_seconds, count) — fixed window, atomic upsert. */
export const sqlRateLimitRepo: RateLimitRepo = {
  async increment(sql, key, windowStart, windowSeconds) {
    const rows = await sql<{ count: number }[]>`
      insert into bnl.rate_limit_buckets (key, window_start, window_seconds, count)
      values (${key}, ${windowStart}, ${windowSeconds}, 1)
      on conflict (key, window_start) do update set count = bnl.rate_limit_buckets.count + 1
      returning count`;
    const count = rows[0]?.count;
    if (count === undefined) throw new Error("rate_limit_buckets upsert returned no row");
    return Number(count);
  },
};
