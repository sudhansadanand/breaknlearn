/**
 * OPS-005 (interim): the operator procedure scripts/ops/sql/process-deletion-request.sql deletes exactly one
 * request's scope, leaves the other learner and the other household untouched, refuses replays and mismatched
 * learners, and audits without names. Runs the real SQL file through psql exactly as docs/ops/PRIVACY.md says.
 * SYNTHETIC data only; throwaway database of scripts/db/test-db.mjs.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MULT_TABLE_7 } from "../fixtures";
import { admin, closeAll } from "./helpers";
import { dropHousehold, publishedVersionOf, seedHousehold, type Household } from "./redteam-fixtures";

const SQL_FILE = resolve(__dirname, "../../../../scripts/ops/sql/process-deletion-request.sql");
const PSQL = join(process.env.BNL_PG_BIN ?? "/usr/lib/postgresql/16/bin", "psql");

function runProcedure(requestId: string): { status: number | null; stderr: string } {
  const r = spawnSync(PSQL, ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-1", "-d", process.env.BNL_TEST_ADMIN_URL!,
    "-c", `select set_config('bnl_ops.request_id', '${requestId}', false)`, "-f", SQL_FILE], { encoding: "utf8" });
  return { status: r.status, stderr: r.stderr };
}

async function request(h: Household, scope: string, learner: string | null): Promise<string> {
  const [row] = await admin<{ id: string }[]>`insert into bnl.data_deletion_requests (household_id, requested_by, scope, learner_id)
    values (${h.id}, ${h.owner}, ${scope}, ${learner}) returning id`;
  return row!.id;
}

/** Row counts of every bnl table that has a household_id column, for one household (optionally one learner). */
async function counts(household: string, learner?: string): Promise<Record<string, number>> {
  const tables = await admin<{ t: string; hasLearner: boolean }[]>`
    select c.table_name as t, bool_or(c2.column_name is not null) as "hasLearner"
    from information_schema.columns c
    left join information_schema.columns c2 on c2.table_schema = c.table_schema and c2.table_name = c.table_name and c2.column_name = 'learner_id'
    where c.table_schema = 'bnl' and c.column_name = 'household_id' group by c.table_name order by 1`;
  const out: Record<string, number> = {};
  for (const { t, hasLearner } of tables) {
    if (learner && !hasLearner) continue;
    const [r] = learner
      ? await admin.unsafe<{ n: number }[]>(`select count(*)::int as n from bnl.${t} where household_id = $1 and learner_id = $2`, [household, learner])
      : await admin.unsafe<{ n: number }[]>(`select count(*)::int as n from bnl.${t} where household_id = $1`, [household]);
    out[t] = r!.n;
  }
  return out;
}

async function auditFor(requestId: string) {
  return admin<{ household_id: string | null; metadata: Record<string, unknown> }[]>`
    select household_id, metadata from bnl.audit_logs where action = 'privacy.deletion_completed' and target_id = ${requestId}`;
}

let X: Household;
let Y: Household;
let yBefore: Record<string, number>;

beforeAll(async () => {
  const versionId = await publishedVersionOf(MULT_TABLE_7);
  X = await seedHousehold("DelX", versionId);
  Y = await seedHousehold("DelY", versionId);
  yBefore = await counts(Y.id);
});

afterAll(async () => {
  for (const h of [X, Y]) if (h) await dropHousehold(h.id);
  await admin`delete from bnl.audit_logs where action = 'privacy.deletion_completed' and household_id is null and metadata->>'scope' = 'household'
    and target_id not in (select id from bnl.data_deletion_requests)`;
  await closeAll();
});

describe("OPS-005 interim deletion procedure", () => {
  it("telemetry_only for one learner removes only that learner's raw events and sessions", async () => {
    const before = await counts(X.id);
    expect(before.learning_events).toBeGreaterThan(0);
    const id = await request(X, "telemetry_only", X.learners[0]);
    const r = runProcedure(id);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const after = await counts(X.id);
    expect(after.learning_events).toBe(0);
    expect(after.learning_sessions).toBe(0);
    // Everything else stays (only one learner's telemetry was asked for); +1 audit row.
    for (const t of Object.keys(before)) {
      if (["learning_events", "learning_sessions", "audit_logs", "data_deletion_requests"].includes(t)) continue;
      expect(after[t], t).toBe(before[t]);
    }
    const [req] = await admin<{ status: string }[]>`select status from bnl.data_deletion_requests where id = ${id}`;
    expect(req!.status).toBe("completed");
    expect(await counts(Y.id)).toEqual(yBefore);
  });

  it("refuses a replay of a completed request", () => {
    return admin<{ id: string }[]>`select id from bnl.data_deletion_requests where household_id = ${X.id} and status = 'completed'`.then(([row]) => {
      const r = runProcedure(row!.id);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/not found or already processed/);
    });
  });

  it("refuses a learner request whose learner belongs to another household (no cross-tenant deletion)", async () => {
    const id = await request(X, "learner", Y.learners[0]);
    const r = runProcedure(id);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/is not in household/);
    expect(await counts(Y.id)).toEqual(yBefore);
    await admin`delete from bnl.data_deletion_requests where id = ${id}`;
  });

  it("learner scope removes every row about that learner and the profile, keeps the sibling", async () => {
    const sibling = await counts(X.id, X.learners[1]);
    const mine = await counts(X.id, X.learners[0]);
    for (const t of ["learner_progress", "assessment_attempts", "question_responses", "mastery_snapshots", "recommendations", "migration_aliases"]) expect(mine[t], t).toBeGreaterThan(0);
    const id = await request(X, "learner", X.learners[0]);
    const r = runProcedure(id);
    expect(r.stderr).toBe("");
    const left = await counts(X.id, X.learners[0]);
    // data_deletion_requests keeps the request row itself (it names the learner id, never a name) as evidence.
    for (const [t, n] of Object.entries(left)) if (t !== "data_deletion_requests") expect(n, t).toBe(0);
    expect((await admin`select 1 from bnl.learner_profiles where id = ${X.learners[0]}`).length).toBe(0);
    expect((await admin`select 1 from bnl.learner_profiles where id = ${X.learners[1]}`).length).toBe(1);
    expect(await counts(X.id, X.learners[1])).toEqual(sibling);
    expect(await counts(Y.id)).toEqual(yBefore);
    const [audit] = await auditFor(id);
    expect(audit!.household_id).toBe(X.id);
    expect(JSON.stringify(audit!.metadata)).not.toMatch(/Synthetic|DelX/);
  });

  it("household scope removes the household and everything in it, lists storage keys, audits without names", async () => {
    const id = await request(X, "household", null);
    const r = runProcedure(id);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const left = await counts(X.id);
    for (const [t, n] of Object.entries(left)) if (t !== "audit_logs") expect(n, t).toBe(0);
    expect((await admin`select 1 from bnl.households where id = ${X.id}`).length).toBe(0);
    expect(await counts(Y.id)).toEqual(yBefore);
    const [audit] = await auditFor(id);
    expect(audit!.household_id).toBeNull();
    const meta = JSON.stringify(audit!.metadata);
    expect(meta).toContain(X.objectKey);
    expect(meta).not.toMatch(/Synthetic|DelX|synthetic-private\.pdf/);
  });

  it("the procedure itself is not callable by the request login (bnl_app cannot SET ROLE bnl_owner)", () => {
    const r = spawnSync(PSQL, ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-1", "-d", process.env.BNL_TEST_DB_URL!,
      "-c", `select set_config('bnl_ops.request_id', '${randomUUID()}', false)`, "-f", SQL_FILE], { encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/permission denied/);
  });
});
