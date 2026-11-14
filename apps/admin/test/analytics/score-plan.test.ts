/** Pure scoring plan: as-of determinism, absence ≠ zero, time invariance, completion, recommendations. */
import { describe, expect, it } from "vitest";
import type { AttemptEvidence } from "@bnl/assessment";
import { MULTIPLICATION_LESSON_IDS, MULTIPLICATION_TOPIC_ID } from "@bnl/contracts";
import { buildDashboard } from "../../src/server/analytics/dashboard";
import { asOfInstant, runKeyFor } from "../../src/server/analytics/score-job";
import { evidenceAsOf, lessonCompletion, planLearner, type LearnerScoringData, type ProgressEvidence } from "../../src/server/analytics/score-plan";

const L = "c1000000-0000-4000-8000-0000000000a1";
const HH = "a0000000-0000-4000-8000-00000000000a";
const T3 = MULTIPLICATION_LESSON_IDS[3]!;
const T4 = MULTIPLICATION_LESSON_IDS[4]!;
const D = (s: string) => new Date(s);
const DAY = 86_400_000;

function attempt(stage: AttemptEvidence["stage"], startedAt: string, facts: number[], correct: number, lessonId = T3): AttemptEvidence {
  const t = D(startedAt);
  const keys = facts.map((f) => `grade2.math.multiplication.table-3.fact-${f}.v1`);
  return {
    attemptId: `${stage}-${startedAt}`, lessonId, topicId: MULTIPLICATION_TOPIC_ID, stage, startedAt: t, finishedAt: new Date(t.getTime() + 60_000), questionKeys: keys,
    responses: keys.map((k, i) => ({ questionVersionKey: k, correct: i < correct, answeredAt: new Date(t.getTime() + 10_000 * (i + 1)) })),
  };
}
const progress = (o: Partial<ProgressEvidence> = {}): ProgressEvidence => ({
  lessonId: T3, completed: true, completedAt: D("2026-11-01T10:05:00Z"), slideIndex: 10, createdAt: D("2026-11-01T10:00:00Z"), updatedAt: D("2026-11-01T10:05:00Z"), assignedSlides: 10, ...o,
});
const data = (o: Partial<LearnerScoringData> = {}): LearnerScoringData => ({
  learnerId: L, householdId: HH, timezone: "Asia/Kolkata",
  attempts: [attempt("immediate", "2026-11-01T10:06:00Z", [1, 2, 3], 3)],
  exposureByLesson: new Map([[T3, D("2026-11-01T10:00:00Z")]]),
  progress: [progress()],
  openReviews: [],
  lessons: new Map([[T3, { topicId: MULTIPLICATION_TOPIC_ID, nextLessonId: T4 }], [T4, { topicId: MULTIPLICATION_TOPIC_ID, nextLessonId: null }]]),
  ...o,
});
const AS_OF = asOfInstant("2026-11-14");

describe("planLearner", () => {
  it("writes one lesson row and one topic row; missing retention is null + flagged, never 0", () => {
    const p = planLearner(data(), AS_OF);
    expect(p.snapshots.map((s) => s.lessonId)).toEqual([null, T3]);
    const lesson = p.snapshots.find((s) => s.lessonId === T3)!;
    expect(lesson.score.components).toMatchObject({ M: 100, R: null, C: 100 });
    expect(lesson.score.status).toBe("provisional");
    expect(lesson.evidence.flags).toEqual(expect.arrayContaining(["provisional", "retention_not_measured", "low_confidence"]));
    expect(lesson.evidence.stages.retention).toEqual({ status: "insufficient_evidence", reason: "no_attempt", questions: 0 });
    expect(lesson.score.computed_at).toBe("2026-11-14T23:59:59.999Z");
  });

  it("a too-early delayed check stays insufficient_evidence (reason recorded), not R = 0", () => {
    const p = planLearner(data({ attempts: [attempt("immediate", "2026-11-01T10:06:00Z", [1, 2, 3], 3), attempt("delayed", "2026-11-02T10:00:00Z", [7, 8, 9], 0)] }), AS_OF);
    const lesson = p.snapshots.find((s) => s.lessonId === T3)!;
    expect(lesson.score.components.R).toBeNull();
    expect(lesson.evidence.stages.retention.reason).toBe("delayed_check_too_early");
  });

  it("a valid delayed check measures R, and low R recommends spaced recall on that lesson", () => {
    const p = planLearner(data({ attempts: [attempt("immediate", "2026-11-01T10:06:00Z", [1, 2, 3], 3), attempt("delayed", "2026-11-05T10:00:00Z", [7, 8, 9], 1)] }), AS_OF);
    expect(p.snapshots.find((s) => s.lessonId === T3)!.score.components.R).toBeCloseTo(33.33, 1);
    expect(p.recommendations).toEqual([expect.objectContaining({ lesson_id: T3, reason_code: "retention_low_spaced_recall", suggested_lesson_id: T3 })]);
  });

  it("is deterministic and ignores evidence after the as-of instant", () => {
    const later = attempt("delayed", "2026-11-20T10:00:00Z", [7, 8, 9], 0);
    const a = planLearner(data(), AS_OF);
    const b = planLearner(data({ attempts: [...data().attempts, later], progress: [progress(), progress({ lessonId: T4, createdAt: D("2026-11-20T00:00:00Z") })] }), AS_OF);
    expect(b).toEqual(a);
    expect(planLearner(data(), AS_OF)).toEqual(a);
  });

  it("progress without quiz -> insufficient_evidence row (completion recorded, no score) and a take-quiz nudge", () => {
    const p = planLearner(data({ attempts: [], progress: [progress({ lessonId: T4, completed: false, completedAt: null, slideIndex: 6 })] }), AS_OF);
    const t4 = p.snapshots.find((s) => s.lessonId === T4)!;
    expect(t4.score).toMatchObject({ status: "insufficient_evidence", score: null, components: { C: 50, M: null } });
    expect(p.recommendations).toEqual([expect.objectContaining({ lesson_id: T4, reason_code: "insufficient_evidence_take_quiz" })]);
  });

  it("strong evidence advances to the next table", () => {
    const p = planLearner(data({ attempts: [attempt("immediate", "2026-11-01T10:06:00Z", [1, 2, 3, 4, 5], 5), attempt("delayed", "2026-11-05T10:00:00Z", [6, 7, 8, 9, 10], 5)] }), AS_OF);
    expect(p.recommendations).toEqual([expect.objectContaining({ reason_code: "ready_for_next_topic", suggested_lesson_id: T4 })]);
  });

  it("a due review on an unscored lesson yields delayed_review_due; a future one does not", () => {
    const due = planLearner(data({ attempts: [], progress: [], openReviews: [{ lessonId: T4, dueAt: D("2026-11-10T18:30:00Z") }] }), AS_OF);
    expect(due.recommendations).toEqual([expect.objectContaining({ lesson_id: T4, reason_code: "delayed_review_due" })]);
    const future = planLearner(data({ attempts: [], progress: [], openReviews: [{ lessonId: T4, dueAt: D("2026-11-20T18:30:00Z") }] }), AS_OF);
    expect(future.recommendations).toEqual([]);
  });
});

describe("no_time_in_ELS: scores and recommendations do not depend on time spent", () => {
  it("the scoring input has no session/time data; dashboard scores are identical for any activity", () => {
    const plan = planLearner(data(), AS_OF);
    const snapshots = plan.snapshots.map((s) => ({ learnerId: s.learnerId, topicId: s.topicId, lessonId: s.lessonId, scoreDate: "2026-11-14", score: s.score, evidence: s.evidence }));
    const view = (minutes: number) =>
      buildDashboard({
        now: D("2026-11-15T06:00:00Z"), timezone: "Asia/Kolkata", children: [{ id: L, displayName: "Kid", slot: 1, grade: 2 }], snapshots, reviews: [], recommendations: [], lessons: [],
        sessions: Array.from({ length: minutes ? 5 : 0 }, (_, i) => ({ learnerId: L, startedAt: new Date(D("2026-11-10T10:00:00Z").getTime() + i * DAY), playbackMs: minutes * 60_000, foregroundEstimatedMs: minutes * 60_000, interactionCount: 0 })),
        activityFrom: D("2026-11-01T00:00:00Z"), activityTo: D("2026-11-15T00:00:00Z"),
      });
    const none = view(0);
    const lots = view(40);
    expect(lots.children[0]!.tables).toEqual(none.children[0]!.tables);
    expect(lots.children[0]!.topic_scores).toEqual(none.children[0]!.topic_scores);
    expect(lots.children[0]!.activity.playback_ms).toBe(5 * 40 * 60_000);
  });
});

describe("helpers", () => {
  it("lessonCompletion: completed → full; partial → step N−1; unknown → null (not 0)", () => {
    expect(lessonCompletion([progress()], AS_OF)).toEqual({ completedSlides: 10, assignedSlides: 10 });
    expect(lessonCompletion([progress({ completed: false, completedAt: null, slideIndex: 4 })], AS_OF)).toEqual({ completedSlides: 3, assignedSlides: 10 });
    expect(lessonCompletion([progress({ assignedSlides: null })], AS_OF)).toBeNull();
    expect(lessonCompletion([progress({ completed: false, completedAt: null, updatedAt: D("2026-12-01T00:00:00Z") })], AS_OF)).toBeNull();
  });
  it("evidenceAsOf drops later answers and later finishes", () => {
    const a = attempt("immediate", "2026-11-14T23:59:45Z", [1, 2, 3], 3);
    const [cut] = evidenceAsOf([a, attempt("immediate", "2026-11-15T00:00:01Z", [4], 1)], AS_OF);
    expect(cut!.finishedAt).toBeNull();
    expect(cut!.responses).toHaveLength(1);
    expect(evidenceAsOf([a], AS_OF)).toHaveLength(1);
  });
  it("asOfInstant / run key", () => {
    expect(asOfInstant("2026-11-14").toISOString()).toBe("2026-11-14T23:59:59.999Z");
    expect(() => asOfInstant("2026-02-30")).toThrow();
    expect(runKeyFor("2026-11-14")).toBe("els:els-v1:2026-11-14");
  });
});
