import { describe, expect, it } from "vitest";
import { LearningScore } from "@bnl/contracts";
import { computeEls } from "@bnl/intelligence";
import {
  ANSWER_WINDOW_MS,
  buildElsInputs,
  dueReviews,
  localDate,
  nextReview,
  passedDelayedStreak,
  safeTimezone,
  startOfLocalDay,
  type AttemptEvidence,
  type Stage,
} from "../src";

const IST = "Asia/Kolkata";
const LEARNER_ID = "c1000000-0000-4000-8000-0000000000a1";
const DAY = 86_400_000;

describe("review scheduler", () => {
  it("due dates fall at local midnight in the household timezone (default Asia/Kolkata)", () => {
    // 2026-11-14 20:00 UTC is 2026-11-15 01:30 IST → +3 local days = 2026-11-18 00:00 IST = 2026-11-17 18:30 UTC.
    const finished = new Date("2026-11-14T20:00:00Z");
    const plan = nextReview({ stage: "immediate", finishedAt: finished, answered: 3, correct: 2, passedDelayedStreak: 0, timezone: IST })!;
    expect(plan.dueAt.toISOString()).toBe("2026-11-17T18:30:00.000Z");
    expect(plan.intervalDays).toBe(3);
    // Window covers local days +3..+7 → ends at 2026-11-23 00:00 IST.
    expect(plan.windowEndsAt.toISOString()).toBe("2026-11-22T18:30:00.000Z");
    expect(localDate(plan.dueAt, IST)).toBe("2026-11-18");
  });

  it("handles DST zones and unknown zones fall back to the default", () => {
    // America/New_York leaves DST on 2026-11-01: midnight of 2026-11-02 is 05:00 UTC, of 2026-10-31 is 04:00 UTC.
    expect(startOfLocalDay(new Date("2026-10-30T12:00:00Z"), 3, "America/New_York").toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(startOfLocalDay(new Date("2026-10-30T12:00:00Z"), 1, "America/New_York").toISOString()).toBe("2026-10-31T04:00:00.000Z");
    expect(safeTimezone("Not/AZone")).toBe(IST);
    expect(safeTimezone(null)).toBe(IST);
    expect(startOfLocalDay(new Date("2026-11-14T20:00:00Z"), 3, "Not/AZone").toISOString()).toBe("2026-11-17T18:30:00.000Z");
  });

  it("baseline and unanswered attempts schedule nothing; the delayed ladder climbs on a pass and resets on a miss", () => {
    const at = new Date("2026-11-14T06:00:00Z");
    const base = { finishedAt: at, timezone: IST, passedDelayedStreak: 0 };
    expect(nextReview({ ...base, stage: "baseline", answered: 3, correct: 3 })).toBeNull();
    expect(nextReview({ ...base, stage: "immediate", answered: 0, correct: 0 })).toBeNull();
    expect(nextReview({ ...base, stage: "delayed", answered: 3, correct: 3 })!.intervalDays).toBe(7);
    expect(nextReview({ ...base, stage: "delayed", answered: 3, correct: 3, passedDelayedStreak: 1 })!.intervalDays).toBe(14);
    expect(nextReview({ ...base, stage: "delayed", answered: 3, correct: 3, passedDelayedStreak: 9 })!.intervalDays).toBe(30);
    expect(nextReview({ ...base, stage: "delayed", answered: 3, correct: 1, passedDelayedStreak: 2 })!.intervalDays).toBe(3);
    expect(passedDelayedStreak([
      { finishedAt: new Date(3), answered: 3, correct: 3 },
      { finishedAt: new Date(2), answered: 3, correct: 3 },
      { finishedAt: new Date(1), answered: 3, correct: 0 },
    ])).toBe(2);
  });

  it("lists due reviews oldest first with window and overdue flags, plus the next future date", () => {
    const now = new Date("2026-11-30T00:00:00Z");
    const r = (id: string, due: string, status: "due" | "completed" | "dismissed" = "due") =>
      ({ id, lessonId: "L", topicId: null, sourceAttemptId: null, dueAt: new Date(due), status });
    const out = dueReviews([r("b", "2026-11-29T18:30:00Z"), r("a", "2026-11-10T18:30:00Z"), r("c", "2026-12-05T18:30:00Z"), r("d", "2026-11-01T00:00:00Z", "completed")], now, IST);
    expect(out.items.map((i) => [i.review_id, i.overdue])).toEqual([["a", true], ["b", false]]);
    expect(out.next_due_at).toBe("2026-12-05T18:30:00.000Z");
  });
});

// ---------------------------------------------------------------------------
const NOW = new Date("2026-11-30T12:00:00Z");
const LESSON = "f95143b0-7b4c-5452-8a3f-71096a538dff";
const TOPIC = "58be84d6-b23e-5332-80a7-f7460dd3933f";
let n = 0;
function attempt(stage: Stage, startedAt: Date, answers: [string, boolean][], o: Partial<AttemptEvidence> = {}): AttemptEvidence {
  n++;
  return {
    attemptId: `att-${n}`,
    lessonId: LESSON,
    topicId: TOPIC,
    stage,
    startedAt,
    finishedAt: new Date(startedAt.getTime() + 60_000),
    questionKeys: answers.map(([k]) => k),
    responses: answers.map(([k, c], i) => ({ questionVersionKey: k, correct: c, answeredAt: new Date(startedAt.getTime() + (i + 1) * 1000) })),
    ...o,
  };
}
const k = (m: number, v = 1) => `grade2.math.multiplication.table-3.fact-${m}.v${v}`;
const day = (d: number, h = 6) => new Date(Date.UTC(2026, 10, d, h));

describe("ELS input adapter", () => {
  it("missing delayed check ⇒ retention insufficient_evidence, R null, never 0 (and score is not lowered)", () => {
    const [t] = buildElsInputs({
      learnerId: LEARNER_ID,
      now: NOW,
      attempts: [attempt("immediate", day(14), [[k(1), true], [k(2), true], [k(3), false]])],
    });
    expect(t!.input.delayed).toBeNull();
    expect(t!.evidence.retention).toEqual({ status: "insufficient_evidence", reason: "no_attempt", questions: 0 });
    expect(t!.evidence.baseline.reason).toBe("no_attempt");
    const s = computeEls(t!.input);
    expect(s.components.R).toBeNull();
    expect(s.status).toBe("provisional");
    expect(s.score).toBeCloseTo(66.67, 2); // M only; a zero R would have given 26.67
    expect(LearningScore.parse(s)).toBeTruthy();
  });

  it("ELS-001-shaped flow: baseline before exposure, immediate, fresh delayed after +3 days", () => {
    const [t] = buildElsInputs({
      learnerId: LEARNER_ID,
      now: NOW,
      completionByTopic: new Map([[TOPIC, { completedSlides: 10, assignedSlides: 10 }]]),
      attempts: [
        attempt("baseline", day(10), [[k(1), true], [k(2), false], [k(3), false], [k(4), true], [k(5), false]]),
        attempt("immediate", day(10, 12), [[k(6), true], [k(7), true], [k(8), true], [k(9), true], [k(10), false]]),
        // Second immediate repeats k(6): first answer wins (true), k(6) counted once.
        attempt("immediate", day(11), [[k(6), false]]),
        attempt("delayed", day(14), [[k(1, 2), true], [k(2, 2), true]]), // seen in baseline (same fact, v2) → not fresh
      ],
    });
    // Delayed only had non-fresh items → retention insufficient, reason reported.
    expect(t!.input.delayed).toBeNull();
    expect(t!.evidence.retention.reason).toBe("delayed_items_not_fresh");
    expect(t!.input.baseline).toMatchObject({ total: 5, correct: 2 });
    expect(t!.input.immediate).toMatchObject({ total: 5, correct: 4 });
  });

  it("delayed counts only on/after local midnight of exposure +3 days; earlier ones are too_early", () => {
    const immediate = attempt("immediate", new Date("2026-11-14T17:00:00Z"), [[k(1), true], [k(2), true], [k(3), true]]); // 22:30 IST on the 14th
    const early = attempt("delayed", new Date("2026-11-16T18:00:00Z"), [[k(4), true], [k(5), true], [k(6), true]]); // 23:30 IST 16th
    const [a] = buildElsInputs({ learnerId: LEARNER_ID, now: NOW, attempts: [immediate, early] });
    expect(a!.evidence.retention.reason).toBe("delayed_check_too_early");
    const onTime = attempt("delayed", new Date("2026-11-16T18:30:00Z"), [[k(4), true], [k(5), false], [k(6), true]]); // 00:00 IST 17th
    const [b] = buildElsInputs({ learnerId: LEARNER_ID, now: NOW, attempts: [immediate, early, onTime] });
    expect(b!.input.delayed).toMatchObject({ total: 3, correct: 2 });
    expect(b!.evidence.retention.status).toBe("observed");
    expect(computeEls(b!.input).components.R).toBeCloseTo(66.67, 2);
  });

  it("baseline after exposure is excluded; progress exposure counts too", () => {
    const [a] = buildElsInputs({
      learnerId: LEARNER_ID,
      now: NOW,
      attempts: [attempt("immediate", day(10), [[k(1), true], [k(2), true], [k(3), true]]), attempt("baseline", day(12), [[k(4), false], [k(5), false], [k(6), false]])],
    });
    expect(a!.input.baseline).toBeNull();
    expect(a!.evidence.baseline.reason).toBe("baseline_after_exposure");
    const [b] = buildElsInputs({
      learnerId: LEARNER_ID,
      now: NOW,
      exposureByLesson: new Map([[LESSON, day(5)]]),
      attempts: [attempt("baseline", day(6), [[k(4), false], [k(5), true], [k(6), false]])],
    });
    expect(b!.evidence.baseline.reason).toBe("baseline_after_exposure");
    expect(b!.evidence.immediate.reason).toBe("no_attempt");
    expect(computeEls(b!.input).status).toBe("insufficient_evidence");
    expect(computeEls(b!.input).score).toBeNull();
  });

  it("unfinished attempts count only after the answer window; answers outside the presented set are ignored", () => {
    const open = attempt("immediate", new Date(NOW.getTime() - 60_000), [[k(1), true], [k(2), true], [k(3), true]], { finishedAt: null });
    const [a] = buildElsInputs({ learnerId: LEARNER_ID, now: NOW, attempts: [open] });
    expect(a!.input.immediate).toBeNull();
    expect(a!.evidence.immediate.reason).toBe("no_answers");
    const expired = attempt("immediate", new Date(NOW.getTime() - ANSWER_WINDOW_MS), [[k(1), true], [k(2), false], [k(3), true]], { finishedAt: null });
    const [b] = buildElsInputs({ learnerId: LEARNER_ID, now: NOW, attempts: [expired] });
    expect(b!.input.immediate).toMatchObject({ total: 3, correct: 2 });
    const stray = attempt("immediate", day(10), [[k(1), true]], { questionKeys: [k(2)] });
    const [c] = buildElsInputs({ learnerId: LEARNER_ID, now: NOW, attempts: [stray] });
    expect(c!.input.immediate).toBeNull();
  });

  it("finished attempts with no answers are not evidence (not zero)", () => {
    const empty = attempt("immediate", day(10), []);
    const [a] = buildElsInputs({ learnerId: LEARNER_ID, now: NOW, attempts: [empty] });
    expect(a!.input.immediate).toBeNull();
    expect(computeEls(a!.input)).toMatchObject({ status: "insufficient_evidence", score: null });
  });

  it("groups lessons by topic and returns nothing for no attempts", () => {
    expect(buildElsInputs({ learnerId: LEARNER_ID, now: NOW, attempts: [] })).toEqual([]);
    const other = attempt("immediate", day(10), [["x.fact-1.v1", true], ["x.fact-2.v1", true], ["x.fact-3.v1", true]], { lessonId: "other", topicId: null });
    const out = buildElsInputs({ learnerId: LEARNER_ID, now: NOW, attempts: [other, attempt("immediate", day(10), [[k(1), false], [k(2), true], [k(3), true]])] });
    expect(out.map((t) => t.topicId).sort()).toEqual([TOPIC, null].sort());
    expect(DAY).toBe(86_400_000);
  });
});
