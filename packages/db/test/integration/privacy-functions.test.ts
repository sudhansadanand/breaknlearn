/**
 * A9-PRIV-01 / OPS-005: migration 0009 against the real roles and RLS. SYNTHETIC households X and Y (redteam fixtures,
 * a row in every household table). Calls go through the bnl_app login with the request role the BFF/job would use.
 *   - bnl.household_has_consent: device-only, answers for the caller's own household only;
 *   - bnl.export_household: adult members only, own rows only, no secret columns, no other household's ids;
 *   - bnl.process_deletion_request: bnl_job only; same semantics as scripts/ops/sql/process-deletion-request.sql
 *     (pinned in redteam-deletion.test.ts), replay refused, cross-household learner rejected without deleting;
 *   - consent withdrawal is household-wide (a guardian can revoke the owner's grant) and cross-household safe.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withDbContext, type DbContext, type TransactionSql } from "../../src/index";
import { MULT_TABLE_7 } from "../fixtures";
import { admin, closeAll, db, rolledBack } from "./helpers";
import { dropHousehold, publishedVersionOf, seedHousehold, type Household } from "./redteam-fixtures";

let X: Household;
let Y: Household;
let Z: Household;

const device = (h: Household, deviceId = h.device): DbContext => ({ kind: "device", householdId: h.id, deviceId });
const adult = (userId: string): DbContext => ({ kind: "adult", userId });
const job: DbContext = { kind: "job" };

async function failsWith(ctx: DbContext, code: string, run: (sql: TransactionSql) => Promise<unknown>) {
  await expect(withDbContext(db, ctx, run)).rejects.toMatchObject({ code });
}

async function countsFor(householdId: string): Promise<Record<string, number>> {
  const tables = await admin<{ t: string }[]>`
    select c.table_name as t from information_schema.columns c where c.table_schema = 'bnl' and c.column_name = 'household_id' order by 1`;
  const out: Record<string, number> = {};
  for (const { t } of tables) {
    const [r] = await admin.unsafe<{ n: number }[]>(`select count(*)::int as n from bnl.${t} where household_id = $1`, [householdId]);
    out[t] = r!.n;
  }
  return out;
}

beforeAll(async () => {
  const versionId = await publishedVersionOf(MULT_TABLE_7);
  X = await seedHousehold("PrivX", versionId);
  Y = await seedHousehold("PrivY", versionId);
  Z = await seedHousehold("PrivZ", versionId);
  // The fixture seeds one learning_data grant (synthetic-v1) and one queued telemetry_only request per household.
  await admin`delete from bnl.data_deletion_requests where household_id in (${X.id}, ${Y.id}, ${Z.id})`;
});

afterAll(async () => {
  for (const h of [X, Y, Z]) if (h) await dropHousehold(h.id);
  await admin`delete from bnl.audit_logs where action like 'privacy.%' and household_id is null
    and target_id not in (select id from bnl.data_deletion_requests)`;
  await closeAll();
});

describe("bnl.household_has_consent (device only, own household only)", () => {
  it("answers per scope for the device's household; a revoked device gets false", async () => {
    const r = await rolledBack(device(X), (sql) => sql<{ s: string; ok: boolean }[]>`
      select s, bnl.household_has_consent(s) as ok from unnest(array['learning_data', 'telemetry', 'school_uploads']) s`);
    expect(r.map((x) => [x.s, x.ok])).toEqual([["learning_data", true], ["telemetry", false], ["school_uploads", false]]);
    const revoked = await rolledBack(device(X, X.revokedDevice), (sql) => sql<{ ok: boolean }[]>`select bnl.household_has_consent('learning_data') as ok`);
    expect(revoked[0]!.ok).toBe(false);
  });

  it("never reflects another household: a forged context naming X with Y's device gets false", async () => {
    const forged = await rolledBack({ kind: "device", householdId: X.id, deviceId: Y.device }, (sql) =>
      sql<{ ok: boolean }[]>`select bnl.household_has_consent('learning_data') as ok`);
    expect(forged[0]!.ok).toBe(false);
  });

  it("follows withdrawal immediately", async () => {
    await admin`insert into bnl.consent_records (household_id, guardian_auth_user_id, consent_version, scope) values (${Z.id}, ${Z.owner}, 'v-test', 'telemetry')`;
    const on = await rolledBack(device(Z), (sql) => sql<{ ok: boolean }[]>`select bnl.household_has_consent('telemetry') as ok`);
    expect(on[0]!.ok).toBe(true);
    // The guardian withdraws the owner's grant (household-wide revoke policy from 0009).
    await withDbContext(db, adult(Z.guardian), (sql) => sql`update bnl.consent_records set revoked_at = now() where household_id = ${Z.id} and scope = 'telemetry' and revoked_at is null`);
    const off = await rolledBack(device(Z), (sql) => sql<{ ok: boolean }[]>`select bnl.household_has_consent('telemetry') as ok`);
    expect(off[0]!.ok).toBe(false);
  });

  it("adults, jobs and the public cannot execute it", async () => {
    for (const ctx of [adult(X.owner), job, { kind: "public" } as DbContext]) {
      await failsWith(ctx, "42501", (sql) => sql`select bnl.household_has_consent('learning_data')`);
    }
  });

  it("household Y's adults cannot revoke X's consent (0 rows) or grant for X", async () => {
    const n = await rolledBack(adult(Y.owner), (sql) => sql`update bnl.consent_records set revoked_at = now() where household_id = ${X.id} returning 1`);
    expect(n.length).toBe(0);
    await failsWith(adult(Y.owner), "42501", (sql) =>
      sql`insert into bnl.consent_records (household_id, guardian_auth_user_id, consent_version, scope) values (${X.id}, ${Y.owner}, 'v', 'telemetry')`);
  });
});

describe("bnl.export_household (adult members only)", () => {
  it("returns every household table with only X's rows, no secret columns and no other household's ids", async () => {
    const out = await rolledBack(adult(X.guardian), (sql) => sql<{ e: { household_id: string; tables: Record<string, Record<string, unknown>[]> } }[]>`
      select bnl.export_household(${X.id}::uuid) as e`);
    const e = out[0]!.e;
    expect(e.household_id).toBe(X.id);
    const counts = await countsFor(X.id);
    for (const [t, n] of Object.entries(counts)) {
      if (t === "idempotency_keys") {
        expect(e.tables[t], t).toBeUndefined();
        continue;
      }
      expect(e.tables[t]?.length, t).toBe(n);
      for (const row of e.tables[t] ?? []) expect(row.household_id, t).toBe(X.id);
    }
    expect(e.tables.households!.map((h) => h.id)).toEqual([X.id]);
    const text = JSON.stringify(e);
    for (const id of [Y.id, Y.device, Y.owner, ...Y.learners, Y.objectKey]) expect(text).not.toContain(id);
    const keys = new Set(Object.values(e.tables).flatMap((rows) => rows.flatMap((r) => Object.keys(r))));
    expect([...keys].filter((k) => /token|secret|hash|password/.test(k))).toEqual([]);
    expect(text).not.toContain(X.pairingCodeHash);
    // Positive control: the child's own data is there.
    expect(e.tables.learner_profiles!.map((p) => p.id).sort()).toEqual([...X.learners].sort());
    expect(e.tables.syllabus_uploads![0]!.object_key).toBe(X.objectKey);
  });

  it("refuses a household the caller is not a member of (Y's owner, an outsider, staff, devices, jobs)", async () => {
    await failsWith(adult(Y.owner), "42501", (sql) => sql`select bnl.export_household(${X.id}::uuid)`);
    await failsWith(adult(randomUUID()), "42501", (sql) => sql`select bnl.export_household(${X.id}::uuid)`);
    for (const ctx of [device(X), job, { kind: "staff", userId: X.owner } as DbContext, { kind: "public" } as DbContext]) {
      await failsWith(ctx, "42501", (sql) => sql`select bnl.export_household(${X.id}::uuid)`);
    }
  });
});

describe("bnl.process_deletion_request (bnl_job only)", () => {
  async function queue(h: Household, scope: string, learner: string | null): Promise<string> {
    const [row] = await withDbContext(db, adult(h.owner), (sql) => sql<{ id: string }[]>`
      insert into bnl.data_deletion_requests (household_id, requested_by, scope, learner_id) values (${h.id}, ${h.owner}, ${scope}, ${learner}) returning id`);
    return row!.id;
  }
  const run = (id: string, removed = 0) =>
    withDbContext(db, job, (sql) => sql<{ r: { status: string; counts?: Record<string, unknown>; reason?: string } }[]>`
      select bnl.process_deletion_request(${id}::uuid, ${removed}::int) as r`).then((rows) => rows[0]!.r);

  it("a guardian cannot queue a deletion request (owner only, RLS)", async () => {
    await failsWith(adult(X.guardian), "42501", (sql) =>
      sql`insert into bnl.data_deletion_requests (household_id, requested_by, scope) values (${X.id}, ${X.guardian}, 'telemetry_only')`);
  });

  it("adults and devices cannot execute it", async () => {
    const id = await queue(Y, "telemetry_only", null);
    for (const ctx of [adult(Y.owner), device(Y), { kind: "staff", userId: Y.owner } as DbContext]) {
      await failsWith(ctx, "42501", (sql) => sql`select bnl.process_deletion_request(${id}::uuid, 0)`);
    }
    await admin`delete from bnl.data_deletion_requests where id = ${id}`;
  });

  it("learner request for another household's learner is rejected and deletes nothing", async () => {
    const yBefore = await countsFor(Y.id);
    const id = await queue(X, "learner", Y.learners[0]);
    const xBefore = await countsFor(X.id);
    expect(await run(id)).toMatchObject({ status: "rejected", reason: "learner_not_in_household" });
    expect(await countsFor(Y.id)).toEqual(yBefore);
    const xAfter = await countsFor(X.id);
    expect({ ...xAfter, audit_logs: 0 }).toEqual({ ...xBefore, audit_logs: 0 });
    const [req] = await admin<{ status: string }[]>`select status from bnl.data_deletion_requests where id = ${id}`;
    expect(req!.status).toBe("rejected");
    await expect(run(id)).rejects.toMatchObject({ code: "P0002" });
  });

  it("telemetry_only then learner scope: same semantics as the pinned operator procedure; replay refused", async () => {
    const yBefore = await countsFor(Y.id);
    const t = await queue(X, "telemetry_only", null);
    const r1 = await run(t);
    expect(r1.status).toBe("completed");
    const after1 = await countsFor(X.id);
    expect(after1.learning_events).toBe(0);
    expect(after1.learning_sessions).toBe(0);
    expect(after1.learner_progress).toBeGreaterThan(0);
    await expect(run(t)).rejects.toMatchObject({ code: "P0002" });

    const l = await queue(X, "learner", X.learners[0]);
    expect((await run(l)).status).toBe("completed");
    expect((await admin`select 1 from bnl.learner_profiles where id = ${X.learners[0]}`).length).toBe(0);
    expect((await admin`select 1 from bnl.learner_profiles where id = ${X.learners[1]}`).length).toBe(1);
    expect((await admin`select 1 from bnl.assessment_attempts where learner_id = ${X.learners[0]}`).length).toBe(0);
    const [audit] = await admin<{ household_id: string; metadata: unknown; actor_type: string }[]>`
      select household_id, metadata, actor_type from bnl.audit_logs where action = 'privacy.deletion_completed' and target_id = ${l}`;
    expect(audit!.household_id).toBe(X.id);
    expect(JSON.stringify(audit!.metadata)).not.toMatch(/Synthetic|PrivX/);
    expect(await countsFor(Y.id)).toEqual(yBefore);
  });

  it("household scope removes everything of the household (records storage removals), audits without names", async () => {
    const yBefore = await countsFor(Y.id);
    const id = await queue(X, "household", null);
    const r = await run(id, 1);
    expect(r.status).toBe("completed");
    expect(r.counts).toMatchObject({ households: 1, storage_objects_removed: 1 });
    for (const [t, n] of Object.entries(await countsFor(X.id))) if (t !== "audit_logs") expect(n, t).toBe(0);
    expect(await countsFor(Y.id)).toEqual(yBefore);
    const [audit] = await admin<{ household_id: string | null; metadata: unknown }[]>`
      select household_id, metadata from bnl.audit_logs where action = 'privacy.deletion_completed' and target_id = ${id}`;
    expect(audit!.household_id).toBeNull();
    expect(JSON.stringify(audit!.metadata)).not.toMatch(/Synthetic|PrivX|synthetic-private\.pdf/);
    // The request row went with the household; a replay is refused.
    await expect(run(id)).rejects.toMatchObject({ code: "P0002" });
  });
});
