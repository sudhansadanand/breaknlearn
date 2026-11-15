/**
 * Scoring job (A8, spec M10 "scheduled server job"). For every learner (or a given subset) computes ELS
 * snapshots per lesson and per topic from A7 assessment evidence and A6 progress, and refreshes the
 * learner's recommendations. Runs as `{kind:'job'}` (bnl_job, RLS + grants of ADR-0005).
 *
 * Idempotent and deterministic per (learner, topic, lesson, as_of date, weights_version): evidence is cut off
 * at the end of the as-of day (UTC), rows are upserted on that key, and stale rows of the same day are removed.
 * A new weights_version or day adds rows; history is never rewritten (ELS-008). Recommendations are only
 * refreshed by the newest as-of run, so a backfill of an old day cannot resurrect old nudges.
 */
import { ELS_WEIGHTS_VERSION } from "@bnl/contracts";
import { loadAttemptEvidence } from "../assessment/evidence";
import type { DbRunner, Sql } from "../db-port";
import { planLearner, type LearnerScoringData, type LessonInfo, type ProgressEvidence, type SnapshotPlan } from "./score-plan";
import type { LessonRecommendation } from "./intelligence";

export const SCORE_JOB_NAME = "score_learners";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ScoreScope {
  /** YYYY-MM-DD (UTC). Evidence up to the end of this day counts. */
  readonly asOf: string;
  /** Limit to these learners (on-demand re-score); all learners when omitted. */
  readonly learnerIds?: readonly string[];
}

export interface ScoreResult {
  readonly run_key: string;
  readonly as_of: string;
  readonly weights_version: string;
  readonly learners: number;
  readonly snapshots_written: number;
  readonly snapshots_removed: number;
  readonly recommendations: { readonly inserted: number; readonly superseded: number; readonly kept: number; readonly skipped_not_latest: boolean };
  readonly status_counts: Record<string, number>;
  readonly duration_ms: number;
}

/** Last instant of the as-of day in UTC. */
export function asOfInstant(date: string): Date {
  if (!DATE_RE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new Error("score: asOf must be YYYY-MM-DD");
  }
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000 - 1);
}

function validDate(date: string): boolean {
  try {
    asOfInstant(date);
    return true;
  } catch {
    return false;
  }
}

export const runKeyFor = (asOf: string, version = ELS_WEIGHTS_VERSION) => `els:${version}:${asOf}`;

const stepNumber = (slideId: string | null) => {
  const m = /(\d+)$/.exec(slideId ?? "");
  return m ? Number(m[1]) : 0;
};

async function loadLessons(sql: Sql): Promise<Map<string, LessonInfo>> {
  const rows = await sql<{ id: string; topic_id: string | null; sort_order: number; live: boolean }[]>`
    select l.id, l.topic_id, l.sort_order,
           exists (select 1 from bnl.publication_records p where p.lesson_id = l.id and p.unpublished_at is null) as live
      from bnl.lessons l order by l.topic_id nulls last, l.sort_order, l.id`;
  const out = new Map<string, LessonInfo>();
  for (const r of rows) {
    const next = r.topic_id === null ? undefined : rows.find((x) => x.topic_id === r.topic_id && x.live && (x.sort_order > r.sort_order || (x.sort_order === r.sort_order && x.id > r.id)));
    out.set(r.id, { topicId: r.topic_id, nextLessonId: next?.id ?? null });
  }
  return out;
}

async function loadProgress(sql: Sql, learnerId: string): Promise<ProgressEvidence[]> {
  const rows = await sql<{ lesson_id: string; completed: boolean; completed_at: Date | null; slide_id: string | null; created_at: Date; updated_at: Date; count_from: number | null; count_to: number | null }[]>`
    select p.lesson_id, p.completed, p.completed_at, p.slide_id, p.created_at, p.updated_at,
           (v.content->'config'->>'count_from')::int as count_from, (v.content->'config'->>'count_to')::int as count_to
      from bnl.learner_progress p
      left join bnl.lesson_versions v on v.id = coalesce(p.lesson_version_id,
        (select pr.lesson_version_id from bnl.publication_records pr where pr.lesson_id = p.lesson_id order by pr.published_at desc limit 1))
     where p.learner_id = ${learnerId}
     order by p.lesson_id, p.created_at, p.id`;
  return rows.map((r) => ({
    lessonId: r.lesson_id,
    completed: r.completed,
    completedAt: r.completed_at === null ? null : new Date(r.completed_at),
    slideIndex: stepNumber(r.slide_id),
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
    assignedSlides: r.count_to !== null ? r.count_to - (r.count_from ?? 1) + 1 : null,
  }));
}

async function loadLearner(sql: Sql, learner: { id: string; household_id: string }, lessons: Map<string, LessonInfo>): Promise<LearnerScoringData> {
  const ev = await loadAttemptEvidence(sql, learner.id);
  const reviews = await sql<{ lesson_id: string | null; due_at: Date }[]>`
    select lesson_id, due_at from bnl.review_schedule where learner_id = ${learner.id} and status = 'due' order by due_at, id`;
  return {
    learnerId: learner.id,
    householdId: learner.household_id,
    timezone: ev.timezone,
    attempts: ev.attempts,
    exposureByLesson: ev.exposureByLesson,
    progress: await loadProgress(sql, learner.id),
    openReviews: reviews.map((r) => ({ lessonId: r.lesson_id, dueAt: new Date(r.due_at) })),
    lessons,
  };
}

async function writeSnapshots(sql: Sql, runId: string, asOf: string, at: Date, learnerId: string, rows: readonly SnapshotPlan[]): Promise<{ written: number; removed: number }> {
  for (const s of rows) {
    const sc = s.score;
    await sql`
      insert into bnl.mastery_snapshots (household_id, learner_id, topic_id, lesson_id, score_run_id, score_date, score, status, confidence,
        components, coverage_pct, weights_version, questions_count, confidence_note, limitation, computed_at, evidence)
      values (${s.householdId}, ${s.learnerId}, ${s.topicId}, ${s.lessonId}, ${runId}, ${asOf}, ${sc.score}, ${sc.status}, ${sc.confidence},
        ${sql.json(sc.components)}, ${sc.coverage_pct}, ${sc.weights_version}, ${sc.questions_count}, ${sc.confidence_note}, ${sc.limitation}, ${at},
        ${sql.json(s.evidence as unknown as Parameters<Sql["json"]>[0])})
      on conflict (learner_id, topic_id, lesson_id, score_date, weights_version) do update set
        score_run_id = excluded.score_run_id, score = excluded.score, status = excluded.status, confidence = excluded.confidence,
        components = excluded.components, coverage_pct = excluded.coverage_pct, questions_count = excluded.questions_count,
        confidence_note = excluded.confidence_note, limitation = excluded.limitation, computed_at = excluded.computed_at, evidence = excluded.evidence`;
  }
  const keep = rows.map((s) => `${s.topicId ?? ""}|${s.lessonId ?? ""}`);
  const removed = await sql`
    delete from bnl.mastery_snapshots
     where learner_id = ${learnerId} and score_date = ${asOf} and weights_version = ${ELS_WEIGHTS_VERSION}
       and not (coalesce(topic_id::text, '') || '|' || coalesce(lesson_id::text, '') = any(${sql.array(keep.length ? keep : ["-"])}::text[]))`;
  return { written: rows.length, removed: removed.count };
}

const recKey = (r: { topic_id: string | null; lesson_id: string | null; reason_code: string }) => `${r.topic_id ?? ""}|${r.lesson_id ?? ""}|${r.reason_code}`;

async function syncRecommendations(sql: Sql, runId: string, at: Date, householdId: string, learnerId: string, recs: readonly LessonRecommendation[]) {
  const active = await sql<{ id: string; topic_id: string | null; lesson_id: string | null; reason_code: string }[]>`
    select id, topic_id, lesson_id, reason_code from bnl.recommendations
     where learner_id = ${learnerId} and superseded_at is null order by id`;
  const wanted = new Map(recs.map((r) => [recKey(r), r]));
  let superseded = 0;
  let kept = 0;
  let inserted = 0;
  for (const a of active) {
    const r = wanted.get(recKey(a));
    if (!r) {
      await sql`update bnl.recommendations set superseded_at = ${at} where id = ${a.id}`;
      superseded++;
      continue;
    }
    // Same nudge still applies: keep the row (and any dismissal); refresh its explanation.
    await sql`update bnl.recommendations set suggested_lesson_id = ${r.suggested_lesson_id}, detail = ${sql.json(r.detail as unknown as Parameters<Sql["json"]>[0])} where id = ${a.id}`;
    wanted.delete(recKey(a));
    kept++;
  }
  for (const r of wanted.values()) {
    await sql`
      insert into bnl.recommendations (household_id, learner_id, topic_id, lesson_id, score_run_id, reason_code, suggested_lesson_id, computed_at, detail)
      values (${householdId}, ${learnerId}, ${r.topic_id}, ${r.lesson_id}, ${runId}, ${r.reason_code}, ${r.suggested_lesson_id}, ${at},
              ${sql.json(r.detail as unknown as Parameters<Sql["json"]>[0])})`;
    inserted++;
  }
  return { inserted, superseded, kept };
}

async function recordJob(sql: Sql, runKey: string, status: "succeeded" | "failed", at: Date, result: Record<string, unknown>, error: string | null) {
  await sql`
    insert into bnl.job_runs (job_name, run_key, status, attempts, result, error_message, started_at, finished_at)
    values (${SCORE_JOB_NAME}, ${runKey}, ${status}, 1, ${sql.json(result as Parameters<Sql["json"]>[0])}, ${error}, ${at}, ${at})
    on conflict (job_name, run_key) do update
       set status = excluded.status, attempts = bnl.job_runs.attempts + 1, result = excluded.result,
           error_message = excluded.error_message, started_at = excluded.started_at, finished_at = excluded.finished_at`;
}

/** The computation and its writes, in one job transaction. */
export async function scoreInTransaction(sql: Sql, scope: ScoreScope, startedAt: Date): Promise<Omit<ScoreResult, "duration_ms">> {
  const at = asOfInstant(scope.asOf);
  if (scope.learnerIds && scope.learnerIds.some((id) => !UUID_RE.test(id))) throw new Error("score: learnerIds must be UUIDs");
  const runKey = runKeyFor(scope.asOf);
  const [run] = await sql<{ id: string }[]>`
    insert into bnl.score_runs (run_key, weights_version, as_of_date, status, started_at)
    values (${runKey}, ${ELS_WEIGHTS_VERSION}, ${scope.asOf}, 'running', ${startedAt})
    on conflict (run_key) do update set status = 'running', started_at = excluded.started_at, finished_at = null, error_message = null
    returning id`;
  if (!run) throw new Error("score: could not create score run");
  const runId = run.id;
  const [newer] = await sql<{ n: number }[]>`
    select count(*)::int as n from bnl.score_runs where weights_version = ${ELS_WEIGHTS_VERSION} and status = 'succeeded' and as_of_date > ${scope.asOf}`;
  const latest = (newer?.n ?? 0) === 0;

  const learners = scope.learnerIds
    ? await sql<{ id: string; household_id: string }[]>`select id, household_id from bnl.learner_profiles where id = any(${sql.array([...scope.learnerIds])}::uuid[]) order by id`
    : await sql<{ id: string; household_id: string }[]>`select id, household_id from bnl.learner_profiles order by id`;
  const lessons = await loadLessons(sql);

  let written = 0;
  let removed = 0;
  const recs = { inserted: 0, superseded: 0, kept: 0 };
  const statusCounts: Record<string, number> = {};
  for (const learner of learners) {
    const plan = planLearner(await loadLearner(sql, learner, lessons), at);
    const w = await writeSnapshots(sql, runId, scope.asOf, at, learner.id, plan.snapshots);
    written += w.written;
    removed += w.removed;
    for (const s of plan.snapshots) statusCounts[s.score.status] = (statusCounts[s.score.status] ?? 0) + 1;
    if (latest) {
      const r = await syncRecommendations(sql, runId, at, learner.household_id, learner.id, plan.recommendations);
      recs.inserted += r.inserted;
      recs.superseded += r.superseded;
      recs.kept += r.kept;
    }
  }
  await sql`update bnl.score_runs set status = 'succeeded', rows_written = ${written}, finished_at = ${startedAt} where id = ${runId}`;
  return {
    run_key: runKey,
    as_of: scope.asOf,
    weights_version: ELS_WEIGHTS_VERSION,
    learners: learners.length,
    snapshots_written: written,
    snapshots_removed: removed,
    recommendations: { ...recs, skipped_not_latest: !latest },
    status_counts: statusCounts,
  };
}

/**
 * Entry point for scripts/jobs/score-learners.mjs and a future cron route. Success: everything commits
 * together. Failure: rolls back, the failure is recorded in its own transaction, and the error is re-thrown.
 */
export async function scoreLearners(
  db: DbRunner,
  scope: ScoreScope,
  opts: { now?: () => Date; log?: (entry: Record<string, unknown>) => void } = {},
): Promise<ScoreResult> {
  const now = opts.now ?? (() => new Date());
  const started = now();
  const runKey = runKeyFor(scope.asOf);
  try {
    const result = await db({ kind: "job" }, async (sql) => {
      const r = await scoreInTransaction(sql, scope, started);
      const full: ScoreResult = { ...r, duration_ms: now().getTime() - started.getTime() };
      await recordJob(sql, runKey, "succeeded", started, { ...full }, null);
      return full;
    });
    opts.log?.({ level: "info", job: SCORE_JOB_NAME, ...result });
    return result;
  } catch (err) {
    const message = (err instanceof Error ? err.message : "unknown error").slice(0, 300);
    await db({ kind: "job" }, async (sql) => {
      await recordJob(sql, runKey, "failed", started, { run_key: runKey }, message);
      if (validDate(scope.asOf)) {
        await sql`
          insert into bnl.score_runs (run_key, weights_version, as_of_date, status, started_at, finished_at, error_message)
          values (${runKey}, ${ELS_WEIGHTS_VERSION}, ${scope.asOf}, 'failed', ${started}, ${started}, ${message})
          on conflict (run_key) do update set status = 'failed', finished_at = excluded.finished_at, error_message = excluded.error_message`;
      }
    });
    opts.log?.({ level: "error", job: SCORE_JOB_NAME, run_key: runKey, error: message });
    throw err;
  }
}
