/**
 * Data-retention policy (spec §9, M13). Defaults pending owner/legal sign-off:
 * raw telemetry 90 days, analytics aggregates 13 months (395 days). Pure helpers; the purge itself runs in
 * the database (bnl.purge_expired, bnl.purge_expired_analytics) under the job role.
 */
export interface RetentionPolicy {
  /** learning_events (raw telemetry). */
  readonly rawTelemetryDays: number;
  /** Sessions totals, assessment records, score snapshots, recommendations, run logs. */
  readonly aggregateDays: number;
}

export const RETENTION_DEFAULTS: RetentionPolicy = { rawTelemetryDays: 90, aggregateDays: 395 };

const DAY_MS = 86_400_000;

/** Validates a policy (fails closed: a typo must never purge everything). */
export function validateRetention(p: RetentionPolicy): RetentionPolicy {
  const ok = (n: number) => Number.isInteger(n) && n >= 1 && n <= 3650;
  if (!ok(p.rawTelemetryDays) || !ok(p.aggregateDays)) throw new RangeError("retention days must be integers in 1..3650");
  if (p.aggregateDays < p.rawTelemetryDays) throw new RangeError("aggregate retention must be at least raw telemetry retention");
  if (p.rawTelemetryDays < 30) throw new RangeError("raw telemetry retention below 30 days would break the 72 h offline window and dedup audits");
  return p;
}

/** Parses RETENTION_* style env values; unset → default. */
export function retentionFromEnv(env: Readonly<Record<string, string | undefined>>): RetentionPolicy {
  const num = (v: string | undefined, d: number) => (v === undefined || v.trim() === "" ? d : Number(v));
  return validateRetention({
    rawTelemetryDays: num(env.RETENTION_RAW_TELEMETRY_DAYS ?? env.RETENTION_DAYS, RETENTION_DEFAULTS.rawTelemetryDays),
    aggregateDays: num(env.RETENTION_AGGREGATE_DAYS, RETENTION_DEFAULTS.aggregateDays),
  });
}

/** Rows strictly older than these instants are purged. */
export function retentionCutoffs(now: Date, p: RetentionPolicy): { raw: Date; aggregate: Date } {
  validateRetention(p);
  return { raw: new Date(now.getTime() - p.rawTelemetryDays * DAY_MS), aggregate: new Date(now.getTime() - p.aggregateDays * DAY_MS) };
}
