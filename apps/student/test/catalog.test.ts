import { describe, expect, it } from "vitest";
import { AVATARS as C_AVATARS, GRADE_SUBJECTS, MULTIPLICATION_LESSON_IDS, PublishedLesson, PublishedManifest, WORLDS as C_WORLDS } from "../../../packages/contracts/src";
import { bankMultiplicationItem } from "../../../packages/lesson-engine/src";
import { AVATARS, AVATAR_IDS, LESSON_IDS, SUBJECTS, WORLDS, builtinCatalog, catalogFromCache, lessonFromPublished, manifestLessons, type CachedCatalog } from "../src/catalog";
import { bankOptions, optionIdFor } from "../src/paired";
import { lessonFixture, lessonForTable, manifestFixture } from "../../../tests/fixtures/student/catalog";

describe("built-in content equals @bnl/contracts (and therefore the live app)", () => {
  it("subjects, worlds, avatars and lesson ids", () => {
    for (const g of [2, 6] as const) expect(SUBJECTS[g]).toEqual(GRADE_SUBJECTS[g].map((s) => [s.label, s.icon]));
    expect(WORLDS).toEqual(C_WORLDS.map((w) => ({ id: w.key, name: w.name, icon: w.icon, plural: w.plural, color: w.color })));
    expect(AVATARS).toEqual(C_AVATARS.map((a) => a.emoji));
    expect(AVATAR_IDS).toEqual(C_AVATARS.map((a) => a.id));
    expect(LESSON_IDS).toEqual(MULTIPLICATION_LESSON_IDS);
  });

  it("built-in catalog = tables 1..10, six worlds, 7 s, 3 questions", () => {
    const c = builtinCatalog();
    expect(c.tables.map((t) => t.table)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const t of c.tables) expect(t).toMatchObject({ worlds: ["puppy", "candy", "unicorn", "school", "treat", "farm"], secondsPerSlide: 7, quizCount: 3 });
  });

  it("bank option ids match @bnl/lesson-engine bankMultiplicationItem", () => {
    for (let n = 1; n <= 10; n++)
      for (let m = 1; m <= 10; m++) {
        const item = bankMultiplicationItem({ stableKey: "k", versionNo: 1, outcomeKey: "o", factor: n, m });
        expect(bankOptions(n, m)).toEqual(item.options.map((o) => Number(o.label)));
        const t = builtinCatalog().tables[n - 1]!;
        expect(optionIdFor(t, m, n * m)).toBe(item.correct_option_id);
      }
    expect(optionIdFor(builtinCatalog().tables[2]!, 4, 999)).toBe("v-999");
  });
});

describe("server catalog validation", () => {
  it("fixtures are valid PublishedManifest / PublishedLesson documents", () => {
    expect(PublishedManifest.safeParse(manifestFixture([1, 2, 3])).success).toBe(true);
    expect(PublishedLesson.safeParse(lessonForTable(4)).success).toBe(true);
  });

  it("accepts a published manifest + lessons and keeps manifest order", () => {
    const m = manifestLessons(manifestFixture([3, 1, 2]));
    expect(m?.lessons.map((l) => l.stable_key)).toEqual([1, 2, 3].map((t) => `grade2.math.multiplication.table-${t}`)); // sort_order wins
    const ref = m!.lessons[0]!;
    expect(lessonFromPublished(ref, lessonFixture(ref.id, ref.version_id, 1, { themes: ["farm", "puppy"], seconds_per_slide: 5 }))).toMatchObject({ table: 1, worlds: ["puppy", "farm"], secondsPerSlide: 5, quizCount: 3, versionNo: 1 });
  });

  it("rejects lessons this TV cannot render faithfully", () => {
    const m = manifestLessons(manifestFixture([1]))!;
    const ref = m.lessons[0]!;
    expect(lessonFromPublished(ref, lessonFixture(ref.id, ref.version_id, 1, { count_to: 5 }))).toBeNull();
    expect(lessonFromPublished(ref, lessonFixture(ref.id, ref.version_id, 1, { themes: ["moon"] }))).toBeNull();
    expect(lessonFromPublished(ref, lessonFixture(ref.id, "00000000-0000-4000-8000-000000000000", 1, {}))).toBeNull();
    expect(manifestLessons({ revision: 1, grade: 6, subjects: [] })).toBeNull();
    expect(manifestLessons("nope")).toBeNull();
  });

  it("a cached catalog round-trips; a corrupt one is ignored", () => {
    const m = manifestLessons(manifestFixture([1, 2]))!;
    const cached: CachedCatalog = { version: 1, revision: 4, etag: '"x"', playable: true, lessons: {}, order: [] };
    for (const ref of m.lessons) {
      cached.lessons[ref.id] = { ref, lesson: lessonFixture(ref.id, ref.version_id, ref.sort_order, {}) };
      cached.order.push(ref.id);
    }
    expect(catalogFromCache(JSON.parse(JSON.stringify(cached)))?.tables.map((t) => t.table)).toEqual([1, 2]);
    expect(catalogFromCache({ ...cached, order: ["missing"] })).toBeNull();
  });
});
