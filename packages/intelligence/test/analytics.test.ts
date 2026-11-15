/** Renormalisation edge cases, missing-retention-is-not-zero, time invariance, evidence badges, rules, retention. */
import { describe, expect, it } from "vitest";
import { ELS_WEIGHTS, LearningScore } from "@bnl/contracts";
import {
  NOT_ENOUGH_EVIDENCE,
  NO_STAGE_EVIDENCE,
  RETENTION_DEFAULTS,
  componentBadge,
  computeEls,
  evidenceFlags,
  formatDuration,
  localDate,
  recommendForLesson,
  retentionCutoffs,
  retentionFromEnv,
  summarizeActivity,
  validateRetention,
  type ElsInput,
  type StageResult,
} from "../src";

const L = "2f9d6c1b-8a7e-4f3d-9b2a-1c0e5d4f3a22";
const LESSON = "f95143b0-7b4c-5452-8a3f-71096a538dff";
const NEXT = "6dcc8a5d-23c4-5a87-8871-17db135101c5";
const at = new Date("2026-11-14T00:00:00Z");
const stage = (pct: number, n: number, prefix: string): StageResult => ({
  total: n,
  correct: Math.round((pct / 100) * n),
  questionKeys: Array.from({ length: n }, (_, i) => `${prefix}-${i}`),
});
const base = { learnerId: L, topicId: null, computedAt: at };
const full = (o: Partial<ElsInput> = {}): ElsInput => ({
  ...base,
  baseline: stage(40, 5, "b"),
  immediate: stage(80, 5, "i"),
  delayed: stage(60, 5, "d"),
  completion: { completedSlides: 10, assignedSlides: 10 },
  ...o,
});

describe("renormalisation edge cases", () => {
  it("weights sum to 1", () => {
    expect(Object.values(ELS_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });

  it("only M observed -> score = M, coverage 40%", () => {
    const s = computeEls({ ...base, baseline: null, immediate: stage(60, 5, "i"), delayed: null, completion: null });
    expect(s.score).toBe(60);
    expect(s.coverage_pct).toBe(40);
    expect(s.status).toBe("provisional");
  });

  it("M + R only -> (0.4M + 0.3R) / 0.7", () => {
    const s = computeEls({ ...base, baseline: null, immediate: stage(100, 5, "i"), delayed: stage(40, 5, "d"), completion: null });
    expect(s.score).toBe(Math.round(((0.4 * 100 + 0.3 * 40) / 0.7) * 100) / 100);
    expect(s.coverage_pct).toBe(70);
  });

  it("pre = 100 removes I from the maximum: coverage of M+C = 0.5/0.8 = 62.5%", () => {
    const s = computeEls({ ...base, baseline: stage(100, 5, "b"), immediate: stage(80, 5, "i"), delayed: null, completion: { completedSlides: 10, assignedSlides: 10 } });
    expect(s.components.I).toBeNull();
    expect(s.coverage_pct).toBe(62.5);
    expect(s.score).toBe(Math.round(((0.4 * 80 + 0.1 * 100) / 0.5) * 100) / 100);
    expect(s.limitation).toContain("Improvement not applicable");
  });

  it("pre = 100 and post < 100: improvement stays not applicable, not negative or 0", () => {
    const s = computeEls(full({ baseline: stage(100, 5, "b"), immediate: stage(60, 5, "i") }));
    expect(s.components.I).toBeNull();
    expect(s.score).toBe(Math.round(((0.4 * 60 + 0.3 * 60 + 0.1 * 100) / 0.8) * 100) / 100);
  });

  it("baseline without an immediate quiz -> insufficient_evidence (I needs post)", () => {
    const s = computeEls({ ...base, baseline: stage(40, 5, "b"), immediate: null, delayed: stage(80, 5, "d"), completion: null });
    expect(s.status).toBe("insufficient_evidence");
    expect(s.score).toBeNull();
    expect(s.components.I).toBeNull();
    expect(s.components.R).toBe(80);
  });

  it("zero-question stages and zero assigned slides count as not measured, not 0", () => {
    const s = computeEls({ ...base, baseline: { total: 0, correct: 0, questionKeys: [] }, immediate: stage(80, 5, "i"), delayed: { total: 0, correct: 0, questionKeys: [] }, completion: { completedSlides: 0, assignedSlides: 0 } });
    expect(s.components).toEqual({ M: 80, R: null, I: null, C: null });
    expect(s.score).toBe(80);
  });

  it("all four components observed -> exact weighted sum (no renormalisation)", () => {
    const s = computeEls(full());
    const I = (100 * (80 - 40)) / 60;
    expect(s.score).toBe(Math.round((0.4 * 80 + 0.3 * 60 + 0.2 * I + 0.1 * 100) * 100) / 100);
    expect(s.coverage_pct).toBe(100);
  });

  it("is deterministic and independent of question-key order", () => {
    const a = computeEls(full());
    const b = computeEls(full({ immediate: { ...stage(80, 5, "i"), questionKeys: [...stage(80, 5, "i").questionKeys].reverse() } }));
    expect(b).toEqual(a);
  });

  it("every output parses as the frozen LearningScore contract", () => {
    for (const o of [full(), full({ delayed: null }), full({ immediate: null }), full({ baseline: stage(100, 5, "b") })]) {
      expect(() => LearningScore.parse(computeEls(o))).not.toThrow();
    }
  });
});

describe("missing retention is insufficient evidence, never 0", () => {
  it("R missing -> R null, provisional, flagged, and scored higher than a real R = 0", () => {
    const missing = computeEls(full({ delayed: null }));
    const zero = computeEls(full({ delayed: stage(0, 5, "d") }));
    expect(missing.components.R).toBeNull();
    expect(missing.status).toBe("provisional");
    expect(missing.limitation).toContain("delayed review");
    expect(zero.components.R).toBe(0);
    expect(missing.score!).toBeGreaterThan(zero.score!);
    expect(evidenceFlags(missing, { baseline: { status: "observed", reason: null, questions: 5 }, immediate: { status: "observed", reason: null, questions: 5 }, retention: NO_STAGE_EVIDENCE })).toContain("retention_not_measured");
  });

  it("badge for a missing component says 'Not enough evidence yet', never 0%", () => {
    const b = componentBadge(null, { status: "insufficient_evidence", reason: "delayed_check_too_early", questions: 0 }, 60);
    expect(b.text).toBe(NOT_ENOUGH_EVIDENCE);
    expect(b.value).toBeNull();
    expect(b.text).not.toMatch(/0\s*%/);
    expect(b.detail).toMatch(/too soon/);
    expect(componentBadge(0, null, 60)).toMatchObject({ text: "0%", value: 0, tone: "low" });
  });
});

describe("ELS is invariant to time inputs (no_time_in_ELS, ELS-006)", () => {
  it("adding any time/visit fields to the input changes nothing", () => {
    const plain = computeEls(full());
    for (const extra of [
      { activeMs: 0, playbackMs: 0, visits: 0 },
      { activeMs: 40 * 60_000, playbackMs: 40 * 60_000, foreground_estimated_ms: 9e9, visits: 999, streakDays: 30 },
    ]) {
      expect(computeEls({ ...full(), ...extra } as ElsInput)).toEqual(plain);
    }
  });

  it("the input type has no time field (compile-time guard)", () => {
    // @ts-expect-error ELS inputs must not accept time spent
    const bad: ElsInput = { ...full(), playbackMs: 1 };
    expect(bad).toBeDefined();
  });

  it("computedAt only stamps the output; it never changes the score", () => {
    const a = computeEls(full());
    const b = computeEls(full({ computedAt: new Date("2030-01-01T00:00:00Z") }));
    expect({ ...b, computed_at: a.computed_at }).toEqual(a);
  });

  it("recommendations ignore time too (input has no time field)", () => {
    const score = computeEls(full({ delayed: null, immediate: stage(100, 5, "i") }));
    const r1 = recommendForLesson({ learnerId: L, topicId: null, lessonId: LESSON, score, reviewDue: false, nextLessonId: NEXT });
    const r2 = recommendForLesson({ learnerId: L, topicId: null, lessonId: LESSON, score, reviewDue: false, nextLessonId: NEXT, ...{ activeMs: 9e9 } } as Parameters<typeof recommendForLesson>[0]);
    expect(r2).toEqual(r1);
  });
});

describe("lesson recommendations", () => {
  const rec = (o: Partial<ElsInput>, reviewDue = false, next: string | null = NEXT) =>
    recommendForLesson({ learnerId: L, topicId: null, lessonId: LESSON, score: computeEls(full(o)), reviewDue, nextLessonId: next });

  it("no score and no review -> nothing", () => {
    expect(recommendForLesson({ learnerId: L, topicId: null, lessonId: LESSON, score: null, reviewDue: false, nextLessonId: NEXT })).toBeNull();
  });
  it("no score but a due review -> delayed_review_due for that lesson", () => {
    expect(recommendForLesson({ learnerId: L, topicId: null, lessonId: LESSON, score: null, reviewDue: true, nextLessonId: NEXT })).toMatchObject({ reason_code: "delayed_review_due", suggested_lesson_id: LESSON });
  });
  it("low retention -> review same lesson", () => expect(rec({ delayed: stage(40, 5, "d") })).toMatchObject({ reason_code: "retention_low_spaced_recall", suggested_lesson_id: LESSON }));
  it("low mastery -> re-teach same lesson", () => expect(rec({ immediate: stage(40, 5, "i"), delayed: null })).toMatchObject({ reason_code: "mastery_low_prerequisite_practice", suggested_lesson_id: LESSON }));
  it("strong -> advance to next table", () => expect(rec({ immediate: stage(100, 5, "i"), delayed: stage(100, 5, "d") })).toMatchObject({ reason_code: "ready_for_next_topic", suggested_lesson_id: NEXT }));
  it("strong on the last table -> advance with no suggested lesson", () => expect(rec({ immediate: stage(100, 5, "i"), delayed: stage(100, 5, "d") }, false, null)).toMatchObject({ reason_code: "ready_for_next_topic", suggested_lesson_id: null }));
  it("due review without retention evidence", () => expect(rec({ immediate: stage(80, 5, "i"), delayed: null }, true)).toMatchObject({ reason_code: "delayed_review_due" }));
  it("records the rule inputs for explanation", () => {
    const r = rec({ delayed: stage(40, 5, "d") })!;
    expect(r.detail.rules_version).toBe("rules-v1");
    expect(r.detail.inputs).toMatchObject({ R: 40, status: expect.any(String), review_due: false });
  });
});

describe("retention policy", () => {
  it("defaults are 90 d raw / 395 d aggregates", () => expect(RETENTION_DEFAULTS).toEqual({ rawTelemetryDays: 90, aggregateDays: 395 }));
  it("cutoffs", () => {
    const c = retentionCutoffs(new Date("2026-11-14T00:00:00Z"), RETENTION_DEFAULTS);
    expect(c.raw.toISOString()).toBe("2026-08-16T00:00:00.000Z");
    expect(c.aggregate.toISOString()).toBe("2025-10-15T00:00:00.000Z");
  });
  it("fails closed on bad values", () => {
    expect(() => validateRetention({ rawTelemetryDays: 0, aggregateDays: 10 })).toThrow(RangeError);
    expect(() => validateRetention({ rawTelemetryDays: 90, aggregateDays: 30 })).toThrow(RangeError);
    expect(() => validateRetention({ rawTelemetryDays: 7, aggregateDays: 30 })).toThrow(RangeError);
    expect(() => retentionFromEnv({ RETENTION_AGGREGATE_DAYS: "abc" })).toThrow(RangeError);
  });
  it("env overrides", () => expect(retentionFromEnv({ RETENTION_DAYS: "60", RETENTION_AGGREGATE_DAYS: "400" })).toEqual({ rawTelemetryDays: 60, aggregateDays: 400 }));
});

describe("activity context", () => {
  it("dedups days in the household timezone and keeps time separate", () => {
    const s = summarizeActivity(
      [
        { startedAt: new Date("2026-11-13T19:00:00Z"), playbackMs: 60_000, foregroundEstimatedMs: 70_000, interactionCount: 3 }, // 14 Nov 00:30 IST
        { startedAt: new Date("2026-11-14T10:00:00Z"), playbackMs: 120_000, foregroundEstimatedMs: 130_000, interactionCount: 4 },
      ],
      "Asia/Kolkata",
    );
    expect(s).toEqual({ sessions: 2, active_days: 1, last_active_date: "2026-11-14", playback_ms: 180_000, foreground_estimated_ms: 200_000, interaction_count: 7 });
    expect(localDate(new Date("2026-11-13T19:00:00Z"), "UTC")).toBe("2026-11-13");
  });
  it("formats durations", () => {
    expect(formatDuration(0)).toBe("0 min");
    expect(formatDuration(30_000)).toBe("under 1 min");
    expect(formatDuration(65 * 60_000)).toBe("1 h 5 min");
  });
});
