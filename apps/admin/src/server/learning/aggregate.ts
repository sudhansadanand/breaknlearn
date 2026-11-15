/**
 * Session aggregation job (M07 "scheduled reducer", OPS-004). Recomputes learning_sessions
 * playback_ms / foreground_estimated_ms / interaction_count from the stored, deduplicated events
 * with the shared reducer (hidden/paused time excluded, 30 s cap, `suspect` events excluded).
 * Runs as `{kind:'job'}`. Deterministic: re-running a job_key over the same events writes identical
 * totals. Each run is recorded in aggregation_runs (one row per job_key) and job_runs (attempts).
 */
import { EventPayload, EventType, type LearningEvent } from "@bnl/contracts";
import { reduceSessions } from "@bnl/telemetry";
import type { DbRunner, Sql } from "../db-port";
import { sha256Hex } from "./common";

export const AGGREGATE_JOB_NAME = "aggregate_sessions";

export type AggregateScope = { readonly date: string } | { readonly sessionIds: readonly string[] };

export interface AggregateResult {
  readonly job_key: string;
  readonly sessions_considered: number;
  readonly sessions_changed: number;
  readonly events_considered: number;
  readonly events_excluded: number;
  readonly totals: { readonly playback_ms: number; readonly foreground_estimated_ms: number; readonly interaction_count: number };
  /** Max (received_at - occurred_at) among considered events: ingest lag metric. */
  readonly max_ingest_lag_ms: number;
  readonly duration_ms: number;
}

interface EventRow {
  event_id: string;
  session_id: string;
  learner_id: string;
  device_id: string;
  client_session_id: string;
  client_sequence: number;
  event_type: string;
  lesson_id: string | null;
  lesson_version_id: string | null;
  slide_id: string | null;
  occurred_at: Date;
  sent_at: Date | null;
  received_at: Date;
  payload: unknown;
  quality_flag: string;
}

interface SessionRow {
  id: string;
  playback_ms: number;
  foreground_estimated_ms: number;
  interaction_count: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function jobKeyFor(scope: AggregateScope): string {
  if ("date" in scope) {
    if (!DATE_RE.test(scope.date) || Number.isNaN(Date.parse(`${scope.date}T00:00:00Z`))) throw new Error("aggregate: date must be YYYY-MM-DD");
    return `sessions:date:${scope.date}`;
  }
  if (scope.sessionIds.length === 0 || scope.sessionIds.some((s) => !UUID_RE.test(s))) throw new Error("aggregate: sessionIds must be UUIDs");
  const sorted = [...new Set(scope.sessionIds.map((s) => s.toLowerCase()))].sort();
  return `sessions:ids:${sha256Hex(sorted.join(",")).slice(0, 32)}`;
}

/** DB row -> contract event, or null if the stored row no longer satisfies the v1 schema. */
function toEvent(r: EventRow): LearningEvent | null {
  const payload = EventPayload.safeParse(r.payload);
  const type = EventType.safeParse(r.event_type);
  if (!payload.success || !type.success) return null;
  const occurred = new Date(r.occurred_at).toISOString();
  return {
    event_id: r.event_id,
    schema_version: 1,
    event_type: type.data,
    occurred_at: occurred,
    sent_at: r.sent_at ? new Date(r.sent_at).toISOString() : occurred,
    client_session_id: r.client_session_id,
    client_sequence: r.client_sequence,
    learner_id: r.learner_id,
    device_id: r.device_id,
    ...(r.lesson_id ? { lesson_id: r.lesson_id } : {}),
    ...(r.lesson_version_id ? { lesson_version_id: r.lesson_version_id } : {}),
    ...(r.slide_id ? { slide_id: r.slide_id } : {}),
    payload: payload.data,
  };
}

async function sessionsInScope(sql: Sql, scope: AggregateScope): Promise<SessionRow[]> {
  const cols = sql`s.id, s.playback_ms::float8 as playback_ms, s.foreground_estimated_ms::float8 as foreground_estimated_ms, s.interaction_count`;
  if ("date" in scope) {
    const from = new Date(`${scope.date}T00:00:00Z`);
    const to = new Date(from.getTime() + 86_400_000);
    return sql<SessionRow[]>`
      select ${cols} from bnl.learning_sessions s
       where s.started_at < ${to} and exists (
         select 1 from bnl.learning_events e where e.session_id = s.id and e.occurred_at >= ${from} and e.occurred_at < ${to})
          or (s.started_at >= ${from} and s.started_at < ${to})
       order by s.id`;
  }
  return sql<SessionRow[]>`select ${cols} from bnl.learning_sessions s where s.id = any(${sql.array([...scope.sessionIds])}::uuid[]) order by s.id`;
}

/** The computation and its writes, in one job transaction. */
export async function recomputeSessions(sql: Sql, scope: AggregateScope): Promise<Omit<AggregateResult, "job_key" | "duration_ms">> {
  const sessions = await sessionsInScope(sql, scope);
  if (sessions.length === 0) {
    return { sessions_considered: 0, sessions_changed: 0, events_considered: 0, events_excluded: 0, totals: { playback_ms: 0, foreground_estimated_ms: 0, interaction_count: 0 }, max_ingest_lag_ms: 0 };
  }
  const rows = await sql<EventRow[]>`
    select event_id, session_id, learner_id, device_id, client_session_id, client_sequence::float8 as client_sequence, event_type,
           lesson_id, lesson_version_id, slide_id, occurred_at, sent_at, received_at, payload, quality_flag
      from bnl.learning_events
     where session_id = any(${sql.array(sessions.map((s) => s.id))}::uuid[])
     order by session_id, client_sequence, event_id`;
  const bySession = new Map<string, LearningEvent[]>();
  let excluded = 0;
  let lag = 0;
  for (const r of rows) {
    const e = r.quality_flag === "suspect" ? null : toEvent(r);
    if (!e) {
      excluded++;
      continue;
    }
    lag = Math.max(lag, new Date(r.received_at).getTime() - new Date(r.occurred_at).getTime());
    const list = bySession.get(r.session_id) ?? [];
    list.push(e);
    bySession.set(r.session_id, list);
  }
  let changed = 0;
  const totals = { playback_ms: 0, foreground_estimated_ms: 0, interaction_count: 0 };
  for (const s of sessions) {
    // One session per call: client_session_id is only unique per device.
    const [m] = [...reduceSessions(bySession.get(s.id) ?? []).values()];
    const next = { playback_ms: m?.playback_ms ?? 0, foreground_estimated_ms: m?.foreground_estimated_ms ?? 0, interaction_count: m?.interaction_count ?? 0 };
    totals.playback_ms += next.playback_ms;
    totals.foreground_estimated_ms += next.foreground_estimated_ms;
    totals.interaction_count += next.interaction_count;
    if (next.playback_ms === s.playback_ms && next.foreground_estimated_ms === s.foreground_estimated_ms && next.interaction_count === s.interaction_count) continue;
    changed++;
    await sql`
      update bnl.learning_sessions
         set playback_ms = ${next.playback_ms}, foreground_estimated_ms = ${next.foreground_estimated_ms}, interaction_count = ${next.interaction_count}
       where id = ${s.id}`;
  }
  return { sessions_considered: sessions.length, sessions_changed: changed, events_considered: rows.length - excluded, events_excluded: excluded, totals, max_ingest_lag_ms: Math.max(0, lag) };
}

async function recordRun(sql: Sql, jobKey: string, status: "succeeded" | "failed", at: Date, result: Record<string, unknown>, error: string | null): Promise<void> {
  await sql`
    insert into bnl.aggregation_runs (job_key, status, started_at, finished_at, error_message)
    values (${jobKey}, ${status}, ${at}, ${at}, ${error})
    on conflict (job_key) do update
       set status = excluded.status, started_at = excluded.started_at, finished_at = excluded.finished_at, error_message = excluded.error_message`;
  await sql`
    insert into bnl.job_runs (job_name, run_key, status, attempts, result, error_message, started_at, finished_at)
    values (${AGGREGATE_JOB_NAME}, ${jobKey}, ${status}, 1, ${sql.json(result as Parameters<Sql["json"]>[0])}, ${error}, ${at}, ${at})
    on conflict (job_name, run_key) do update
       set status = excluded.status, attempts = bnl.job_runs.attempts + 1, result = excluded.result,
           error_message = excluded.error_message, started_at = excluded.started_at, finished_at = excluded.finished_at`;
}

/**
 * Entry point for the CLI (scripts/jobs/aggregate-sessions.mjs) and a future cron route.
 * Success: computation, writes and run records commit together. Failure: the computation rolls
 * back, the failure is recorded in its own transaction, and the error is re-thrown.
 */
export async function aggregateSessions(
  db: DbRunner,
  scope: AggregateScope,
  opts: { now?: () => Date; log?: (entry: Record<string, unknown>) => void } = {},
): Promise<AggregateResult> {
  const now = opts.now ?? (() => new Date());
  const jobKey = jobKeyFor(scope);
  const started = now();
  try {
    const result = await db({ kind: "job" }, async (sql) => {
      const r = await recomputeSessions(sql, scope);
      const full: AggregateResult = { job_key: jobKey, ...r, duration_ms: now().getTime() - started.getTime() };
      await recordRun(sql, jobKey, "succeeded", started, { ...full }, null);
      return full;
    });
    opts.log?.({ level: "info", job: AGGREGATE_JOB_NAME, ...result });
    return result;
  } catch (err) {
    const message = (err instanceof Error ? err.message : "unknown error").slice(0, 300);
    await db({ kind: "job" }, (sql) => recordRun(sql, jobKey, "failed", started, { job_key: jobKey }, message));
    opts.log?.({ level: "error", job: AGGREGATE_JOB_NAME, job_key: jobKey, error: message });
    throw err;
  }
}
