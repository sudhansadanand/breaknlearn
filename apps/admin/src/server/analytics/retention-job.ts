/**
 * Retention purge (spec §9, M13). Raw telemetry 90 days and analytics aggregates 13 months (395 days) by
 * default, configurable via RETENTION_RAW_TELEMETRY_DAYS (alias RETENTION_DAYS) / RETENTION_AGGREGATE_DAYS.
 * Runs as `{kind:'job'}` and calls the audited SECURITY DEFINER functions bnl.purge_expired (0003: events,
 * snapshots, recommendations, idempotency keys, pairing codes, rate buckets) and bnl.purge_expired_analytics
 * (0007: sessions, assessment records, closed reviews, run logs). Idempotent. Scheduling is the lead's.
 */
import type { DbRunner } from "../db-port";
import { RETENTION_DEFAULTS, validateRetention, type RetentionPolicy } from "./intelligence";

export const RETENTION_JOB_NAME = "retention_purge";

export interface PurgeResult {
  readonly policy: RetentionPolicy;
  readonly raw: Record<string, unknown>;
  readonly analytics: Record<string, unknown>;
}

export async function runRetentionPurge(
  db: DbRunner,
  policy: RetentionPolicy = RETENTION_DEFAULTS,
  opts: { log?: (entry: Record<string, unknown>) => void } = {},
): Promise<PurgeResult> {
  const p = validateRetention(policy);
  const result = await db({ kind: "job" }, async (sql) => {
    const [raw] = await sql<{ r: Record<string, unknown> }[]>`select bnl.purge_expired(${p.rawTelemetryDays}::int, ${p.aggregateDays}::int) as r`;
    const [analytics] = await sql<{ r: Record<string, unknown> }[]>`select bnl.purge_expired_analytics(${p.aggregateDays}::int) as r`;
    if (!raw || !analytics) throw new Error("retention: purge functions returned no result");
    return { policy: p, raw: raw.r, analytics: analytics.r };
  });
  opts.log?.({ level: "info", job: RETENTION_JOB_NAME, ...result });
  return result;
}
