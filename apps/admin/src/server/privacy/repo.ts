/** Data access for guardian export and deletion requests (A9-PRIV-01, OPS-005). Runs under the adult's RLS context. */
import type { Sql } from "../db-port";

export type DeletionScope = "learner" | "household" | "telemetry_only";
export type DeletionStatus = "requested" | "processing" | "completed" | "rejected";

export interface DeletionRequestRow {
  readonly id: string;
  readonly householdId: string;
  readonly requestedBy: string;
  readonly scope: DeletionScope;
  readonly learnerId: string | null;
  readonly status: DeletionStatus;
  readonly requestedAt: Date;
  readonly completedAt: Date | null;
  readonly result: Record<string, unknown>;
}

export interface HouseholdExport {
  readonly household_id: string;
  readonly generated_at: string;
  readonly tables: Record<string, unknown[]>;
}

export interface PrivacyRepo {
  /** bnl.export_household: every household-scoped row with token/secret/hash columns removed; refuses non-members. */
  exportHousehold(sql: Sql, householdId: string): Promise<HouseholdExport>;
  learnerInHousehold(sql: Sql, householdId: string, learnerId: string): Promise<boolean>;
  /** An unfinished request with the same scope and learner, if any. */
  openDeletionRequest(sql: Sql, householdId: string, scope: DeletionScope, learnerId: string | null): Promise<DeletionRequestRow | null>;
  insertDeletionRequest(sql: Sql, p: { householdId: string; requestedBy: string; scope: DeletionScope; learnerId: string | null }): Promise<DeletionRequestRow>;
  listDeletionRequests(sql: Sql, householdId: string): Promise<DeletionRequestRow[]>;
}

type RawRow = Omit<DeletionRequestRow, "requestedAt" | "completedAt"> & { requestedAt: Date | string; completedAt: Date | string | null };
const toRow = (r: RawRow): DeletionRequestRow => ({
  ...r,
  requestedAt: new Date(r.requestedAt),
  completedAt: r.completedAt === null ? null : new Date(r.completedAt),
});

export const sqlPrivacyRepo: PrivacyRepo = {
  async exportHousehold(sql, householdId) {
    const [row] = await sql<{ e: HouseholdExport }[]>`select bnl.export_household(${householdId}::uuid) as e`;
    if (!row) throw new Error("export_household returned no row");
    return row.e;
  },
  async learnerInHousehold(sql, householdId, learnerId) {
    const rows = await sql`select 1 from bnl.learner_profiles where id = ${learnerId} and household_id = ${householdId}`;
    return rows.length > 0;
  },
  async openDeletionRequest(sql, householdId, scope, learnerId) {
    const rows = await sql<RawRow[]>`
      select id, household_id as "householdId", requested_by as "requestedBy", scope, learner_id as "learnerId", status,
             requested_at as "requestedAt", completed_at as "completedAt", result
        from bnl.data_deletion_requests
       where household_id = ${householdId} and scope = ${scope} and learner_id is not distinct from ${learnerId}::uuid
         and status in ('requested', 'processing')
       order by requested_at limit 1`;
    return rows[0] ? toRow(rows[0]) : null;
  },
  async insertDeletionRequest(sql, p) {
    const rows = await sql<RawRow[]>`
      insert into bnl.data_deletion_requests (household_id, requested_by, scope, learner_id)
      values (${p.householdId}, ${p.requestedBy}, ${p.scope}, ${p.learnerId}::uuid)
      returning id, household_id as "householdId", requested_by as "requestedBy", scope, learner_id as "learnerId", status,
                requested_at as "requestedAt", completed_at as "completedAt", result`;
    if (!rows[0]) throw new Error("data_deletion_requests insert returned no row");
    return toRow(rows[0]);
  },
  async listDeletionRequests(sql, householdId) {
    const rows = await sql<RawRow[]>`
      select id, household_id as "householdId", requested_by as "requestedBy", scope, learner_id as "learnerId", status,
             requested_at as "requestedAt", completed_at as "completedAt", result
        from bnl.data_deletion_requests
       where household_id = ${householdId}
       order by requested_at desc, id limit 100`;
    return rows.map(toRow);
  },
};

let override: PrivacyRepo | null = null;

export function privacyRepo(): PrivacyRepo {
  return override ?? sqlPrivacyRepo;
}

/** Test seam. */
export function setPrivacyRepoForTesting(repo: PrivacyRepo | null): void {
  override = repo;
}
