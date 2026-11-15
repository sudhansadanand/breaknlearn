/**
 * Nightly deletion job (OPS-005): executes every queued data_deletion_requests row as `{kind:"job"}` through the
 * SECURITY DEFINER bnl.process_deletion_request (bnl_job only; port of scripts/ops/sql/process-deletion-request.sql).
 *
 * Household scope: the household's school-syllabi objects are removed from Storage FIRST, then the rows are deleted
 * in one transaction. A crash in between leaves the request queued; the next run removes nothing new (missing
 * objects are a no-op) and completes the database part, so a re-run is always safe (idempotent).
 * One failing request never blocks the others; failures are logged with ids only and retried next run.
 */
import type { StoragePort } from "@bnl/storage";
import type { DbRunner } from "../db-port";
import { SYLLABI_BUCKET } from "../curriculum/deps";

export const DELETION_JOB_NAME = "process_deletion_requests";

export interface DeletionJobOutcome {
  readonly id: string;
  readonly scope: string;
  readonly status: "completed" | "rejected" | "failed" | "skipped";
  readonly storage_objects_removed: number;
  readonly counts?: Record<string, unknown>;
  readonly error?: string;
}

export interface DeletionJobResult {
  readonly considered: number;
  readonly completed: number;
  readonly rejected: number;
  readonly failed: number;
  readonly outcomes: readonly DeletionJobOutcome[];
}

const errorText = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  const msg = err instanceof Error ? err.message : String(err);
  // Messages from the function carry request ids only; keep them short for the log.
  return `${typeof code === "string" ? `${code} ` : ""}${msg}`.slice(0, 200);
};

export async function runDeletionRequests(
  db: DbRunner,
  storage: StoragePort,
  opts: { limit?: number; log?: (entry: Record<string, unknown>) => void } = {},
): Promise<DeletionJobResult> {
  const pending = await db({ kind: "job" }, (sql) => sql<{ id: string; householdId: string; scope: string }[]>`
    select id, household_id as "householdId", scope from bnl.data_deletion_requests
     where status in ('requested', 'processing')
     order by requested_at, id
     limit ${opts.limit ?? 100}`);
  const outcomes: DeletionJobOutcome[] = [];
  for (const r of pending) {
    let removed = 0;
    try {
      if (r.scope === "household") {
        const keys = await db({ kind: "job" }, (sql) => sql<{ objectKey: string }[]>`
          select object_key as "objectKey" from bnl.syllabus_uploads where household_id = ${r.householdId} order by object_key`);
        for (const { objectKey } of keys) {
          // Keys are always `<household_id>/<uuid>` (curriculum/deps.ts); anything else is refused, never removed.
          if (!objectKey.startsWith(`${r.householdId}/`)) throw new Error(`object key outside household prefix for request ${r.id}`);
          await storage.remove(SYLLABI_BUCKET, objectKey);
          removed++;
        }
      }
      const [res] = await db({ kind: "job" }, (sql) => sql<{ r: { status: "completed" | "rejected"; counts?: Record<string, unknown> } }[]>`
        select bnl.process_deletion_request(${r.id}::uuid, ${removed}::int) as r`);
      if (!res) throw new Error("process_deletion_request returned no row");
      outcomes.push({ id: r.id, scope: r.scope, status: res.r.status, storage_objects_removed: removed, ...(res.r.counts ? { counts: res.r.counts } : {}) });
    } catch (err) {
      const text = errorText(err);
      // Finished concurrently by another run (P0002): nothing left to do.
      const status = text.startsWith("P0002") ? "skipped" : "failed";
      outcomes.push({ id: r.id, scope: r.scope, status, storage_objects_removed: removed, error: text });
      opts.log?.({ level: status === "failed" ? "error" : "info", job: DELETION_JOB_NAME, request_id: r.id, scope: r.scope, error: text });
    }
  }
  const result: DeletionJobResult = {
    considered: pending.length,
    completed: outcomes.filter((o) => o.status === "completed").length,
    rejected: outcomes.filter((o) => o.status === "rejected").length,
    failed: outcomes.filter((o) => o.status === "failed").length,
    outcomes,
  };
  // Run record for monitoring (MONITORING.md): counts only.
  await db({ kind: "job" }, (sql) => sql`
    insert into bnl.job_runs (job_name, run_key, status, result, finished_at)
    values (${DELETION_JOB_NAME}, ${new Date().toISOString()}, ${result.failed > 0 ? "failed" : "succeeded"},
            ${sql.json({ considered: result.considered, completed: result.completed, rejected: result.rejected, failed: result.failed })}, now())
    on conflict (job_name, run_key) do nothing`);
  opts.log?.({ level: "info", job: DELETION_JOB_NAME, considered: result.considered, completed: result.completed, rejected: result.rejected, failed: result.failed });
  return result;
}
