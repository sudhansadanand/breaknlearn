/**
 * Adult-context reads for the analytics dashboard and API. Every query runs inside `withAdultHousehold`
 * (bnl_adult, RLS limits rows to the caller's households) and is additionally filtered by household id.
 * Tests swap in an in-memory fake through {@link setAnalyticsRepoForTesting}.
 */
import { ELS_WEIGHTS_VERSION, type LearningScore } from "@bnl/contracts";
import type { Sql } from "../db-port";
import type { EvidenceRecord } from "./intelligence";

export interface SnapshotRow {
  readonly learnerId: string;
  readonly topicId: string | null;
  readonly lessonId: string | null;
  readonly scoreDate: string;
  readonly score: LearningScore;
  readonly evidence: EvidenceRecord | null;
}

export interface SessionRow {
  readonly learnerId: string;
  readonly startedAt: Date;
  readonly playbackMs: number;
  readonly foregroundEstimatedMs: number;
  readonly interactionCount: number;
}

export interface ReviewRow {
  readonly id: string;
  readonly learnerId: string;
  readonly lessonId: string | null;
  readonly topicId: string | null;
  readonly dueAt: Date;
}

export interface RecommendationRow {
  readonly id: string;
  readonly householdId: string;
  readonly learnerId: string;
  readonly topicId: string | null;
  readonly lessonId: string | null;
  readonly reasonCode: string;
  readonly suggestedLessonId: string | null;
  readonly computedAt: Date;
  readonly dismissedAt: Date | null;
  readonly detail: Record<string, unknown>;
}

export interface LessonRow {
  readonly id: string;
  readonly title: string;
  readonly topicId: string | null;
  readonly sortOrder: number;
}

export interface AnalyticsRepo {
  householdTimezone(sql: Sql, householdId: string): Promise<string | null>;
  /** Latest snapshot per (learner, topic, lesson) for the current weights version. */
  latestSnapshots(sql: Sql, householdId: string, learnerIds: readonly string[]): Promise<SnapshotRow[]>;
  sessions(sql: Sql, householdId: string, learnerIds: readonly string[], from: Date, to: Date): Promise<SessionRow[]>;
  openReviews(sql: Sql, householdId: string, learnerIds: readonly string[]): Promise<ReviewRow[]>;
  /** Active (not superseded) recommendations, dismissed ones included. */
  activeRecommendations(sql: Sql, householdId: string, learnerIds: readonly string[]): Promise<RecommendationRow[]>;
  /** Sets or clears dismissed_at on an active recommendation of the household; null when not found. */
  setDismissed(sql: Sql, householdId: string, id: string, at: Date | null): Promise<RecommendationRow | null>;
  /** Published lessons the adult may see (titles for the dashboard). */
  lessons(sql: Sql): Promise<LessonRow[]>;
}

const iso = (d: Date | string) => new Date(d).toISOString();
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

interface SnapshotDb {
  learner_id: string;
  topic_id: string | null;
  lesson_id: string | null;
  score_date: string;
  score: string | null;
  status: LearningScore["status"];
  confidence: LearningScore["confidence"];
  components: Record<string, unknown>;
  coverage_pct: string;
  weights_version: string;
  questions_count: number;
  confidence_note: string;
  limitation: string;
  computed_at: Date;
  evidence: Record<string, unknown>;
}

interface RecDb {
  id: string;
  household_id: string;
  learner_id: string;
  topic_id: string | null;
  lesson_id: string | null;
  reason_code: string;
  suggested_lesson_id: string | null;
  computed_at: Date;
  dismissed_at: Date | null;
  detail: Record<string, unknown>;
}

const toRec = (r: RecDb): RecommendationRow => ({
  id: r.id, householdId: r.household_id, learnerId: r.learner_id, topicId: r.topic_id, lessonId: r.lesson_id, reasonCode: r.reason_code,
  suggestedLessonId: r.suggested_lesson_id, computedAt: new Date(r.computed_at), dismissedAt: r.dismissed_at === null ? null : new Date(r.dismissed_at), detail: r.detail ?? {},
});

export const sqlAnalyticsRepo: AnalyticsRepo = {
  async householdTimezone(sql, householdId) {
    const [r] = await sql<{ timezone: string }[]>`select timezone from bnl.households where id = ${householdId}`;
    return r?.timezone ?? null;
  },
  async latestSnapshots(sql, householdId, learnerIds) {
    if (learnerIds.length === 0) return [];
    const rows = await sql<SnapshotDb[]>`
      select distinct on (learner_id, topic_id, lesson_id)
             learner_id, topic_id, lesson_id, to_char(score_date, 'YYYY-MM-DD') as score_date, score, status, confidence, components,
             coverage_pct, weights_version, questions_count, confidence_note, limitation, computed_at, evidence
        from bnl.mastery_snapshots
       where household_id = ${householdId} and learner_id = any(${sql.array([...learnerIds])}::uuid[]) and weights_version = ${ELS_WEIGHTS_VERSION}
       order by learner_id, topic_id, lesson_id, score_date desc, computed_at desc`;
    return rows.map((r) => {
      const c = r.components as Record<"M" | "R" | "I" | "C", unknown>;
      return {
        learnerId: r.learner_id,
        topicId: r.topic_id,
        lessonId: r.lesson_id,
        scoreDate: r.score_date,
        score: {
          learner_id: r.learner_id,
          topic_id: r.topic_id,
          score: num(r.score),
          status: r.status,
          confidence: r.confidence,
          components: { M: num(c.M), R: num(c.R), I: num(c.I), C: num(c.C) },
          coverage_pct: Number(r.coverage_pct),
          weights_version: r.weights_version,
          questions_count: r.questions_count,
          confidence_note: r.confidence_note,
          limitation: r.limitation,
          computed_at: iso(r.computed_at),
        },
        evidence: r.evidence && Array.isArray((r.evidence as { flags?: unknown }).flags) ? (r.evidence as unknown as EvidenceRecord) : null,
      };
    });
  },
  async sessions(sql, householdId, learnerIds, from, to) {
    if (learnerIds.length === 0) return [];
    const rows = await sql<{ learner_id: string; started_at: Date; playback_ms: string; foreground_estimated_ms: string; interaction_count: number }[]>`
      select learner_id, started_at, playback_ms, foreground_estimated_ms, interaction_count from bnl.learning_sessions
       where household_id = ${householdId} and learner_id = any(${sql.array([...learnerIds])}::uuid[])
         and started_at >= ${from} and started_at < ${to}
       order by started_at`;
    return rows.map((r) => ({ learnerId: r.learner_id, startedAt: new Date(r.started_at), playbackMs: Number(r.playback_ms), foregroundEstimatedMs: Number(r.foreground_estimated_ms), interactionCount: r.interaction_count }));
  },
  async openReviews(sql, householdId, learnerIds) {
    if (learnerIds.length === 0) return [];
    const rows = await sql<{ id: string; learner_id: string; lesson_id: string | null; topic_id: string | null; due_at: Date }[]>`
      select id, learner_id, lesson_id, topic_id, due_at from bnl.review_schedule
       where household_id = ${householdId} and learner_id = any(${sql.array([...learnerIds])}::uuid[]) and status = 'due'
       order by due_at, id`;
    return rows.map((r) => ({ id: r.id, learnerId: r.learner_id, lessonId: r.lesson_id, topicId: r.topic_id, dueAt: new Date(r.due_at) }));
  },
  async activeRecommendations(sql, householdId, learnerIds) {
    if (learnerIds.length === 0) return [];
    const rows = await sql<RecDb[]>`
      select id, household_id, learner_id, topic_id, lesson_id, reason_code, suggested_lesson_id, computed_at, dismissed_at, detail
        from bnl.recommendations
       where household_id = ${householdId} and learner_id = any(${sql.array([...learnerIds])}::uuid[]) and superseded_at is null
       order by computed_at desc, id`;
    return rows.map(toRec);
  },
  async setDismissed(sql, householdId, id, at) {
    const rows = await sql<RecDb[]>`
      update bnl.recommendations set dismissed_at = ${at}
       where id = ${id} and household_id = ${householdId} and superseded_at is null
       returning id, household_id, learner_id, topic_id, lesson_id, reason_code, suggested_lesson_id, computed_at, dismissed_at, detail`;
    return rows[0] ? toRec(rows[0]) : null;
  },
  async lessons(sql) {
    const rows = await sql<{ id: string; title: string; topic_id: string | null; sort_order: number }[]>`
      select id, title, topic_id, sort_order from bnl.lessons order by sort_order, id`;
    return rows.map((r) => ({ id: r.id, title: r.title, topicId: r.topic_id, sortOrder: r.sort_order }));
  },
};

let override: AnalyticsRepo | null = null;
export const analyticsRepo = (): AnalyticsRepo => override ?? sqlAnalyticsRepo;
/** Test seam. */
export function setAnalyticsRepoForTesting(repo: AnalyticsRepo | null): void {
  override = repo;
}
