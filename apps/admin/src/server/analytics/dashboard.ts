/**
 * Pure assembly of the parent dashboard model (spec M11) from household-scoped rows. Scores, activity and
 * recommendations are kept in separate sections: time is context only and never feeds a score.
 */
import { REVIEW_WINDOW_DAYS } from "@bnl/assessment";
import { MULTIPLICATION_LESSON_IDS, type LearningScore } from "@bnl/contracts";
import {
  NOT_ENOUGH_EVIDENCE,
  RECOMMENDATION_TEXT,
  STATUS_TEXT,
  THRESHOLDS,
  componentBadge,
  summarizeActivity,
  type ActivitySummary,
  type ComponentBadge,
  type EvidenceFlag,
  type RecommendationCode,
} from "./intelligence";
import type { LessonRow, RecommendationRow, ReviewRow, SessionRow, SnapshotRow } from "./repo";

export interface ChildProfile {
  readonly id: string;
  readonly displayName: string;
  readonly slot: number;
  readonly grade: number;
}

export interface LessonStatusRow {
  readonly lesson_id: string;
  readonly table: number | null;
  readonly title: string;
  /** false when there is no evidence at all for this lesson yet. */
  readonly started: boolean;
  readonly status: LearningScore["status"] | "not_started";
  readonly status_text: string;
  readonly score: number | null;
  readonly mastery: ComponentBadge;
  readonly retention: ComponentBadge;
  readonly coverage_pct: number | null;
  readonly confidence_note: string;
  readonly limitation: string;
  readonly flags: EvidenceFlag[];
  readonly score_date: string | null;
  readonly review_due_at: string | null;
}

export interface RecommendationView {
  readonly id: string;
  readonly learner_id: string;
  readonly topic_id: string | null;
  readonly lesson_id: string | null;
  readonly reason_code: RecommendationCode;
  readonly suggested_lesson_id: string | null;
  readonly action: string;
  readonly why: string;
  readonly computed_at: string;
  readonly dismissed_at: string | null;
  readonly detail: Record<string, unknown>;
}

export interface DueReviewView {
  readonly review_id: string;
  readonly lesson_id: string | null;
  readonly title: string;
  readonly due_at: string;
  readonly overdue: boolean;
}

export interface ChildDashboard {
  readonly learner_id: string;
  readonly display_name: string;
  readonly slot: number;
  readonly grade: number;
  readonly tables: LessonStatusRow[];
  readonly other_lessons: LessonStatusRow[];
  readonly topic_scores: LearningScore[];
  readonly activity: ActivitySummary & { readonly from: string; readonly to: string; readonly note: string };
  readonly recommendations: RecommendationView[];
  readonly due_reviews: DueReviewView[];
}

export interface Dashboard {
  readonly generated_at: string;
  readonly timezone: string;
  /** Newest score date across the household; null before the first scoring run. */
  readonly scores_as_of: string | null;
  readonly children: ChildDashboard[];
  readonly notes: { readonly time: string; readonly evidence: string; readonly causality: string };
}

export const TIME_NOTE = "Estimated active playback is shown for context only. It is not part of any score, and more time is not the goal.";
export const EVIDENCE_NOTE = `“${NOT_ENOUGH_EVIDENCE}” means nothing has been measured yet. It is not a score of zero.`;
export const CAUSALITY_NOTE = "Scores summarise quiz answers. They do not show cause and effect, and small numbers of questions give rough estimates.";

const TABLE_BY_LESSON = new Map(Object.entries(MULTIPLICATION_LESSON_IDS).map(([t, id]) => [id, Number(t)]));
export const tableOf = (lessonId: string | null) => (lessonId === null ? null : (TABLE_BY_LESSON.get(lessonId) ?? null));

function lessonTitle(lessonId: string | null, lessons: ReadonlyMap<string, LessonRow>): string {
  if (lessonId === null) return "All lessons";
  const t = tableOf(lessonId);
  if (t !== null) return `×${t} table`;
  return lessons.get(lessonId)?.title ?? "Lesson";
}

function statusRow(lessonId: string, snap: SnapshotRow | undefined, lessons: ReadonlyMap<string, LessonRow>, review: ReviewRow | undefined): LessonStatusRow {
  const base = { lesson_id: lessonId, table: tableOf(lessonId), title: lessonTitle(lessonId, lessons), review_due_at: review ? review.dueAt.toISOString() : null };
  if (!snap) {
    const none = componentBadge(null, null, 0);
    return {
      ...base, started: false, status: "not_started", status_text: "Not started yet", score: null,
      mastery: { ...none, detail: "Not started yet" }, retention: { ...none, detail: "Not started yet" },
      coverage_pct: null, confidence_note: "", limitation: "", flags: [], score_date: null,
    };
  }
  const s = snap.score;
  const stages = snap.evidence?.stages ?? null;
  return {
    ...base,
    started: true,
    status: s.status,
    status_text: STATUS_TEXT[s.status],
    score: s.score,
    mastery: componentBadge(s.components.M, stages?.immediate ?? null, THRESHOLDS.masteryLow),
    retention: componentBadge(s.components.R, stages?.retention ?? null, THRESHOLDS.retentionLow),
    coverage_pct: s.coverage_pct,
    confidence_note: s.confidence_note,
    limitation: s.limitation,
    flags: snap.evidence?.flags ?? [],
    score_date: snap.scoreDate,
  };
}

const DAY = 86_400_000;

export function buildDashboard(p: {
  now: Date;
  timezone: string;
  children: readonly ChildProfile[];
  snapshots: readonly SnapshotRow[];
  sessions: readonly SessionRow[];
  reviews: readonly ReviewRow[];
  recommendations: readonly RecommendationRow[];
  lessons: readonly LessonRow[];
  activityFrom: Date;
  activityTo: Date;
}): Dashboard {
  const lessons = new Map(p.lessons.map((l) => [l.id, l]));
  const tableIds = Object.keys(MULTIPLICATION_LESSON_IDS).map(Number).sort((a, b) => a - b).flatMap((t) => MULTIPLICATION_LESSON_IDS[t] ?? []);
  const children = [...p.children].sort((a, b) => a.slot - b.slot).map((child): ChildDashboard => {
    const snaps = p.snapshots.filter((s) => s.learnerId === child.id);
    const lessonSnap = new Map(snaps.filter((s) => s.lessonId !== null).map((s) => [s.lessonId as string, s]));
    const reviews = p.reviews.filter((r) => r.learnerId === child.id);
    const reviewFor = (lessonId: string) => reviews.find((r) => r.lessonId === lessonId);
    const others = [...lessonSnap.keys()].filter((id) => tableOf(id) === null).sort((a, b) => (lessons.get(a)?.sortOrder ?? 0) - (lessons.get(b)?.sortOrder ?? 0) || a.localeCompare(b));
    const recs = p.recommendations
      .filter((r) => r.learnerId === child.id)
      .map((r): RecommendationView => {
        const code = r.reasonCode as RecommendationCode;
        const text = RECOMMENDATION_TEXT[code] ?? { action: "Suggestion", why: "" };
        const name = lessonTitle(r.lessonId, lessons);
        return {
          id: r.id, learner_id: r.learnerId, topic_id: r.topicId, lesson_id: r.lessonId, reason_code: code, suggested_lesson_id: r.suggestedLessonId,
          action: text.action.replace("{lesson}", name), why: text.why, computed_at: r.computedAt.toISOString(),
          dismissed_at: r.dismissedAt === null ? null : r.dismissedAt.toISOString(), detail: r.detail,
        };
      })
      .sort((a, b) => Number(a.dismissed_at !== null) - Number(b.dismissed_at !== null) || (tableOf(a.lesson_id) ?? 99) - (tableOf(b.lesson_id) ?? 99) || a.id.localeCompare(b.id));
    return {
      learner_id: child.id,
      display_name: child.displayName,
      slot: child.slot,
      grade: child.grade,
      tables: tableIds.map((id) => statusRow(id, lessonSnap.get(id), lessons, reviewFor(id))),
      other_lessons: others.map((id) => statusRow(id, lessonSnap.get(id), lessons, reviewFor(id))),
      topic_scores: snaps.filter((s) => s.lessonId === null).map((s) => s.score),
      activity: {
        ...summarizeActivity(p.sessions.filter((s) => s.learnerId === child.id), p.timezone),
        from: p.activityFrom.toISOString(),
        to: p.activityTo.toISOString(),
        note: TIME_NOTE,
      },
      recommendations: recs,
      due_reviews: reviews
        .filter((r) => r.dueAt.getTime() <= p.now.getTime())
        .map((r) => ({
          review_id: r.id, lesson_id: r.lessonId, title: lessonTitle(r.lessonId, lessons), due_at: r.dueAt.toISOString(),
          overdue: p.now.getTime() > r.dueAt.getTime() + REVIEW_WINDOW_DAYS * DAY,
        })),
    };
  });
  const dates = p.snapshots.map((s) => s.scoreDate).sort();
  return {
    generated_at: p.now.toISOString(),
    timezone: p.timezone,
    scores_as_of: dates.at(-1) ?? null,
    children,
    notes: { time: TIME_NOTE, evidence: EVIDENCE_NOTE, causality: CAUSALITY_NOTE },
  };
}
