/**
 * A4 × A1: the public catalog and the editor draft path against the real schema, roles and RLS
 * (throwaway Postgres via scripts/db/test-db.mjs). SEC-006, CAT-005, item-bank/seed compatibility.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { MemoryRateLimiter, deriveServerKeys } from "@bnl/auth";
import { MULTIPLICATION_LESSON_IDS, PublishedLesson, PublishedManifest, SaveDraftLessonResponse } from "@bnl/contracts";
import { createDb, withDbContext, type Db } from "@bnl/db";
import { bankItemsForContent } from "@bnl/lesson-engine";
import { setDepsForTesting, type AppDeps } from "../../src/server/deps";
import { sqlRepos } from "../../src/server/repos";
import { FakeAdultAuth, ORIGIN } from "../fakes";
import { STAFF, api, pictureContent } from "../content/content-routes";

const url = process.env.BNL_TEST_DB_URL;
const adminUrl = process.env.BNL_TEST_ADMIN_URL;
if (!url || !adminUrl) throw new Error("run via: pnpm --filter @bnl/admin test:integration");

const SYNTHETIC_DRAFT_LESSON = "1e000000-0000-4000-8000-000000000001";
const SEEDED = Object.values(MULTIPLICATION_LESSON_IDS);

let db: Db;
let admin: Db;
let auth: FakeAdultAuth;

beforeAll(() => {
  db = createDb(url, { max: 4 });
  admin = createDb(adminUrl, { max: 2 });
});
afterAll(async () => {
  setDepsForTesting(null);
  await db.end();
  await admin.end();
});
beforeEach(() => {
  auth = new FakeAdultAuth();
  const deps: AppDeps = {
    db: (ctx, fn) => withDbContext(db, ctx, fn),
    repos: sqlRepos,
    adultAuth: auth,
    keys: deriveServerKeys(new TextEncoder().encode(`integration-${randomUUID()}-0123456789abcdef`)),
    rateLimiter: new MemoryRateLimiter(() => new Date()),
    adminOrigin: ORIGIN,
    secureCookies: false,
    now: () => new Date(),
    uuid: randomUUID,
    log: (e) => console.error("app-log", JSON.stringify(e)),
  };
  setDepsForTesting(deps);
});

const manifestLessons = (m: PublishedManifest) => m.subjects.flatMap((s) => s.topics.flatMap((t) => t.lessons));

async function manifest(grade: 2 | 6) {
  const res = await api.manifest(grade);
  expect(res.status).toBe(200);
  return { res, body: PublishedManifest.parse(await res.json()) };
}

describe("SEC-006 / CAT-005 public catalog", () => {
  it("grade 2 manifest lists exactly the ten seeded lessons, is cacheable and carries its checksum as ETag", async () => {
    const { res, body } = await manifest(2);
    expect(manifestLessons(body).map((l) => l.id).sort()).toEqual([...SEEDED].sort());
    expect(res.headers.get("etag")).toBe(`"${body.checksum}"`);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60, stale-while-revalidate=600");
    const [row] = await admin<{ revision: string }[]>`select revision from bnl.published_manifests where grade = 2 order by revision desc limit 1`;
    expect(body.revision).toBe(Number(row!.revision));
    expect(body.subjects.find((s) => s.key === "math")?.playable).toBe(true);
    expect(body.subjects.filter((s) => s.key !== "math").every((s) => !s.playable && s.topics.length === 0)).toBe(true);
  });

  it("CAT-005: grade 6 manifest has no playable lessons", async () => {
    const { body } = await manifest(6);
    expect(body.subjects.length).toBeGreaterThan(0);
    expect(body.subjects.every((s) => !s.playable)).toBe(true);
    expect(manifestLessons(body)).toHaveLength(0);
  });

  it("If-None-Match with the current ETag returns 304; invalid grade is 422", async () => {
    const { res } = await manifest(2);
    const etag = res.headers.get("etag")!;
    const again = await api.manifest(2, { "If-None-Match": etag });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(etag);
    expect(await again.text()).toBe("");
    expect((await api.manifest(2, { "If-None-Match": `W/${etag}` })).status).toBe(304);
    for (const g of ["3", "", "2x", "abc"]) expect((await api.manifest(g)).status).toBe(422);
  });

  it("a newly created draft never reaches the catalog, and draft/unknown lessons are 404", async () => {
    const before = await manifest(2);
    const session = auth.sessionFor(STAFF.editor);
    const saved = await api.save({ content: pictureContent(`grade2.math.multiplication.draft-${randomUUID().slice(0, 8)}`, 4) }, { session });
    expect(saved.status).toBe(201);
    const draft = SaveDraftLessonResponse.parse(await saved.json());
    expect(draft).toMatchObject({ status: "draft", version_no: 1, validation_errors: [] });

    const after = await manifest(2);
    expect(after.body.checksum).toBe(before.body.checksum);
    expect(manifestLessons(after.body).map((l) => l.id)).not.toContain(draft.lesson_id);
    for (const id of [draft.lesson_id, SYNTHETIC_DRAFT_LESSON, randomUUID(), "not-a-uuid"]) {
      const r = await api.catalogLesson(id);
      expect(r.status).toBe(404);
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
    // The public role cannot see the draft rows at all.
    await withDbContext(db, { kind: "public" }, async (sql) => {
      expect(await sql`select id from bnl.lessons where id = ${draft.lesson_id}`).toHaveLength(0);
      expect(await sql`select id from bnl.lesson_versions where id = ${draft.version_id}`).toHaveLength(0);
    });
  });

  it("published lesson: contract shape, version ETag, no answer keys", async () => {
    const id = MULTIPLICATION_LESSON_IDS[7]!;
    const res = await api.catalogLesson(id);
    expect(res.status).toBe(200);
    const text = await res.text();
    const lesson = PublishedLesson.parse(JSON.parse(text));
    expect(lesson.id).toBe(id);
    expect(res.headers.get("etag")).toBe(`"${lesson.checksum}"`);
    expect(res.headers.get("cache-control")).toContain("public");
    expect(text).not.toContain("correct_option_id");
    expect(text).not.toContain("quiz_items");
    expect((await api.catalogLesson(id, { "If-None-Match": `"${lesson.checksum}"` })).status).toBe(304);
  });
});

describe("item bank: lesson-engine reproduces the seeded rows exactly", () => {
  it("for all ten seeded v1 versions", async () => {
    const versions = await admin<{ id: string; version_no: number; content: unknown }[]>`
      select v.id, v.version_no, v.content from bnl.lesson_versions v
      where v.lesson_id = any(${SEEDED}::uuid[]) and v.version_no = 1`;
    expect(versions).toHaveLength(10);
    for (const v of versions) {
      const rows = await admin<{ question_version_key: string; outcome_key: string; stage_eligibility: string[]; prompt: string; options: unknown; correct_option_id: string; sort_order: number }[]>`
        select question_version_key, outcome_key, stage_eligibility, prompt, options, correct_option_id, sort_order
        from bnl.quiz_items where lesson_version_id = ${v.id} order by sort_order`;
      expect(rows).toEqual(bankItemsForContent(v.content, v.version_no)!.map((i) => ({ ...i, stage_eligibility: [...i.stage_eligibility] })));
    }
  });

  it("the SQL backstop generator builds the same rows as lesson-engine", async () => {
    // Generate into a scratch copy inside a rolled-back owner transaction.
    const content = pictureContent("grade2.math.multiplication.table-9", 9, {}, { count_from: 2, count_to: 9 });
    await admin.begin(async (sql) => {
      const [v] = await sql<{ id: string }[]>`
        insert into bnl.lesson_versions (lesson_id, version_no, content, created_by)
        values (${MULTIPLICATION_LESSON_IDS[9]!}, 900, ${sql.json(content)}, ${STAFF.editor.userId}) returning id`;
      await sql`select bnl.generate_picture_groups_items(${v!.id})`;
      const rows = await sql`
        select question_version_key, outcome_key, stage_eligibility, prompt, options, correct_option_id, sort_order
        from bnl.quiz_items where lesson_version_id = ${v!.id} order by sort_order`;
      expect(rows.map((r) => ({ ...r }))).toEqual(bankItemsForContent(content, 900)!.map((i) => ({ ...i, stage_eligibility: [...i.stage_eligibility] })));
      throw new Error("rollback");
    }).catch((e: unknown) => {
      if (!(e instanceof Error && e.message === "rollback")) throw e;
    });
  });
});
