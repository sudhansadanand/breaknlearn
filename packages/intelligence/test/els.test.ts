import { describe, expect, it } from "vitest";
import { LearningScore } from "@bnl/contracts";
import { computeEls, recommend, type StageResult } from "../src";

const L = "2f9d6c1b-8a7e-4f3d-9b2a-1c0e5d4f3a22";
const at = new Date("2026-11-14T00:00:00Z");
/** Stage with `pct`% correct over `n` distinct questions (prefix keeps keys distinct across stages). */
const stage = (pct: number, n: number, prefix: string): StageResult => ({
  total: n,
  correct: Math.round((pct / 100) * n),
  questionKeys: Array.from({ length: n }, (_, i) => `${prefix}-${i}`),
});
const base = { learnerId: L, topicId: null, computedAt: at };

describe("ELS fixtures from the acceptance matrix", () => {
  it("ELS-001: pre 40, post 90, delayed 80, completion 100 -> I 83.33, ELS 86.67", () => {
    const s = computeEls({ ...base, baseline: stage(40, 5, "b"), immediate: stage(90, 10, "i"), delayed: stage(80, 5, "d"), completion: { completedSlides: 10, assignedSlides: 10 } });
    expect(s.components.I).toBe(83.33);
    expect(s.score).toBe(86.67);
    expect(s.coverage_pct).toBe(100);
    expect(s.status).toBe("evidence_sufficient");
    expect(LearningScore.parse(s)).toBeTruthy();
  });

  it("ELS-002: no baseline, no delayed, post 80, completion 100 -> provisional 84, coverage 50%", () => {
    const s = computeEls({ ...base, baseline: null, immediate: stage(80, 5, "i"), delayed: null, completion: { completedSlides: 10, assignedSlides: 10 } });
    expect(s.score).toBe(84);
    expect(s.coverage_pct).toBe(50);
    expect(s.status).toBe("provisional");
    expect(s.limitation).toContain("delayed review");
  });

  it("ELS-003: pre 100, post 100 -> improvement excluded, no division by zero", () => {
    const s = computeEls({ ...base, baseline: stage(100, 5, "b"), immediate: stage(100, 5, "i"), delayed: stage(100, 5, "d"), completion: { completedSlides: 10, assignedSlides: 10 } });
    expect(s.components.I).toBeNull();
    expect(s.score).toBe(100);
    expect(Number.isFinite(s.score)).toBe(true);
    expect(s.coverage_pct).toBe(100); // I is not applicable, so it is not part of the maximum
    expect(s.status).toBe("evidence_sufficient");
  });

  it("ELS-004: no immediate quiz -> insufficient_evidence, null score", () => {
    const s = computeEls({ ...base, baseline: null, immediate: null, delayed: null, completion: { completedSlides: 10, assignedSlides: 10 } });
    expect(s.status).toBe("insufficient_evidence");
    expect(s.score).toBeNull();
    expect(s.components.C).toBe(100);
  });

  it("ELS-005: fewer than 5 distinct questions -> low confidence and provisional even at 100%", () => {
    const s = computeEls({ ...base, baseline: stage(0, 1, "b"), immediate: stage(100, 3, "i"), delayed: null, completion: { completedSlides: 10, assignedSlides: 10 } });
    expect(s.confidence).toBe("low");
    expect(s.status).toBe("provisional");
    expect(s.questions_count).toBe(4);
  });

  it("ELS-006: passive autoplay with no answers does not create or raise a score", () => {
    const watchedOnly = computeEls({ ...base, baseline: null, immediate: null, delayed: null, completion: { completedSlides: 10, assignedSlides: 10 } });
    expect(watchedOnly.score).toBeNull();
    const withQuiz = computeEls({ ...base, baseline: null, immediate: stage(60, 5, "i"), delayed: null, completion: { completedSlides: 2, assignedSlides: 10 } });
    const moreWatching = computeEls({ ...base, baseline: null, immediate: stage(60, 5, "i"), delayed: null, completion: { completedSlides: 2, assignedSlides: 10 } });
    expect(moreWatching.score).toBe(withQuiz.score); // no time input exists at all
  });

  it("missing evidence is not zero: a low-evidence score is labelled, not penalised", () => {
    const partial = computeEls({ ...base, baseline: null, immediate: stage(80, 5, "i"), delayed: null, completion: null });
    expect(partial.score).toBe(80);
    expect(partial.coverage_pct).toBe(40);
  });

  it("post below pre gives improvement 0, never negative", () => {
    const s = computeEls({ ...base, baseline: stage(80, 5, "b"), immediate: stage(60, 5, "i"), delayed: null, completion: null });
    expect(s.components.I).toBe(0);
  });

  it("rejects impossible counts instead of scoring them", () => {
    expect(() => computeEls({ ...base, baseline: null, immediate: { total: 3, correct: 4, questionKeys: [] }, delayed: null, completion: null })).toThrow(RangeError);
    expect(() => computeEls({ ...base, baseline: null, immediate: null, delayed: null, completion: { completedSlides: 11, assignedSlides: 10 } })).toThrow(RangeError);
  });

  it("property: score always within 0..100 and equals the weighted mean of observed components", () => {
    for (let pre = 0; pre <= 100; pre += 20)
      for (let post = 0; post <= 100; post += 20)
        for (const delayed of [null, 0, 40, 100]) {
          const s = computeEls({ ...base, baseline: stage(pre, 5, "b"), immediate: stage(post, 5, "i"), delayed: delayed === null ? null : stage(delayed, 5, "d"), completion: { completedSlides: 5, assignedSlides: 10 } });
          expect(s.score).not.toBeNull();
          expect(s.score!).toBeGreaterThanOrEqual(0);
          expect(s.score!).toBeLessThanOrEqual(100);
        }
  });
});

describe("recommendation rules", () => {
  const score = (M: number | null, R: number | null, C: number | null) =>
    computeEls({ ...base, baseline: null, immediate: M === null ? null : stage(M, 5, "i"), delayed: R === null ? null : stage(R, 5, "d"), completion: C === null ? null : { completedSlides: C / 10, assignedSlides: 10 } });
  it("no quiz -> take quiz", () => expect(recommend(score(null, null, 100))).toBe("insufficient_evidence_take_quiz"));
  it("low retention -> spaced recall", () => expect(recommend(score(100, 40, 100))).toBe("retention_low_spaced_recall"));
  it("low mastery -> visual practice", () => expect(recommend(score(40, null, 100))).toBe("mastery_low_prerequisite_practice"));
  it("due review surfaces when no delayed result yet", () => expect(recommend(score(80, null, 100), { delayedReviewDue: true })).toBe("delayed_review_due"));
  it("strong -> next topic", () => expect(recommend(score(100, 100, 100))).toBe("ready_for_next_topic"));
  it("middling -> no nudge", () => expect(recommend(score(60, null, 50))).toBeNull());
});
