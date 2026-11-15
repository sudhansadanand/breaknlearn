import { describe, expect, it } from "vitest";
import { ThemeKey } from "@bnl/contracts";
import { bankItemKey, bankItemsForContent, bankMultiplicationItem, previewPictureGroups, withoutAnswerKey } from "../src";

const content = (factor: number, extra: Record<string, unknown> = {}) => ({
  contract_version: 1, stable_key: `grade2.math.multiplication.table-${factor}`, grade: 2, subject_key: "math",
  topic_key: "grade2.math.multiplication", title: `${factor} Times Table`, template: "picture_groups_v1",
  config: { factor, count_from: 1, count_to: 10, themes: ThemeKey.options, seconds_per_slide: 7, quiz_question_count: 3, ...extra },
  learning_outcome_keys: ["grade2.math.multiplication"], rights: { type: "original_generated_content", reviewed: true },
});

describe("item bank (seed scheme)", () => {
  it("CAT-004: every fact has 4 distinct positive options and exactly one correct", () => {
    for (let f = 1; f <= 10; f++) {
      const items = bankItemsForContent(content(f), 1)!;
      expect(items).toHaveLength(10);
      items.forEach((it, i) => {
        const m = i + 1;
        const vals = it.options.map((o) => Number(o.label));
        expect(new Set(vals).size).toBe(4);
        expect(vals.every((v) => v > 0)).toBe(true);
        expect(it.options.map((o) => o.id)).toEqual(["a", "b", "c", "d"]);
        const correct = it.options.find((o) => o.id === it.correct_option_id);
        expect(Number(correct?.label)).toBe(f * m);
        expect(vals.filter((v) => v === f * m)).toHaveLength(1);
        expect(it.prompt).toBe(`${f} × ${m} = ?`);
        expect(it.question_version_key).toBe(`grade2.math.multiplication.table-${f}.fact-${m}.v1`);
        expect(it.sort_order).toBe(m);
      });
    }
  });

  it("reproduces known seed rows exactly", () => {
    // 7 × 3: correct_pos = ((7+3) % 4) + 1 = 3; distractors 28, 14, 22.
    expect(bankMultiplicationItem({ stableKey: "k.t", versionNo: 2, outcomeKey: "o", factor: 7, m: 3 })).toEqual({
      question_version_key: "k.t.fact-3.v2", outcome_key: "o", stage_eligibility: ["baseline", "immediate", "delayed"],
      prompt: "7 × 3 = ?", sort_order: 3, correct_option_id: "c",
      options: [{ id: "a", label: "28" }, { id: "b", label: "14" }, { id: "c", label: "21" }, { id: "d", label: "22" }],
    });
    // 1 × 1: negative/zero candidates are skipped.
    expect(bankMultiplicationItem({ stableKey: "k.t", versionNo: 1, outcomeKey: "o", factor: 1, m: 1 }).options.map((o) => o.label))
      .toEqual(["2", "3", "1", "4"]);
  });

  it("keys are versioned and deterministic", () => {
    expect(bankItemsForContent(content(4), 3)).toEqual(bankItemsForContent(content(4), 3));
    expect(bankItemKey("a.b", 3, 7)).toBe("a.b.fact-7.v3");
    const v1 = new Set(bankItemsForContent(content(4), 1)!.map((i) => i.question_version_key));
    expect(bankItemsForContent(content(4), 2)!.some((i) => v1.has(i.question_version_key))).toBe(false);
  });

  it("respects count_from..count_to and has no items for unrenderable content", () => {
    expect(bankItemsForContent(content(5, { count_from: 3, count_to: 5 }), 1)!.map((i) => i.sort_order)).toEqual([3, 4, 5]);
    expect(bankItemsForContent(content(11), 1)).toBeNull();
    expect(bankItemsForContent(content(5, { count_from: 6, count_to: 2 }), 1)).toBeNull();
    expect(bankItemsForContent({ ...content(5), template: "slides_v1" }, 1)).toBeNull();
    expect(bankItemsForContent({ nope: true }, 1)).toBeNull();
  });

  it("withoutAnswerKey strips the server-only answer", () => {
    const it0 = bankItemsForContent(content(2), 1)![0]!;
    expect(withoutAnswerKey(it0)).not.toHaveProperty("correct_option_id");
    expect(JSON.stringify(withoutAnswerKey(it0))).not.toContain("correct");
  });
});

describe("previewPictureGroups", () => {
  it("renders every enabled world in order with TV wording", () => {
    const p = previewPictureGroups(content(3, { themes: ["farm", "puppy"] }))!;
    expect(p.map((t) => t.theme_key)).toEqual(["farm", "puppy"]);
    expect(p[0]!.slides).toHaveLength(10);
    expect(p[0]!.slides[1]).toMatchObject({ headline: "3 × 2 = 6", caption: "2 groups of 3 horses", icon: "🐴" });
    expect(p[1]!.name).toBe("Puppy Park");
  });
  it("returns null for invalid content", () => {
    expect(previewPictureGroups(content(0))).toBeNull();
    expect(previewPictureGroups({ ...content(3), template: "video_v1" })).toBeNull();
  });
});
