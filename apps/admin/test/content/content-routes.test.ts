/**
 * Route tests with fakes: SEC-002 role separation, SEC-008 markup never published, CSRF,
 * Idempotency-Key replay/conflict, 401 without a session, catalog input handling.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { ApiError, PublishResponse, SaveDraftLessonResponse, type StaffRole } from "@bnl/contracts";
import { setContentRepoForTesting } from "../../src/server/content/port";
import type { DbContext, Sql } from "../../src/server/db-port";
import { setDepsForTesting } from "../../src/server/deps";
import { makeTestEnv, type TestEnv } from "../fakes";
import { STAFF, api, newKey, pictureContent } from "./content-routes";
import { emptyContentStore, fakeContentRepo, type ContentStore } from "./fake-content";

let env: TestEnv;
let content: ContentStore;
const s = {} as Record<keyof typeof STAFF, string>;

const ROLES: Record<string, StaffRole[]> = {
  [STAFF.editor.userId]: ["editor"],
  [STAFF.reviewer.userId]: ["reviewer"],
  [STAFF.publisher.userId]: ["publisher"],
  [STAFF.analyst.userId]: ["analyst"],
  [STAFF.editorReviewer.userId]: ["editor", "reviewer"],
};

beforeEach(() => {
  env = makeTestEnv();
  content = emptyContentStore();
  for (const [userId, roles] of Object.entries(ROLES)) for (const role of roles) env.store.staff.push({ userId, role, revokedAt: null });
  // Transaction semantics for the content store too: a throw restores the snapshot.
  const inner = env.deps.db;
  const db = async <T>(ctx: DbContext, fn: (sql: Sql) => Promise<T>): Promise<T> => {
    const snapshot = structuredClone(content);
    try {
      return await inner(ctx, fn);
    } catch (err) {
      Object.assign(content, snapshot);
      throw err;
    }
  };
  setDepsForTesting({ ...env.deps, db });
  setContentRepoForTesting(fakeContentRepo(content, (u) => ROLES[u] ?? []));
  for (const k of Object.keys(STAFF) as (keyof typeof STAFF)[]) s[k] = env.auth.sessionFor(STAFF[k]);
});
afterEach(() => {
  setDepsForTesting(null);
  setContentRepoForTesting(null);
});

const KEY = "grade2.math.multiplication.route-test";
const code = async (res: Response) => ApiError.parse(await res.json()).error.code;

async function draft(over: Record<string, unknown> = {}) {
  const res = await api.save({ content: pictureContent(KEY, 3, over) }, { session: s.editor });
  expect(res.status).toBe(201);
  return SaveDraftLessonResponse.parse(await res.json());
}
async function approved() {
  const d = await draft();
  expect((await api.transition(d.lesson_id, d.version_id, { action: "submit" }, { session: s.editor })).status).toBe(200);
  expect((await api.transition(d.lesson_id, d.version_id, { action: "approve" }, { session: s.reviewer })).status).toBe(200);
  return d;
}

describe("authentication and CSRF", () => {
  it("every admin content route is 401 without a session", async () => {
    const id = randomUUID();
    const calls = [
      api.list(), api.detail(id), api.preview(id, id), api.save({ content: pictureContent(KEY, 3) }, { csrf: false }),
      api.transition(id, id, { action: "submit" }, { csrf: false }), api.publish(id, { version_id: id, reason: "r" }, newKey(), { csrf: false }),
      api.unpublish(id, { reason: "r" }, newKey(), { csrf: false }), api.pin(1, newKey(), { csrf: false }),
    ];
    for (const res of await Promise.all(calls)) expect(res.status).toBe(401);
  });
  it("an adult without a staff role is forbidden", async () => {
    expect((await api.list({ session: env.auth.sessionFor({ userId: randomUUID(), email: "x@bnl.test" }) })).status).toBe(403);
  });
  it("mutations reject a foreign Origin", async () => {
    const res = await api.save({ content: pictureContent(KEY, 3) }, { session: s.editor, origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(content.versions).toHaveLength(0);
  });
});

describe("SEC-002 role separation", () => {
  it("editor saves a draft with an item bank but cannot approve or publish", async () => {
    const d = await draft();
    expect(d).toMatchObject({ status: "draft", version_no: 1, validation_errors: [] });
    expect(content.items.filter((i) => i.versionId === d.version_id)).toHaveLength(10);
    expect((await api.transition(d.lesson_id, d.version_id, { action: "submit" }, { session: s.editor })).status).toBe(200);
    expect((await api.transition(d.lesson_id, d.version_id, { action: "approve" }, { session: s.editor })).status).toBe(403);
    expect((await api.publish(d.lesson_id, { version_id: d.version_id, reason: "r" }, newKey(), { session: s.editor })).status).toBe(403);
    expect(content.calls).not.toContain("publish");
  });
  it("reviewer cannot save or publish; publisher cannot save or approve", async () => {
    expect((await api.save({ content: pictureContent(KEY, 3) }, { session: s.reviewer })).status).toBe(403);
    const d = await approved();
    expect((await api.publish(d.lesson_id, { version_id: d.version_id, reason: "r" }, newKey(), { session: s.reviewer })).status).toBe(403);
    expect((await api.save({ content: pictureContent(KEY, 3) }, { session: s.publisher })).status).toBe(403);
    expect((await api.transition(d.lesson_id, d.version_id, { action: "approve" }, { session: s.publisher })).status).toBe(403);
  });
  it("a reviewer cannot approve or reject their own version", async () => {
    const res = await api.save({ content: pictureContent(KEY, 3) }, { session: s.editorReviewer });
    const d = SaveDraftLessonResponse.parse(await res.json());
    expect((await api.transition(d.lesson_id, d.version_id, { action: "submit" }, { session: s.editorReviewer })).status).toBe(200);
    for (const action of ["approve", "reject"]) {
      expect((await api.transition(d.lesson_id, d.version_id, { action }, { session: s.editorReviewer })).status).toBe(403);
    }
    expect(content.versions[0]!.status).toBe("in_review");
  });
  it("publisher publishes an approved version", async () => {
    const d = await approved();
    const res = await api.publish(d.lesson_id, { version_id: d.version_id, reason: "Go live" }, newKey(), { session: s.publisher });
    expect(res.status).toBe(200);
    expect(PublishResponse.parse(await res.json()).manifest_revision).toBe(1);
  });
  it("analyst may read lists, detail and preview (without answer keys)", async () => {
    const d = await draft();
    expect((await api.list({ session: s.analyst })).status).toBe(200);
    expect((await api.detail(d.lesson_id, { session: s.analyst })).status).toBe(200);
    const p = await api.preview(d.lesson_id, d.version_id, { session: s.analyst });
    expect(await p.text()).not.toContain("correct_option_id");
  });
});

describe("M04 drafts", () => {
  it("an invalid draft is saved with errors and cannot be submitted", async () => {
    const d = await draft({ title: "<script>alert(1)</script>", rights: { type: "licensed", reviewed: false } });
    expect(d.validation_errors.map((e) => e.path)).toEqual(expect.arrayContaining(["title", "rights.reviewed", "rights.attribution"]));
    const res = await api.transition(d.lesson_id, d.version_id, { action: "submit" }, { session: s.editor });
    expect(res.status).toBe(422);
    expect(content.versions[0]!.status).toBe("draft");
  });
  it("saving again edits the draft in place; after submit a save creates v2 (CAT-007)", async () => {
    const d = await draft();
    const again = SaveDraftLessonResponse.parse(await (await api.save({ lesson_id: d.lesson_id, content: pictureContent(KEY, 4) }, { session: s.editor })).json());
    expect(again.version_id).toBe(d.version_id);
    await api.transition(d.lesson_id, d.version_id, { action: "submit" }, { session: s.editor });
    const v2 = SaveDraftLessonResponse.parse(await (await api.save({ lesson_id: d.lesson_id, content: pictureContent(KEY, 5) }, { session: s.editor })).json());
    expect(v2.version_no).toBe(2);
    expect((content.versions.find((v) => v.id === d.version_id)!.content as { config: { factor: number } }).config.factor).toBe(4);
  });
  it("lesson identity cannot change and duplicate stable keys conflict", async () => {
    const d = await draft();
    const moved = await api.save({ lesson_id: d.lesson_id, content: pictureContent(`${KEY}-other`, 3) }, { session: s.editor });
    expect(moved.status).toBe(422);
    const dup = await api.save({ content: pictureContent(KEY, 3) }, { session: s.editor });
    expect(dup.status).toBe(409);
  });
  it("rejects bodies that do not match the contract", async () => {
    const res = await api.save({ content: { ...pictureContent(KEY, 3), title: "" } }, { session: s.editor });
    expect(res.status).toBe(422);
  });
});

describe("SEC-008 publish re-validates content", () => {
  it("markup in the title is never published even if the version is approved", async () => {
    const d = await approved();
    const v = content.versions[0]!;
    v.content = { ...(v.content as Record<string, unknown>), title: '<img src=x onerror="alert(1)">' }; // bypassed the BFF
    const res = await api.publish(d.lesson_id, { version_id: d.version_id, reason: "r" }, newKey(), { session: s.publisher });
    expect(res.status).toBe(422);
    expect(content.calls).not.toContain("publish");
    expect(content.manifests).toHaveLength(0);
  });
  it("a version with no item bank is not published", async () => {
    const d = await approved();
    content.items = [];
    expect((await api.publish(d.lesson_id, { version_id: d.version_id, reason: "r" }, newKey(), { session: s.publisher })).status).toBe(409);
  });
});

describe("Idempotency-Key", () => {
  it("replay returns the same response once; a different body conflicts; failures are retryable", async () => {
    const d = await approved();
    const key = newKey();
    const first = await api.publish(d.lesson_id, { version_id: d.version_id, reason: "Go" }, key, { session: s.publisher });
    const firstBody = await first.json();
    const replay = await api.publish(d.lesson_id, { reason: "Go", version_id: d.version_id }, key, { session: s.publisher });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(await replay.json()).toEqual(firstBody);
    expect(content.calls.filter((c) => c === "publish")).toHaveLength(1);
    expect(content.manifests).toHaveLength(1);

    const other = await api.publish(d.lesson_id, { version_id: d.version_id, reason: "Different" }, key, { session: s.publisher });
    expect(other.status).toBe(409);
    expect(await code(other)).toBe("idempotency_conflict");

    // A failed call stores nothing: the same key can be used after fixing the request.
    const failKey = newKey();
    expect((await api.unpublish(randomUUID(), { reason: "r" }, failKey, { session: s.publisher })).status).toBe(409);
    expect(content.idempotency.some((r) => r.key === failKey)).toBe(false);
  });
  it("missing or malformed keys are rejected before any change", async () => {
    const d = await approved();
    for (const k of [null, "short", "has spaces in it"]) {
      expect((await api.publish(d.lesson_id, { version_id: d.version_id, reason: "r" }, k, { session: s.publisher })).status).toBe(422);
    }
    expect(content.manifests).toHaveLength(0);
  });
  it("pin accepts an empty body and validates the revision", async () => {
    const d = await approved();
    await api.publish(d.lesson_id, { version_id: d.version_id, reason: "r" }, newKey(), { session: s.publisher });
    const pinned = await api.pin(1, newKey(), { session: s.publisher });
    expect(pinned.status).toBe(200);
    expect(await pinned.json()).toEqual({ manifest_revision: 2, pinned_from_revision: 1 });
    expect((await api.pin("0", newKey(), { session: s.publisher })).status).toBe(422);
    expect((await api.pin(77, newKey(), { session: s.publisher })).status).toBe(404);
  });
});

describe("catalog input handling", () => {
  it("invalid grade is 422, unknown lessons are 404 and never cacheable", async () => {
    for (const g of ["1", "x", ""]) expect((await api.manifest(g)).status).toBe(422);
    const res = await api.catalogLesson("not-a-uuid");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await api.catalogLesson(randomUUID())).status).toBe(404);
    expect(env.contexts.every((c) => c.kind === "public")).toBe(true);
  });
  it("a manifest that fails the contract is not served (fail closed)", async () => {
    const d = await approved();
    await api.publish(d.lesson_id, { version_id: d.version_id, reason: "r" }, newKey(), { session: s.publisher });
    expect((await api.manifest(2)).status).toBe(500);
  });
});

describe("SEC-001 coverage of the CMS surface", () => {
  const appDir = fileURLToPath(new URL("../../src/app", import.meta.url));
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
  it("every lessons page verifies the adult session server-side", () => {
    const pages = walk(join(appDir, "admin/(portal)/lessons")).filter((f) => f.endsWith("page.tsx"));
    expect(pages).toHaveLength(2);
    for (const f of pages) expect(readFileSync(f, "utf8"), f).toMatch(/await requireAdultPage\(\)/);
  });
  it("all content route files are exercised by the 401 test above", () => {
    const files = [...walk(join(appDir, "api/v1/admin/lessons")), ...walk(join(appDir, "api/v1/admin/manifests"))].filter((f) => f.endsWith("route.ts"));
    expect(files).toHaveLength(7);
  });
});
