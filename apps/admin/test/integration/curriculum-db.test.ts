/**
 * A3 × A1: curriculum review and school import handlers against the real schema, roles and RLS
 * (scripts/db/test-db.mjs throwaway Postgres). Proves CAT-006, CAT-009, CAT-010, SEC-007 and
 * cross-household denial. No SQL fakes; storage is a LocalFsStorage in a temp directory.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryRateLimiter, deriveServerKeys } from "@bnl/auth";
import { createDb, withDbContext, type Db } from "@bnl/db";
import { LocalFsStorage } from "@bnl/storage";
import { setDepsForTesting, type AppDeps } from "../../src/server/deps";
import { sqlRepos } from "../../src/server/repos";
import { LOCAL_OBJECT_PATH, setCurriculumDepsForTesting, type CurriculumDeps } from "../../src/server/curriculum/deps";
import { sqlCurriculumRepo } from "../../src/server/curriculum/sql-repo";
import * as nodeReview from "../../src/app/api/v1/admin/curriculum/[nodeId]/review/route";
import * as curriculum from "../../src/app/api/v1/admin/curriculum/route";
import * as plans from "../../src/app/api/v1/admin/school-plans/route";
import * as imports from "../../src/app/api/v1/admin/imports/route";
import * as job from "../../src/app/api/v1/admin/imports/[jobId]/route";
import * as jobReview from "../../src/app/api/v1/admin/imports/[jobId]/review/route";
import * as jobFile from "../../src/app/api/v1/admin/imports/[jobId]/file/route";
import * as localObject from "../../src/app/api/v1/admin/imports/local-object/route";
import { FakeAdultAuth, ORIGIN, OWNER_A, GUARDIAN_A, req } from "../fakes";

const HH_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const OWNER_B = { userId: "b0000000-0000-4000-8000-0000000000b1", email: "owner-b@bnl.test" };
const EDITOR = { userId: "e0000000-0000-4000-8000-0000000000e1", email: "editor@bnl.test" };
const REVIEWER = { userId: "e0000000-0000-4000-8000-0000000000e2", email: "reviewer@bnl.test" };
const EDITOR_REVIEWER = { userId: "e0000000-0000-4000-8000-0000000000e5", email: "both@bnl.test" };

const url = process.env.BNL_TEST_DB_URL;
const adminUrl = process.env.BNL_TEST_ADMIN_URL;
if (!url || !adminUrl) throw new Error("run via: pnpm --filter @bnl/admin test:integration");

let db: Db;
let admin: Db;
let auth: FakeAdultAuth;
let storageDir: string;
let local: LocalFsStorage;

beforeAll(() => {
  db = createDb(url, { max: 4 });
  admin = createDb(adminUrl, { max: 2 });
  storageDir = mkdtempSync(join(tmpdir(), "bnl-a3-int-"));
});
afterAll(async () => {
  setDepsForTesting(null);
  setCurriculumDepsForTesting(null);
  await db.end();
  await admin.end();
  rmSync(storageDir, { recursive: true, force: true });
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
  local = new LocalFsStorage(storageDir, { signingKey: new Uint8Array(32).fill(3), baseUrl: LOCAL_OBJECT_PATH });
  const cdeps: CurriculumDeps = { repo: sqlCurriculumRepo, storage: local, localStorage: local, importMaxBytes: 20 * 1024 * 1024, signedUrlTtlSeconds: 60, suggestThreshold: 0.2 };
  setCurriculumDepsForTesting(cdeps);
});

const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });
const nodeId = async (stableKey: string) => String((await admin`select id from bnl.curriculum_nodes where stable_key = ${stableKey}`)[0]?.id);
const sourceDoc = async () => String((await admin`select id from bnl.source_documents order by title limit 1`)[0]?.id);
const withKey = (r: Request, key: string) => {
  const h = new Headers(r.headers);
  h.set("Idempotency-Key", key);
  return new Request(r.url, { method: r.method, headers: h, body: r.body, duplex: "half" } as RequestInit);
};
function csvUpload(session: string, planId: string, csv: string, key: string): Request {
  const base = req("POST", "/api/v1/admin/imports", { session });
  const h = new Headers(base.headers);
  h.set("Idempotency-Key", key);
  const form = new FormData();
  form.set("file", new File([csv], "term1.csv", { type: "text/csv" }));
  form.set("school_plan_id", planId);
  return new Request(base.url, { method: "POST", headers: h, body: form });
}
async function newPlan(session: string, year = `20${Math.floor(30 + Math.random() * 60)}`): Promise<string> {
  const res = await plans.POST(req("POST", "/api/v1/admin/school-plans", { session, body: { grade: 2, subject_key: "math", academic_year: year, school_label: "SYNTHETIC School" } }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { school_plan: { id: string } }).school_plan.id;
}
async function publicationSnapshot() {
  const [pubs] = await admin`select count(*)::int as n, coalesce(max(published_at)::text, '') as last from bnl.publication_records`;
  const manifests = await admin`select revision, checksum from bnl.published_manifests order by revision`;
  const [lessons] = await admin`select count(*)::int as n from bnl.lessons`;
  const [versions] = await admin`select count(*)::int as n from bnl.lesson_versions`;
  return { pubs, manifests, lessons, versions };
}

describe("CAT-006: verified CISCE outcomes need a source document, page and a reviewer", () => {
  it("editor submits, editor cannot verify, reviewer verifies with citation; audited without household", async () => {
    const id = await nodeId("grade2.math.geometry");
    const review = (who: { userId: string; email: string }, body: unknown) =>
      nodeReview.POST(req("POST", `/api/v1/admin/curriculum/${id}/review`, { session: auth.sessionFor(who), body }), p({ nodeId: id }));
    const doc = await sourceDoc();
    expect((await review(EDITOR, { action: "submit" })).status).toBe(200);
    expect((await review(EDITOR, { action: "verify", source_document_id: doc, source_ref: "p. 12", authority: "cisce_verified" })).status).toBe(403);
    expect((await review(REVIEWER, { action: "verify", source_document_id: randomUUID(), source_ref: "p. 12", authority: "cisce_verified" })).status).toBe(422);
    const ok = await review(REVIEWER, { action: "verify", source_document_id: doc, source_ref: "p. 12, Geometry", authority: "cisce_verified" });
    expect(ok.status).toBe(200);
    const [row] = await admin`select authority, review_status, source_document_id, source_ref, reviewed_by from bnl.curriculum_nodes where id = ${id}`;
    expect(row).toMatchObject({ authority: "cisce_verified", review_status: "verified", source_document_id: doc, source_ref: "p. 12, Geometry", reviewed_by: REVIEWER.userId });
    const audits = await admin`select action, actor_auth_id, household_id from bnl.audit_logs where target_id = ${id} order by created_at`;
    expect(audits.map((a) => [a.action, a.actor_auth_id, a.household_id])).toEqual([
      ["curriculum.node_submitted", EDITOR.userId, null],
      ["curriculum.node_verified", REVIEWER.userId, null],
    ]);
  });

  it("a reviewer cannot verify their own submission", async () => {
    const id = await nodeId("grade2.math.measurement");
    const review = (body: unknown) => nodeReview.POST(req("POST", `/api/v1/admin/curriculum/${id}/review`, { session: auth.sessionFor(EDITOR_REVIEWER), body }), p({ nodeId: id }));
    expect((await review({ action: "submit" })).status).toBe(200);
    expect((await review({ action: "verify", source_document_id: await sourceDoc(), source_ref: "p. 3", authority: "cisce_verified" })).status).toBe(403);
  });

  it("the DB refuses an editor setting authority directly, and cisce_verified without verification (0004)", async () => {
    const id = await nodeId("grade2.math.data_handling");
    await expect(
      withDbContext(db, { kind: "staff", userId: EDITOR.userId }, (sql) => sql`update bnl.curriculum_nodes set authority = 'local_enrichment' where id = ${id}`),
    ).rejects.toMatchObject({ code: "42501" });
    const doc = await sourceDoc();
    await expect(
      withDbContext(db, { kind: "staff", userId: REVIEWER.userId }, (sql) => sql`update bnl.curriculum_nodes set authority = 'cisce_verified', source_document_id = ${doc}, source_ref = 'p. 1' where id = ${id}`),
    ).rejects.toMatchObject({ code: "22023" });
  });

  it("the editorial seed stays visibly unverified in the explorer", async () => {
    const res = await curriculum.GET(req("GET", "/api/v1/admin/curriculum?grade=6&subject_key=physics", { session: auth.sessionFor(GUARDIAN_A) }));
    expect(res.status).toBe(200);
    const { nodes } = (await res.json()) as { nodes: { authority: string; provenance: { editorial_unverified: boolean } }[] };
    expect(nodes.length).toBeGreaterThan(1);
    expect(nodes.every((n) => n.authority === "editorial_unverified" && n.provenance.editorial_unverified)).toBe(true);
  });
});

const CSV = "chapter_no,title,page_start,grade,subject\n1,Numbers up to 100,1,2,math\n2,Shapes and Patterns,14,2,math\n3,Tables of 2 to 10,30,2,math\n";

describe("CAT-009 / CAT-010: imports stage review candidates and never publish", () => {
  it("one-to-many suggestions, no publication rows, manifests unchanged — even after approval", async () => {
    const owner = auth.sessionFor(OWNER_A);
    const planId = await newPlan(owner);
    const before = await publicationSnapshot();
    const res = await imports.POST(csvUpload(owner, planId, CSV, `int-cat9-${randomUUID()}`));
    expect(res.status).toBe(202);
    const created = (await res.json()) as { job_id: string; duplicate_of: string | null; status: string; published: boolean };
    expect(created).toMatchObject({ duplicate_of: null, status: "review", published: false });

    const j = (await (await job.GET(req("GET", `/api/v1/admin/imports/${created.job_id}`, { session: auth.sessionFor(GUARDIAN_A) }), p({ jobId: created.job_id }))).json()) as {
      chapters: { id: string; title: string; suggestions: { stable_key: string; curriculum_node_id: string; state: string }[] }[];
    };
    const shapes = j.chapters.find((c) => c.title === "Shapes and Patterns")!;
    expect(shapes.suggestions.map((s) => s.stable_key).sort()).toEqual(["grade2.math.geometry", "grade2.math.patterns"]);
    expect(j.chapters.flatMap((c) => c.suggestions).every((s) => s.state === "suggested")).toBe(true);
    expect(await publicationSnapshot()).toEqual(before);

    const decided = await jobReview.POST(
      req("POST", `/api/v1/admin/imports/${created.job_id}/review`, {
        session: auth.sessionFor(GUARDIAN_A),
        body: { decisions: shapes.suggestions.map((s) => ({ chapter_id: shapes.id, curriculum_node_id: s.curriculum_node_id, decision: "approve" })) },
      }),
      p({ jobId: created.job_id }),
    );
    expect(decided.status).toBe(200);
    const rows = await admin`select state, reviewer_auth_id, reviewed_at from bnl.chapter_topic_mappings where chapter_id = ${shapes.id}`;
    expect(rows.every((r) => r.state === "approved" && r.reviewer_auth_id === GUARDIAN_A.userId && r.reviewed_at instanceof Date)).toBe(true);
    expect(await publicationSnapshot()).toEqual(before);
    const [upload] = await admin`select u.object_key, u.original_filename, u.status from bnl.syllabus_uploads u join bnl.import_jobs j on j.upload_id = u.id where j.id = ${created.job_id}`;
    expect(String(upload?.object_key)).toMatch(new RegExp(`^${HH_A}/[0-9a-f-]{36}$`));
  });

  it("CAT-010: the same checksum for the same plan returns the existing job and adds no chapters or mappings", async () => {
    const owner = auth.sessionFor(OWNER_A);
    const planId = await newPlan(owner);
    const first = (await (await imports.POST(csvUpload(owner, planId, CSV, `int-dup-a-${randomUUID()}`))).json()) as { job_id: string };
    const count = async () => (await admin`select (select count(*) from bnl.syllabus_uploads where school_plan_id = ${planId})::int as u,
      (select count(*) from bnl.import_jobs where school_plan_id = ${planId})::int as j,
      (select count(*) from bnl.syllabus_chapters where school_plan_id = ${planId})::int as c,
      (select count(*) from bnl.chapter_topic_mappings m join bnl.syllabus_chapters c on c.id = m.chapter_id where c.school_plan_id = ${planId})::int as m`)[0];
    const before = await count();
    const pubs = await publicationSnapshot();
    const dup = await imports.POST(csvUpload(owner, planId, CSV, `int-dup-b-${randomUUID()}`));
    expect(dup.status).toBe(202);
    expect(await dup.json()).toMatchObject({ job_id: first.job_id, duplicate_of: first.job_id, published: false });
    expect(await count()).toEqual(before);
    expect(await publicationSnapshot()).toEqual(pubs);
    // The DB unique index backs this up against concurrent duplicates.
    await expect(
      withDbContext(db, { kind: "adult", userId: OWNER_A.userId }, (sql) => sql`
        insert into bnl.syllabus_uploads (household_id, school_plan_id, object_key, sha256, mime_type, size_bytes)
        select household_id, school_plan_id, household_id::text || '/dup-' || gen_random_uuid(), sha256, mime_type, size_bytes
          from bnl.syllabus_uploads where school_plan_id = ${planId} limit 1`),
    ).rejects.toMatchObject({ code: "23505" });
  });
});

describe("approved mappings are immutable in the database (0004)", () => {
  it("adults cannot update/delete an approved mapping or forge the reviewer", async () => {
    const owner = auth.sessionFor(OWNER_A);
    const planId = await newPlan(owner);
    const created = (await (await imports.POST(csvUpload(owner, planId, CSV, `int-imm-${randomUUID()}`))).json()) as { job_id: string };
    const [m] = await admin`select m.id, m.chapter_id, m.curriculum_node_id from bnl.chapter_topic_mappings m
      join bnl.syllabus_chapters c on c.id = m.chapter_id where c.school_plan_id = ${planId} limit 1`;
    const decide = (decision: string) =>
      jobReview.POST(req("POST", `/api/v1/admin/imports/${created.job_id}/review`, { session: owner, body: { decisions: [{ chapter_id: m!.chapter_id, curriculum_node_id: m!.curriculum_node_id, decision }] } }), p({ jobId: created.job_id }));
    expect((await decide("approve")).status).toBe(200);
    expect((await decide("reject")).status).toBe(409);
    const asOwner = <T>(fn: (sql: Parameters<Parameters<typeof withDbContext>[2]>[0]) => Promise<T>) => withDbContext(db, { kind: "adult", userId: OWNER_A.userId }, fn);
    await expect(asOwner((sql) => sql`update bnl.chapter_topic_mappings set state = 'rejected' where id = ${m!.id}`)).rejects.toMatchObject({ code: "55000" });
    await expect(asOwner((sql) => sql`delete from bnl.chapter_topic_mappings where id = ${m!.id}`)).rejects.toMatchObject({ code: "55000" });
    const other = String((await admin`select id from bnl.curriculum_nodes where stable_key = 'grade2.math.data_handling'`)[0]?.id);
    await expect(
      asOwner((sql) => sql`insert into bnl.chapter_topic_mappings (household_id, chapter_id, curriculum_node_id, state, reviewer_auth_id, reviewed_at)
        values (${HH_A}, ${m!.chapter_id}, ${other}, 'approved', ${GUARDIAN_A.userId}, now())`),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("cross-household denial and SEC-007 private file access", () => {
  async function importForA() {
    const owner = auth.sessionFor(OWNER_A);
    const planId = await newPlan(owner);
    const body = `chapter_no,title,page_start,grade,subject\n1,Synthetic chapter ${randomUUID().slice(0, 8)},1,2,math\n`;
    const created = (await (await imports.POST(csvUpload(owner, planId, body, `int-x-${randomUUID()}`))).json()) as { job_id: string };
    return { planId, jobId: created.job_id, body };
  }

  it("household B cannot read, review or download A's import, nor import into A's plan", async () => {
    const { planId, jobId } = await importForA();
    const b = auth.sessionFor(OWNER_B);
    expect((await job.GET(req("GET", `/api/v1/admin/imports/${jobId}`, { session: b }), p({ jobId }))).status).toBe(404);
    expect((await jobFile.GET(req("GET", `/api/v1/admin/imports/${jobId}/file`, { session: b }), p({ jobId }))).status).toBe(404);
    const [ch] = await admin`select id from bnl.syllabus_chapters where school_plan_id = ${planId} limit 1`;
    const node = await nodeId("grade2.math.patterns");
    expect((await jobReview.POST(req("POST", `/api/v1/admin/imports/${jobId}/review`, { session: b, body: { decisions: [{ chapter_id: ch!.id, curriculum_node_id: node, decision: "approve" }] } }), p({ jobId }))).status).toBe(404);
    expect((await imports.POST(withKey(req("POST", "/api/v1/admin/imports", { session: b, body: { school_plan_id: planId, toc_text: "1. Hijack ..... 1" } }), `int-x2-${randomUUID()}`))).status).toBe(404);
    // RLS alone hides A's rows from B.
    const seen = await withDbContext(db, { kind: "adult", userId: OWNER_B.userId }, (sql) => sql`
      select (select count(*) from bnl.import_jobs where id = ${jobId})::int as jobs,
             (select count(*) from bnl.syllabus_chapters where school_plan_id = ${planId})::int as chapters,
             (select count(*) from bnl.syllabus_uploads where school_plan_id = ${planId})::int as uploads`);
    expect(seen[0]).toEqual({ jobs: 0, chapters: 0, uploads: 0 });
    // Staff roles grant no household data (ADR-0003).
    const staffSees = await withDbContext(db, { kind: "staff", userId: REVIEWER.userId }, (sql) => sql`select count(*)::int as n from bnl.import_jobs`).catch((e: { code?: string }) => e.code);
    expect(staffSees).toBe("42501");
  });

  it("the owning household gets a short-lived signed URL; others and tampered URLs get nothing", async () => {
    const { jobId, body } = await importForA();
    const res = await jobFile.GET(req("GET", `/api/v1/admin/imports/${jobId}/file`, { session: auth.sessionFor(GUARDIAN_A) }), p({ jobId }));
    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    expect(location.startsWith(`${LOCAL_OBJECT_PATH}?`)).toBe(true);
    expect(location).not.toContain("term1");
    const fetchAs = (session: string | undefined, u: string) => localObject.GET(req("GET", u, session ? { session } : {}));
    const ok = await fetchAs(auth.sessionFor(OWNER_A), location);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-disposition")).toContain("attachment");
    expect(await ok.text()).toBe(body);
    expect((await fetchAs(auth.sessionFor(OWNER_B), location)).status).toBe(404);
    expect((await fetchAs(undefined, location)).status).toBe(401);
    expect((await fetchAs(auth.sessionFor(OWNER_A), location.replace(/s=[^&]+/, "s=AAAA"))).status).toBe(404);
    const audits = await admin`select action from bnl.audit_logs where target_id = ${jobId}`;
    expect(audits.map((a) => a.action)).toContain("import.file_accessed");
  });
});
