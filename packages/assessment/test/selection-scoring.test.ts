import { describe, expect, it } from "vitest";
import { bankItemsForContent, multiplicationItem, withoutAnswerKey, type BankItem } from "@bnl/lesson-engine";
import {
  attemptSeed,
  feedbackFor,
  itemIdentity,
  itemsPerStage,
  learnerSeed,
  parseEngineItemKey,
  scoreSelection,
  selectQuestions,
  tallyAttempt,
  toBankItemKey,
  toBankOptionId,
  type PriorAttempt,
  type PublicItem,
} from "../src";

const VERSION = "7a000000-0000-4000-8000-000000000007";
const LEARNER = "c1000000-0000-4000-8000-0000000000a1";
const content = (factor: number) => ({
  contract_version: 1,
  stable_key: `grade2.math.multiplication.table-${factor}`,
  grade: 2,
  subject_key: "math",
  topic_key: "grade2.math.multiplication",
  title: `${factor} Times Table`,
  template: "picture_groups_v1",
  config: { factor, count_from: 1, count_to: 10, themes: ["puppy", "farm"], seconds_per_slide: 7, quiz_question_count: 3 },
  learning_outcome_keys: ["grade2.math.multiplication"],
  rights: { type: "original_generated_content", reviewed: true },
});
const BANK: BankItem[] = bankItemsForContent(content(7), 1)!;
const PUBLIC: PublicItem[] = BANK.map(withoutAnswerKey);

const select = (stage: PriorAttempt["stage"], clientAttemptId: string, prior: PriorAttempt[] = [], items = PUBLIC, count = 3) =>
  selectQuestions({ items, stage, count, seed: attemptSeed({ clientAttemptId, lessonVersionId: VERSION, stage }), learnerSeed: learnerSeed(LEARNER, VERSION), prior });
const keys = (s: ReturnType<typeof select>) => s.questions.map((q) => q.question_version_key);

describe("seeded selection", () => {
  it("is deterministic for the same inputs and never uses Math.random", () => {
    const original = Math.random;
    Math.random = () => {
      throw new Error("Math.random used");
    };
    try {
      const a = select("immediate", "11111111-1111-4111-8111-111111111111");
      const b = select("immediate", "11111111-1111-4111-8111-111111111111");
      expect(a).toEqual(b);
      expect(a.status).toBe("ready");
      expect(a.questions).toHaveLength(3);
    } finally {
      Math.random = original;
    }
  });

  it("seed is 32 hex chars and differs per attempt, version and stage", () => {
    const s = attemptSeed({ clientAttemptId: "a", lessonVersionId: VERSION, stage: "baseline" });
    expect(s).toMatch(/^[0-9a-f]{32}$/);
    expect(s).not.toBe(attemptSeed({ clientAttemptId: "b", lessonVersionId: VERSION, stage: "baseline" }));
    expect(s).not.toBe(attemptSeed({ clientAttemptId: "a", lessonVersionId: VERSION, stage: "immediate" }));
  });

  it("different attempt seeds vary questions and option order but keep option ids/labels intact", () => {
    const sets = new Set<string>();
    for (let i = 0; i < 20; i++) sets.add(keys(select("immediate", `attempt-${i}`)).join(","));
    expect(sets.size).toBeGreaterThan(1);
    const q = select("immediate", "x").questions[0]!;
    const bank = BANK.find((b) => b.question_version_key === q.question_version_key)!;
    expect([...q.options].sort((a, b) => a.id.localeCompare(b.id))).toEqual(bank.options);
  });

  it("never exposes an answer key", () => {
    const s = select("baseline", "k");
    expect(JSON.stringify(s)).not.toMatch(/correct/);
  });

  it("TEL-006: baseline, immediate (repeated) and delayed use different questions of the same outcome", () => {
    const prior: PriorAttempt[] = [];
    const baseline = select("baseline", "b-1", prior);
    prior.push({ stage: "baseline", questionKeys: keys(baseline) });
    const immediates: string[][] = [];
    for (let i = 0; i < 6; i++) {
      const s = select("immediate", `i-${i}`, prior);
      expect(s.reused_across_stages).toEqual([]);
      immediates.push(keys(s));
      prior.push({ stage: "immediate", questionKeys: keys(s) });
    }
    const delayed = select("delayed", "d-1", prior);
    expect(delayed.reused_across_stages).toEqual([]);
    const b = new Set(keys(baseline));
    const im = new Set(immediates.flat());
    for (const k of keys(delayed)) expect(b.has(k) || im.has(k)).toBe(false);
    for (const k of im) expect(b.has(k)).toBe(false);
    expect(new Set(BANK.filter((x) => [...b, ...im, ...keys(delayed)].includes(x.question_version_key)).map((x) => x.outcome_key))).toEqual(
      new Set(["grade2.math.multiplication"]),
    );
  });

  it("a second delayed check prefers items not yet used; reuse across stages is reported, never silent", () => {
    const prior: PriorAttempt[] = [
      { stage: "baseline", questionKeys: keys(select("baseline", "b")) },
    ];
    prior.push({ stage: "immediate", questionKeys: keys(select("immediate", "i", prior)) });
    const d1 = select("delayed", "d1", prior);
    prior.push({ stage: "delayed", questionKeys: keys(d1) });
    const d2 = select("delayed", "d2", prior);
    // 10 items: 3 baseline + 3 immediate + 3 delayed leaves 1 fresh; the rest repeat delayed items, not other stages.
    expect(d2.reused_across_stages).toEqual([]);
    expect(keys(d2).filter((k) => !keys(d1).includes(k))).toHaveLength(1);
    // Exhaust every item in other stages → reuse is reported.
    const all: PriorAttempt[] = [{ stage: "immediate", questionKeys: BANK.map((x) => x.question_version_key) }];
    expect(select("delayed", "d3", all).reused_across_stages).toHaveLength(3);
  });

  it("identity ignores the version suffix (same fact in v2 is not fresh)", () => {
    expect(itemIdentity("grade2.math.multiplication.table-7.fact-3.v2")).toBe("grade2.math.multiplication.table-7.fact-3");
    const v2 = bankItemsForContent(content(7), 2)!.map(withoutAnswerKey);
    const prior: PriorAttempt[] = [{ stage: "baseline", questionKeys: BANK.slice(0, 7).map((x) => x.question_version_key) }];
    const s = select("immediate", "z", prior, v2);
    expect(s.reused_across_stages).toEqual([]);
    for (const k of keys(s)) expect(Number(/fact-(\d+)/.exec(k)![1])).toBeGreaterThan(7);
  });

  it("insufficient_items when fewer than 3 eligible items (no fabricated quiz)", () => {
    const two = PUBLIC.slice(0, 2);
    expect(select("baseline", "a", [], two)).toEqual({ status: "insufficient_items", questions: [], reused_across_stages: [] });
    const notDelayed = PUBLIC.map((i) => ({ ...i, stage_eligibility: ["baseline", "immediate"] }));
    expect(select("delayed", "a", [], notDelayed).status).toBe("insufficient_items");
  });

  it("items per stage clamps the lesson count into 3..5", () => {
    expect(itemsPerStage(undefined)).toBe(3);
    expect(itemsPerStage(1)).toBe(3);
    expect(itemsPerStage(4)).toBe(4);
    expect(itemsPerStage(10)).toBe(5);
    expect(itemsPerStage(3.5)).toBe(3);
  });
});

describe("scoring rules", () => {
  const item = BANK[2]!;
  it("scores against the server key; unknown options are refused", () => {
    expect(scoreSelection(item, item.correct_option_id)).toEqual({ kind: "scored", correct: true, correct_option_id: item.correct_option_id });
    const wrong = item.options.find((o) => o.id !== item.correct_option_id)!.id;
    expect(scoreSelection(item, wrong)).toMatchObject({ kind: "scored", correct: false });
    expect(scoreSelection(item, "z")).toEqual({ kind: "unknown_option" });
    expect(feedbackFor(true)).toBe("amazing");
    expect(feedbackFor(false)).toBe("good_try");
  });

  it("tally counts presented questions and correct answers among them only", () => {
    expect(tallyAttempt(["a", "b", "c"], [
      { question_version_key: "a", correct: true },
      { question_version_key: "b", correct: false },
      { question_version_key: "x", correct: true },
    ])).toEqual({ total: 3, correct: 1 });
  });
});

describe("ADR-0007 lesson-engine key mapping", () => {
  const ref = { lessonVersionId: VERSION, stableKey: "grade2.math.multiplication.table-7", versionNo: 1, factor: 7 };
  it("maps every engine item of the version onto an existing bank key and option", () => {
    for (let n = 1; n <= 10; n++) {
      const engine = multiplicationItem(VERSION, 7, n, "seed");
      expect(parseEngineItemKey(engine.question_version_key)).toEqual({ lessonVersionId: VERSION, factor: 7, multiplier: n });
      const bankKey = toBankItemKey(engine.question_version_key, ref);
      const bank = BANK.find((b) => b.question_version_key === bankKey);
      expect(bank, `n=${n}`).toBeDefined();
      // The engine's correct option maps to the bank's correct option (same value).
      expect(toBankOptionId(engine.correct_option_id, bank!.options)).toBe(bank!.correct_option_id);
    }
  });

  it("refuses other versions/factors; bank keys and ids pass through; unknown values map to null", () => {
    expect(toBankItemKey(`${"7a000000-0000-4000-8000-000000000008"}:mult-7x3`, ref)).toBeNull();
    expect(toBankItemKey(`${VERSION}:mult-6x3`, ref)).toBeNull();
    expect(toBankItemKey("grade2.math.multiplication.table-7.fact-3.v1", ref)).toBe("grade2.math.multiplication.table-7.fact-3.v1");
    expect(toBankOptionId("b", BANK[0]!.options)).toBe("b");
    expect(toBankOptionId("opt-999", BANK[0]!.options)).toBeNull();
    expect(parseEngineItemKey("nope")).toBeNull();
  });
});
