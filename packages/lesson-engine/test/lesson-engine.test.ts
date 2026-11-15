import { describe, expect, it } from "vitest";
import { WORLDS, ThemeKey } from "@bnl/contracts";
import { multiplicationItem, pickItems, renderPictureGroups, validateLessonContent } from "../src";

const cfg = (factor: number) => ({ factor, themes: ThemeKey.options });
const V = "11111111-1111-4111-8111-111111111111";

describe("picture_groups_v1", () => {
  it("CAT-004: every factor 1..10 × step 1..10 in every world shows the correct product and count", () => {
    for (let f = 1; f <= 10; f++)
      for (const w of WORLDS) {
        const slides = renderPictureGroups(cfg(f), w.key as ThemeKey);
        expect(slides).toHaveLength(10);
        slides.forEach((s, i) => {
          const n = i + 1;
          expect(s.slide_id).toBe(`step-${n}`);
          expect(s.headline).toBe(`${f} × ${n} = ${f * n}`);
          expect(s.group_count * s.objects_per_group).toBe(f * n);
          expect(s.total_objects).toBe(f * n);
          expect(s.icon).toBe(w.icon);
        });
      }
  });
  it("matches live wording", () => {
    const s = renderPictureGroups(cfg(7), "puppy");
    expect(s[0]).toMatchObject({ title: "Count in sevens!", caption: "1 group of 7 puppies" });
    expect(s[2]!.caption).toBe("3 groups of 7 puppies");
  });
  it("rejects disabled themes and bad config", () => {
    expect(() => renderPictureGroups({ factor: 3, themes: ["puppy"] }, "farm")).toThrow();
    expect(() => renderPictureGroups({ factor: 11, themes: ["puppy"] }, "puppy")).toThrow();
  });
});

describe("quiz items", () => {
  it("CAT-004: 4 unique positive options, exactly one correct, for all 100 facts and many seeds", () => {
    for (let f = 1; f <= 10; f++)
      for (let n = 1; n <= 10; n++)
        for (const seed of ["a", "b", "c", "attempt-42"]) {
          const it = multiplicationItem(V, f, n, seed);
          const vals = it.options.map((o) => Number(o.label));
          expect(new Set(vals).size).toBe(4);
          expect(vals.every((v) => v > 0)).toBe(true);
          expect(vals.filter((v) => v === f * n)).toHaveLength(1);
          expect(it.correct_option_id).toBe(`opt-${f * n}`);
          expect(it.options.some((o) => o.id === it.correct_option_id)).toBe(true);
        }
  });
  it("is deterministic for a seed", () => {
    expect(multiplicationItem(V, 7, 3, "s")).toEqual(multiplicationItem(V, 7, 3, "s"));
  });
  it("TEL-006: stage selection excludes previously used items and reports exhaustion", () => {
    const keys = Array.from({ length: 10 }, (_, i) => `${V}:mult-3x${i + 1}`);
    const baseline = pickItems(keys, new Set(), 3, "b");
    const immediate = pickItems(keys, new Set(baseline), 3, "i");
    const delayed = pickItems(keys, new Set([...baseline, ...immediate]), 3, "d");
    const all = [...baseline, ...immediate, ...delayed];
    expect(new Set(all).size).toBe(9);
    expect(pickItems(keys, new Set(all), 3, "x")).toHaveLength(1);
  });
});

describe("content validation", () => {
  const good = {
    contract_version: 1, stable_key: "grade2.math.multiplication.table-7", grade: 2, subject_key: "math",
    topic_key: "grade2.math.multiplication", title: "7 Times Table", template: "picture_groups_v1",
    config: { factor: 7, themes: ["puppy", "candy"] }, learning_outcome_keys: ["grade2.math.multiplication"],
    rights: { type: "original_generated_content", reviewed: true },
  };
  it("accepts the seeded lesson shape", () => expect(validateLessonContent(good)).toEqual([]));
  it("SEC-008: rejects markup/script in text", () => {
    expect(validateLessonContent({ ...good, title: '<img src=x onerror="alert(1)">' }).map((e) => e.path)).toContain("title");
  });
  it("requires reviewed rights and valid config", () => {
    const errs = validateLessonContent({ ...good, rights: { type: "licensed", reviewed: false }, config: { factor: 0, themes: [] } });
    expect(errs.map((e) => e.path)).toEqual(expect.arrayContaining(["rights.reviewed", "rights.attribution"]));
    expect(errs.some((e) => e.path.startsWith("config."))).toBe(true);
  });
  it("templates without a renderer cannot be published", () => {
    expect(validateLessonContent({ ...good, template: "video_v1", subject_key: "science" }).map((e) => e.path)).toContain("template");
  });
});
