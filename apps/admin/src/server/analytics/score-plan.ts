/**
 * Pure scoring plan for one learner (A8, spec M10): evidence → ELS snapshots (per lesson and per topic) and
 * explainable recommendations. Deterministic for a given as-of instant: evidence created after `asOf` is
 * ignored, so a re-run for the same day yields identical rows. Time spent / visits are not inputs.
 */
import { buildElsInputs, type AttemptEvidence, type StageEvidence } from "@bnl/assessment";
import type { LearningScore } from "@bnl/contracts";
import {
  NO_STAGE_EVIDENCE,
  computeEls,
  evidenceRecord,
  recommendForLesson,
  type ElsInput,
  type EvidenceRecord,
  type LessonRecommendation,
  type ScoreEvidence,
} from "./intelligence";

export interface ProgressEvidence {
  readonly lessonId: string;
  readonly completed: boolean;
  readonly completedAt: Date | null;
  /** N from slide_id "step-N" (0 when unknown). Reaching step N means N−1 slides were completed. */
  readonly slideIndex: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** Slides in the lesson version; null when the template has no countable slides. */
  readonly assignedSlides: number | null;
}

export interface LessonInfo {
  readonly topicId: string | null;
  /** Next live lesson in the same topic by sort order (×3 → ×4); null at the end. */
  readonly nextLessonId: string | null;
}

export interface LearnerScoringData {
  readonly learnerId: string;
  readonly householdId: string;
  readonly timezone: string;
  readonly attempts: readonly AttemptEvidence[];
  readonly exposureByLesson: ReadonlyMap<string, Date>;
  readonly progress: readonly ProgressEvidence[];
  /** Open ('due') reviews: lesson and due instant. */
  readonly openReviews: readonly { readonly lessonId: string | null; readonly dueAt: Date }[];
  readonly lessons: ReadonlyMap<string, LessonInfo>;
}

export interface SnapshotPlan {
  readonly householdId: string;
  readonly learnerId: string;
  readonly topicId: string | null;
  /** null = topic-level row. */
  readonly lessonId: string | null;
  readonly score: LearningScore;
  readonly evidence: EvidenceRecord;
}

export interface LearnerPlan {
  readonly snapshots: SnapshotPlan[];
  readonly recommendations: LessonRecommendation[];
}

type Completion = { completedSlides: number; assignedSlides: number };

/** Only evidence that existed at `asOf`. */
export function evidenceAsOf(attempts: readonly AttemptEvidence[], asOf: Date): AttemptEvidence[] {
  const t = asOf.getTime();
  return attempts
    .filter((a) => a.startedAt.getTime() <= t)
    .map((a) => ({
      ...a,
      finishedAt: a.finishedAt !== null && a.finishedAt.getTime() <= t ? a.finishedAt : null,
      responses: a.responses.filter((r) => r.answeredAt.getTime() <= t),
    }));
}

/** Verified completion for one lesson at `asOf`; null when unknown (never 0 for "unknown"). */
export function lessonCompletion(rows: readonly ProgressEvidence[], asOf: Date): Completion | null {
  const t = asOf.getTime();
  const known = rows.filter((r) => r.assignedSlides !== null && r.assignedSlides > 0 && r.createdAt.getTime() <= t);
  let best: Completion | null = null;
  for (const r of known) {
    const assigned = r.assignedSlides as number;
    let done: number | null = null;
    if (r.completed && r.completedAt !== null && r.completedAt.getTime() <= t) done = assigned;
    else if (r.updatedAt.getTime() <= t) done = Math.min(assigned, Math.max(0, r.slideIndex - 1));
    if (done === null) continue;
    if (!best || done / assigned > best.completedSlides / best.assignedSlides) best = { completedSlides: done, assignedSlides: assigned };
  }
  return best;
}

const toScoreEvidence = (e: { baseline: StageEvidence; immediate: StageEvidence; retention: StageEvidence } | null): ScoreEvidence =>
  e ?? { baseline: NO_STAGE_EVIDENCE, immediate: NO_STAGE_EVIDENCE, retention: NO_STAGE_EVIDENCE };

const emptyInput = (learnerId: string, topicId: string | null, completion: Completion | null, asOf: Date): ElsInput => ({
  learnerId, topicId, baseline: null, immediate: null, delayed: null, completion, computedAt: asOf,
});

const sortKey = (topic: string | null, lesson: string | null) => `${topic ?? ""}|${lesson ?? ""}`;

export function planLearner(d: LearnerScoringData, asOf: Date): LearnerPlan {
  const attempts = evidenceAsOf(d.attempts, asOf);
  const exposure = new Map([...d.exposureByLesson].filter(([, at]) => at.getTime() <= asOf.getTime()));
  const topicOf = (lessonId: string) => d.lessons.get(lessonId)?.topicId ?? attempts.find((a) => a.lessonId === lessonId)?.topicId ?? null;

  const progressByLesson = new Map<string, ProgressEvidence[]>();
  for (const p of d.progress) if (p.createdAt.getTime() <= asOf.getTime()) progressByLesson.set(p.lessonId, [...(progressByLesson.get(p.lessonId) ?? []), p]);
  const completionByLesson = new Map<string, Completion>();
  for (const [lessonId, rows] of progressByLesson) {
    const c = lessonCompletion(rows, asOf);
    if (c) completionByLesson.set(lessonId, c);
  }

  const lessonIds = [...new Set([...attempts.map((a) => a.lessonId), ...progressByLesson.keys()])].sort();
  const snapshots: SnapshotPlan[] = [];

  // Lesson-level rows.
  for (const lessonId of lessonIds) {
    const topicId = topicOf(lessonId);
    const own = attempts.filter((a) => a.lessonId === lessonId).map((a) => ({ ...a, topicId }));
    const completion = completionByLesson.get(lessonId) ?? null;
    const [els] = own.length
      ? buildElsInputs({ learnerId: d.learnerId, attempts: own, now: asOf, timezone: d.timezone, exposureByLesson: exposure, completionByTopic: new Map(completion ? [[topicId, completion]] : []) })
      : [];
    const score = computeEls(els?.input ?? emptyInput(d.learnerId, topicId, completion, asOf));
    snapshots.push({ householdId: d.householdId, learnerId: d.learnerId, topicId, lessonId, score, evidence: evidenceRecord(score, toScoreEvidence(els?.evidence ?? null), [lessonId]) });
  }

  // Topic-level rows (lesson_id null): all lessons of the topic pooled.
  const topics = [...new Set(lessonIds.map(topicOf))];
  for (const topicId of topics) {
    const inTopic = lessonIds.filter((l) => topicOf(l) === topicId);
    const comps = inTopic.map((l) => completionByLesson.get(l)).filter((c): c is Completion => c !== undefined);
    const completion = comps.length ? { completedSlides: comps.reduce((s, c) => s + c.completedSlides, 0), assignedSlides: comps.reduce((s, c) => s + c.assignedSlides, 0) } : null;
    const own = attempts.filter((a) => inTopic.includes(a.lessonId)).map((a) => ({ ...a, topicId }));
    const [els] = own.length
      ? buildElsInputs({ learnerId: d.learnerId, attempts: own, now: asOf, timezone: d.timezone, exposureByLesson: exposure, completionByTopic: new Map(completion ? [[topicId, completion]] : []) })
      : [];
    const score = computeEls(els?.input ?? emptyInput(d.learnerId, topicId, completion, asOf));
    snapshots.push({ householdId: d.householdId, learnerId: d.learnerId, topicId, lessonId: null, score, evidence: evidenceRecord(score, toScoreEvidence(els?.evidence ?? null), inTopic) });
  }
  snapshots.sort((a, b) => sortKey(a.topicId, a.lessonId).localeCompare(sortKey(b.topicId, b.lessonId)));

  // Recommendations: one per lesson at most, from evidence and due reviews only.
  const dueLessons = new Set(d.openReviews.filter((r) => r.lessonId !== null && r.dueAt.getTime() <= asOf.getTime()).map((r) => r.lessonId as string));
  const recLessons = [...new Set([...lessonIds, ...dueLessons])].sort();
  const recommendations: LessonRecommendation[] = [];
  for (const lessonId of recLessons) {
    const snap = snapshots.find((s) => s.lessonId === lessonId) ?? null;
    const r = recommendForLesson({
      learnerId: d.learnerId,
      topicId: topicOf(lessonId),
      lessonId,
      score: snap?.score ?? null,
      reviewDue: dueLessons.has(lessonId),
      nextLessonId: d.lessons.get(lessonId)?.nextLessonId ?? null,
    });
    if (r) recommendations.push(r);
  }
  return { snapshots, recommendations };
}
