/**
 * Route tests (fakes) for curriculum explorer/review (M02) and school import/mapping (M03).
 * Real RLS behaviour is covered by test/integration/curriculum-*.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "@bnl/contracts";
import { setDepsForTesting } from "../../src/server/deps";
import { setCurriculumDepsForTesting } from "../../src/server/curriculum/deps";
import * as curriculum from "../../src/app/api/v1/admin/curriculum/route";
import * as nodeReview from "../../src/app/api/v1/admin/curriculum/[nodeId]/review/route";
import * as plans from "../../src/app/api/v1/admin/school-plans/route";
import * as imports from "../../src/app/api/v1/admin/imports/route";
import * as job from "../../src/app/api/v1/admin/imports/[jobId]/route";
import * as jobReview from "../../src/app/api/v1/admin/imports/[jobId]/review/route";
import * as jobFile from "../../src/app/api/v1/admin/imports/[jobId]/file/route";
import * as localObject from "../../src/app/api/v1/admin/imports/local-object/route";
import { GUARDIAN_A, HH_A, OUTSIDER, OWNER_A, OWNER_B, bodyOf, req, type ReqOpts } from "../fakes";
import { NODE_IDS, SOURCE_DOC, makeCurriculumEnv, type CurriculumTestEnv } from "./fakes";

const EDITOR = { userId: "e0000000-0000-4000-8000-0000000000e1", email: "editor@bnl.test" };
const REVIEWER = { userId: "e0000000-0000-4000-8000-0000000000e2", email: "reviewer@bnl.test" };
const EDITOR_REVIEWER = { userId: "e0000000-0000-4000-8000-0000000000e5", email: "both@bnl.test" };

let env: CurriculumTestEnv;
beforeEach(() => {
  env = makeCurriculumEnv();
  env.store.staff.push(
    { userId: EDITOR.userId, role: "editor", revokedAt: null },
    { userId: REVIEWER.userId, role: "reviewer", revokedAt: null },
    { userId: EDITOR_REVIEWER.userId, role: "editor", revokedAt: null },
    { userId: EDITOR_REVIEWER.userId, role: "reviewer", revokedAt: null },
  );
  setDepsForTesting(env.deps);
  setCurriculumDepsForTesting(env.cdeps);
});
afterEach(() => {
  setDepsForTesting(null);
  setCurriculumDepsForTesting(null);
});

const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });
const sess = (who: { userId: string; email: string }) => env.auth.sessionFor(who);
const withKey = (r: Request, key: string | null): Request => {
  const h = new Headers(r.headers);
  if (key !== null) h.set("Idempotency-Key", key);
  return new Request(r.url, { method: r.method, headers: h, body: r.body, duplex: "half" } as RequestInit);
};
function multipart(session: string, file: { bytes: Uint8Array | string; name: string; type: string } | null, planId: string | null, key = "k-multipart-0001", o: ReqOpts = {}): Request {
  const base = req("POST", "/api/v1/admin/imports", { session, ...o });
  const form = new FormData();
  if (file) form.set("file", new File([typeof file.bytes === "string" ? file.bytes : file.bytes.slice().buffer as ArrayBuffer], file.name, { type: file.type }));
  if (planId) form.set("school_plan_id", planId);
  const h = new Headers(base.headers);
  h.set("Idempotency-Key", key);
  return new Request(base.url, { method: "POST", headers: h, body: form });
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = ApiError.parse(await res.json());
  expect(body.error.code).toBe(code);
  expect(res.headers.get("x-request-id")).toBe(body.error.request_id);
  return body;
}

async function createPlan(session: string, over: Record<string, unknown> = {}): Promise<string> {
  const res = await plans.POST(req("POST", "/api/v1/admin/school-plans", { session, body: { grade: 2, subject_key: "math", academic_year: "2026-27", school_label: "Synthetic School", textbook_title: "Synthetic Maths 2", edition: "3rd", ...over } }));
  expect(res.status).toBe(201);
  return ((await bodyOf(res)).school_plan as { id: string }).id;
}

const TOC = "1. Numbers up to 100 ........ 1\n2. Shapes and Patterns ........ 14\n3. Tables of 2 to 10 ........ 30\n";
async function pasteImport(session: string, planId: string, key = "k-paste-0000001", toc = TOC, format = "lines") {
  return imports.POST(withKey(req("POST", "/api/v1/admin/imports", { session, body: { school_plan_id: planId, toc_text: toc, format } }), key));
}

describe("SEC-001: every new route requires an adult session", () => {
  const JOB = "9a000000-0000-4000-8000-000000000001";
  const cases: [string, () => Promise<Response>][] = [
    ["GET curriculum", () => curriculum.GET(req("GET", "/api/v1/admin/curriculum"))],
    ["POST node review", () => nodeReview.POST(req("POST", `/api/v1/admin/curriculum/${NODE_IDS.geometry}/review`, { body: { action: "submit" } }), p({ nodeId: NODE_IDS.geometry }))],
    ["GET school-plans", () => plans.GET(req("GET", "/api/v1/admin/school-plans"))],
    ["POST school-plans", () => plans.POST(req("POST", "/api/v1/admin/school-plans", { body: {} }))],
    ["GET imports", () => imports.GET(req("GET", "/api/v1/admin/imports"))],
    ["POST imports", () => imports.POST(req("POST", "/api/v1/admin/imports", { body: {} }))],
    ["GET job", () => job.GET(req("GET", `/api/v1/admin/imports/${JOB}`), p({ jobId: JOB }))],
    ["POST job review", () => jobReview.POST(req("POST", `/api/v1/admin/imports/${JOB}/review`, { body: {} }), p({ jobId: JOB }))],
    ["GET job file", () => jobFile.GET(req("GET", `/api/v1/admin/imports/${JOB}/file`), p({ jobId: JOB }))],
    ["GET local object", () => localObject.GET(req("GET", "/api/v1/admin/imports/local-object?b=x"))],
  ];
  it.each(cases)("%s → 401", async (_n, call) => {
    await expectError(await call(), 401, "unauthorized");
    expect(env.store.audit).toHaveLength(0);
  });
});

describe("GET /admin/curriculum", () => {
  it("guardians browse read-only; editorial seed is flagged unverified", async () => {
    const res = await curriculum.GET(req("GET", "/api/v1/admin/curriculum?grade=2&subject_key=math", { session: sess(GUARDIAN_A) }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { nodes: { stable_key: string; authority: string; authority_label: string; provenance: { editorial_unverified: boolean } }[]; viewer: { can_review: boolean } };
    expect(body.nodes.map((n) => n.stable_key)[0]).toBe("grade2.math");
    expect(body.nodes.every((n) => n.authority === "editorial_unverified" && n.provenance.editorial_unverified && n.authority_label === "Editorial (unverified)")).toBe(true);
    expect(body.viewer.can_review).toBe(false);
    expect(env.contexts.at(-1)).toEqual({ kind: "adult", userId: GUARDIAN_A.userId });
  });

  it("staff without a household read in the staff context; outsiders are 403", async () => {
    const res = await curriculum.GET(req("GET", "/api/v1/admin/curriculum", { session: sess(REVIEWER) }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { viewer: { can_review: boolean } }).viewer.can_review).toBe(true);
    expect(env.contexts.at(-1)).toEqual({ kind: "staff", userId: REVIEWER.userId });
    await expectError(await curriculum.GET(req("GET", "/api/v1/admin/curriculum", { session: sess(OUTSIDER) })), 403, "forbidden");
  });

  it("filters, searches and paginates with an opaque cursor", async () => {
    const s = sess(OWNER_A);
    const q = await curriculum.GET(req("GET", "/api/v1/admin/curriculum?q=GEOM", { session: s }));
    expect(((await q.json()) as { nodes: { stable_key: string }[] }).nodes.map((n) => n.stable_key)).toEqual(["grade2.math.geometry", "grade6.math.geometry"]);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const url: string = `/api/v1/admin/curriculum?grade=2&limit=3${cursor ? `&cursor=${cursor}` : ""}`;
      const page = (await (await curriculum.GET(req("GET", url, { session: s }))).json()) as { nodes: { stable_key: string }[]; next_cursor: string | null };
      seen.push(...page.nodes.map((n) => n.stable_key));
      cursor = page.next_cursor;
    } while (cursor);
    expect(seen).toHaveLength(env.cs.nodes.filter((n) => n.grade === 2).length);
    expect(new Set(seen).size).toBe(seen.length);
    await expectError(await curriculum.GET(req("GET", "/api/v1/admin/curriculum?limit=101", { session: s })), 422, "validation_failed");
    await expectError(await curriculum.GET(req("GET", "/api/v1/admin/curriculum?grade=3", { session: s })), 422, "validation_failed");
    await expectError(await curriculum.GET(req("GET", "/api/v1/admin/curriculum?cursor=bm9wZQ", { session: s })), 422, "validation_failed");
  });
});

describe("POST /admin/curriculum/{nodeId}/review (CAT-006)", () => {
  const review = (who: { userId: string; email: string }, body: unknown, nodeId: string = NODE_IDS.geometry, o: ReqOpts = {}) =>
    nodeReview.POST(req("POST", `/api/v1/admin/curriculum/${nodeId}/review`, { session: sess(who), body, ...o }), p({ nodeId }));
  const verify = { action: "verify", source_document_id: SOURCE_DOC, source_ref: "p. 42, §3.1", authority: "cisce_verified" };

  it("editor submits; editor cannot verify; a different reviewer verifies with a citation", async () => {
    expect((await review(EDITOR, { action: "submit" })).status).toBe(200);
    await expectError(await review(EDITOR, verify), 403, "forbidden");
    const res = await review(REVIEWER, verify);
    expect(res.status).toBe(200);
    const { node } = (await res.json()) as { node: { authority: string; review_status: string; source_ref: string; provenance: { editorial_unverified: boolean } } };
    expect(node).toMatchObject({ authority: "cisce_verified", review_status: "verified", source_ref: "p. 42, §3.1", provenance: { editorial_unverified: false } });
    expect(env.cs.nodes.find((n) => n.id === NODE_IDS.geometry)?.reviewedBy).toBe(REVIEWER.userId);
    expect(env.store.audit.map((a) => [a.action, a.actorAuthId, a.householdId])).toEqual([
      ["curriculum.node_submitted", EDITOR.userId, null],
      ["curriculum.node_verified", REVIEWER.userId, null],
    ]);
  });

  it("verify requires source_document_id + source_ref, an existing document and a submitted node", async () => {
    await expectError(await review(REVIEWER, { action: "verify", authority: "cisce_verified" }), 422, "validation_failed");
    await expectError(await review(REVIEWER, { ...verify, source_ref: "" }), 422, "validation_failed");
    await expectError(await review(REVIEWER, verify), 409, "conflict"); // still draft
    await review(EDITOR, { action: "submit" });
    await expectError(await review(REVIEWER, { ...verify, source_document_id: "5d0c0000-0000-4000-8000-0000000000ff" }), 422, "validation_failed");
    expect(env.cs.nodes.find((n) => n.id === NODE_IDS.geometry)?.authority).toBe("editorial_unverified");
  });

  it("a reviewer cannot verify their own submission", async () => {
    expect((await review(EDITOR_REVIEWER, { action: "submit" })).status).toBe(200);
    await expectError(await review(EDITOR_REVIEWER, verify), 403, "forbidden");
  });

  it("enrichment subjects cannot become CISCE-verified; local_enrichment verification is allowed", async () => {
    await review(EDITOR, { action: "submit" }, NODE_IDS.aadritha);
    await expectError(await review(REVIEWER, verify, NODE_IDS.aadritha), 422, "validation_failed");
    expect((await review(REVIEWER, { ...verify, authority: "local_enrichment" }, NODE_IDS.aadritha)).status).toBe(200);
  });

  it("archive needs a reason, keeps it out of the audit metadata, and is reviewer-only", async () => {
    await expectError(await review(EDITOR, { action: "archive", reason: "dup" }), 403, "forbidden");
    await expectError(await review(REVIEWER, { action: "archive" }), 422, "validation_failed");
    expect((await review(REVIEWER, { action: "archive", reason: "Duplicate of numbers topic" })).status).toBe(200);
    expect(JSON.stringify(env.store.audit)).not.toContain("Duplicate");
    await expectError(await review(REVIEWER, { action: "archive", reason: "again" }), 409, "conflict");
  });

  it("guardians (no staff role) are 403; CSRF is enforced; unknown nodes are 404", async () => {
    await expectError(await review(GUARDIAN_A, { action: "submit" }), 403, "forbidden");
    await expectError(await review(EDITOR, { action: "submit" }, NODE_IDS.geometry, { csrfHeader: "wrong" }), 403, "forbidden");
    await expectError(await review(EDITOR, { action: "submit" }, NODE_IDS.geometry, { origin: "https://evil.example" }), 403, "forbidden");
    await expectError(await review(EDITOR, { action: "submit" }, "0a000000-0000-4000-8000-0000000000ff"), 404, "not_found");
    await expectError(await review(EDITOR, { action: "submit" }, "not-a-uuid"), 404, "not_found");
    expect(env.cs.nodes.every((n) => n.reviewStatus === "draft")).toBe(true);
  });
});

describe("POST /admin/school-plans", () => {
  it("creates a household-scoped plan and audits it", async () => {
    const id = await createPlan(sess(GUARDIAN_A));
    expect(env.cs.plans.find((x) => x.id === id)?.householdId).toBe(HH_A);
    expect(env.store.audit.at(-1)).toMatchObject({ action: "school_plan.created", householdId: HH_A });
    const list = (await (await plans.GET(req("GET", "/api/v1/admin/school-plans", { session: sess(OWNER_B) }))).json()) as { school_plans: unknown[] };
    expect(list.school_plans).toEqual([]);
  });

  it("validates grade/subject, rejects markup and unknown fields, enforces CSRF and household", async () => {
    const s = sess(OWNER_A);
    const post = (body: unknown, o: ReqOpts = {}) => plans.POST(req("POST", "/api/v1/admin/school-plans", { session: s, body, ...o }));
    const ok = { grade: 2, subject_key: "math", academic_year: "2026-27" };
    await expectError(await post({ ...ok, subject_key: "physics" }), 422, "validation_failed");
    await expectError(await post({ ...ok, academic_year: "next year" }), 422, "validation_failed");
    await expectError(await post({ ...ok, school_label: "<script>alert(1)</script>" }), 422, "validation_failed");
    await expectError(await post({ ...ok, household_id: "b0000000-0000-4000-8000-00000000000b" }), 422, "validation_failed");
    await expectError(await post(ok, { csrf: false }), 403, "forbidden");
    await expectError(await plans.POST(req("POST", "/api/v1/admin/school-plans", { session: sess(OUTSIDER), body: ok })), 403, "forbidden");
    expect(env.cs.plans).toHaveLength(0);
  });
});

describe("POST /admin/imports", () => {
  it("stages chapters and suggestions from a pasted TOC, stores privately, publishes nothing (CAT-009)", async () => {
    const planId = await createPlan(sess(OWNER_A));
    const res = await pasteImport(sess(OWNER_A), planId);
    expect(res.status).toBe(202);
    const body = await bodyOf(res);
    expect(body).toMatchObject({ duplicate_of: null, status: "review", chapters: 3, published: false });
    const upload = env.cs.uploads[0]!;
    expect(upload.objectKey).toMatch(new RegExp(`^${HH_A}/[0-9a-f-]{36}$`));
    expect(upload.originalFilename).toBeNull();
    expect(env.storage.objects.has(`school-syllabi/${upload.objectKey}`)).toBe(true);
    expect(env.cs.mappings.every((m) => m.state === "suggested")).toBe(true);
    const shapes = env.cs.chapters.find((c) => c.title === "Shapes and Patterns")!;
    expect(env.cs.mappings.filter((m) => m.chapterId === shapes.id).map((m) => m.curriculumNodeId).sort()).toEqual([NODE_IDS.geometry, NODE_IDS.patterns].sort());

    const jobRes = await job.GET(req("GET", `/api/v1/admin/imports/${String(body.job_id)}`, { session: sess(GUARDIAN_A) }), p({ jobId: String(body.job_id) }));
    expect(jobRes.status).toBe(200);
    const j = (await jobRes.json()) as { status: string; published: boolean; chapters: { title: string; page_start: number; suggestions: { confidence: number; state: string }[] }[] };
    expect(j.status).toBe("review");
    expect(j.published).toBe(false);
    expect(j.chapters.map((c) => [c.title, c.page_start])).toEqual([["Numbers up to 100", 1], ["Shapes and Patterns", 14], ["Tables of 2 to 10", 30]]);
    expect(j.chapters[2]!.suggestions[0]).toMatchObject({ confidence: 1, state: "suggested" });
  });

  it("requires Idempotency-Key; replays the same response; rejects a reused key with a different body", async () => {
    const s = sess(OWNER_A);
    const planId = await createPlan(s);
    await expectError(await imports.POST(withKey(req("POST", "/api/v1/admin/imports", { session: s, body: { school_plan_id: planId, toc_text: TOC } }), null)), 400, "validation_failed");
    await expectError(await imports.POST(withKey(req("POST", "/api/v1/admin/imports", { session: s, body: { school_plan_id: planId, toc_text: TOC } }), "bad key!")), 400, "validation_failed");
    const first = await bodyOf(await pasteImport(s, planId, "k-same-00000001"));
    const again = await pasteImport(s, planId, "k-same-00000001");
    expect(again.status).toBe(202);
    expect(await bodyOf(again)).toEqual(first);
    expect(env.cs.jobs).toHaveLength(1);
    await expectError(await pasteImport(s, planId, "k-same-00000001", "1. Other ..... 3"), 409, "idempotency_conflict");
  });

  it("CAT-010: the same file again returns the existing job and stages nothing new", async () => {
    const s = sess(OWNER_A);
    const planId = await createPlan(s);
    const first = await bodyOf(await pasteImport(s, planId, "k-dup-000000001"));
    const counts = () => [env.cs.uploads.length, env.cs.jobs.length, env.cs.chapters.length, env.cs.mappings.length, env.storage.objects.size];
    const before = counts();
    const dup = await pasteImport(s, planId, "k-dup-000000002");
    expect(dup.status).toBe(202);
    expect(await bodyOf(dup)).toMatchObject({ job_id: first.job_id, duplicate_of: first.job_id, chapters: 0, published: false });
    expect(counts()).toEqual(before);
    // A different plan is a different import.
    const plan2 = await createPlan(s, { academic_year: "2027-28" });
    expect((await bodyOf(await pasteImport(s, plan2, "k-dup-000000003"))).duplicate_of).toBeNull();
  });

  it("multipart CSV upload: CSV injection is escaped, markup rows are rejected, filename sanitised", async () => {
    const s = sess(OWNER_A);
    const planId = await createPlan(s);
    const csv = 'chapter_no,title,page_start,grade,subject\n1,Shapes,3,2,math\n2,"=HYPERLINK(""http://x"")",5,2,math\n3,<img src=x onerror=alert(1)>,7,2,math\n';
    const res = await imports.POST(multipart(s, { bytes: csv, name: "../../etc/Term 1 <TOC>.csv", type: "text/csv" }, planId));
    expect(res.status).toBe(202);
    const jobId = String((await bodyOf(res)).job_id);
    expect(env.cs.chapters.map((c) => c.title)).toEqual(["Shapes", `'=HYPERLINK("http://x")`]);
    expect(env.cs.uploads[0]).toMatchObject({ mimeType: "text/csv", originalFilename: "Term_1_TOC_.csv" });
    expect(env.cs.uploads[0]!.objectKey).not.toContain("Term");
    const j = (await (await job.GET(req("GET", `/api/v1/admin/imports/${jobId}`, { session: s }), p({ jobId }))).json()) as { errors: { row: number; code: string }[] };
    expect(j.errors.map((e) => `${e.row}:${e.code}`)).toEqual(["3:formula_escaped", "4:markup_not_allowed"]);
  });

  it("413 for oversized uploads (declared and actual), 415 for wrong type or magic", async () => {
    const s = sess(OWNER_A);
    const planId = await createPlan(s);
    const big = new Uint8Array(env.cdeps.importMaxBytes + 1).fill(0x41);
    await expectError(await imports.POST(multipart(s, { bytes: big, name: "toc.txt", type: "text/plain" }, planId)), 413, "payload_too_large");
    const declared = withKey(req("POST", "/api/v1/admin/imports", { session: s, rawBody: "x", contentType: "multipart/form-data; boundary=x" }), "k-413-00000001");
    const h = new Headers(declared.headers);
    h.set("content-length", String(50 * 1024 * 1024));
    await expectError(await imports.POST(new Request(declared.url, { method: "POST", headers: h, body: "x" })), 413, "payload_too_large");
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
    await expectError(await imports.POST(multipart(s, { bytes: exe, name: "toc.pdf", type: "application/pdf" }, planId, "k-415-00000001")), 415, "unsupported_media_type");
    await expectError(await imports.POST(multipart(s, { bytes: "1. Shapes ... 3", name: "toc.pdf", type: "application/pdf" }, planId, "k-415-00000002")), 415, "unsupported_media_type");
    await expectError(await imports.POST(multipart(s, { bytes: "%PDF-1.4 x", name: "toc.csv", type: "text/csv" }, planId, "k-415-00000003")), 415, "unsupported_media_type");
    await expectError(await imports.POST(withKey(req("POST", "/api/v1/admin/imports", { session: s, rawBody: "x", contentType: "text/html" }), "k-415-00000004")), 415, "unsupported_media_type");
    expect(env.cs.uploads).toHaveLength(0);
    expect(env.storage.objects.size).toBe(0);
  });

  it("an unreadable PDF is a failed job asking for a pasted TOC (no OCR queued)", async () => {
    const s = sess(OWNER_A);
    const planId = await createPlan(s);
    const res = await imports.POST(multipart(s, { bytes: "%PDF-1.4\n% scanned\n", name: "toc.pdf", type: "application/pdf" }, planId));
    expect(await bodyOf(res)).toMatchObject({ status: "failed", chapters: 0 });
    expect(env.cs.jobs[0]).toMatchObject({ status: "failed", jobType: "pdf_text" });
    expect(env.cs.jobs[0]!.errors[0]!.code).toBe("needs_manual_toc");
    expect(env.cs.jobs.some((j) => j.jobType === "ocr")).toBe(false);
  });

  it("cannot import into another household's plan; outsider has no household", async () => {
    const planA = await createPlan(sess(OWNER_A));
    await expectError(await pasteImport(sess(OWNER_B), planA, "k-cross-0000001"), 404, "not_found");
    await expectError(await pasteImport(sess(OUTSIDER), planA, "k-cross-0000002"), 403, "forbidden");
    await expectError(await imports.POST(withKey(req("POST", "/api/v1/admin/imports", { session: sess(OWNER_A), body: { school_plan_id: planA, toc_text: TOC }, csrf: false }), "k-csrf-00000001")), 403, "forbidden");
    expect(env.cs.jobs).toHaveLength(0);
  });

  it("rate-limits imports per adult", async () => {
    const s = sess(OWNER_A);
    const planId = await createPlan(s);
    for (let i = 0; i < 20; i++) expect((await pasteImport(s, planId, `k-rate-${String(i).padStart(8, "0")}`, `${i + 1}. Shapes ..... ${i + 1}`)).status).toBe(202);
    const res = await pasteImport(s, planId, "k-rate-99999999", "1. Last ..... 1");
    await expectError(res, 429, "rate_limited");
    expect(res.headers.get("retry-after")).toMatch(/^[0-9]+$/);
  });
});

describe("job access across households (SEC-007)", () => {
  async function jobOfA() {
    const planId = await createPlan(sess(OWNER_A));
    return String((await bodyOf(await pasteImport(sess(OWNER_A), planId))).job_id);
  }

  it("household B cannot read A's job or file; A gets a short-lived signed URL", async () => {
    const jobId = await jobOfA();
    await expectError(await job.GET(req("GET", `/api/v1/admin/imports/${jobId}`, { session: sess(OWNER_B) }), p({ jobId })), 404, "not_found");
    await expectError(await jobFile.GET(req("GET", `/api/v1/admin/imports/${jobId}/file`, { session: sess(OWNER_B) }), p({ jobId })), 404, "not_found");
    await expectError(await jobFile.GET(req("GET", `/api/v1/admin/imports/${jobId}/file`, { session: sess(OUTSIDER) }), p({ jobId })), 403, "forbidden");
    const res = await jobFile.GET(req("GET", `/api/v1/admin/imports/${jobId}/file`, { session: sess(GUARDIAN_A) }), p({ jobId }));
    expect(res.status).toBe(302);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const exp = Number(new URL(res.headers.get("location")!).searchParams.get("exp"));
    expect(exp - env.clock.now.getTime() / 1000).toBe(60);
    expect(env.store.audit.at(-1)).toMatchObject({ action: "import.file_accessed", householdId: HH_A });
    const list = (await (await imports.GET(req("GET", "/api/v1/admin/imports", { session: sess(OWNER_B) }))).json()) as { jobs: unknown[] };
    expect(list.jobs).toEqual([]);
  });

  it("household B cannot review A's mappings", async () => {
    const jobId = await jobOfA();
    const ch = env.cs.chapters[0]!;
    await expectError(
      await jobReview.POST(req("POST", `/api/v1/admin/imports/${jobId}/review`, { session: sess(OWNER_B), body: { decisions: [{ chapter_id: ch.id, curriculum_node_id: NODE_IDS.numbers, decision: "approve" }] } }), p({ jobId })),
      404,
      "not_found",
    );
    expect(env.cs.mappings.every((m) => m.state === "suggested")).toBe(true);
  });
});

describe("POST /admin/imports/{jobId}/review", () => {
  async function setup() {
    const s = sess(OWNER_A);
    const planId = await createPlan(s);
    const jobId = String((await bodyOf(await pasteImport(s, planId))).job_id);
    const shapes = env.cs.chapters.find((c) => c.title === "Shapes and Patterns")!;
    const decide = (decisions: unknown[], who = GUARDIAN_A) => jobReview.POST(req("POST", `/api/v1/admin/imports/${jobId}/review`, { session: sess(who), body: { decisions } }), p({ jobId }));
    return { jobId, shapes, decide };
  }

  it("records approve/reject with reviewer id and time; approved mappings are immutable; nothing is published", async () => {
    const { shapes, decide } = await setup();
    const res = await decide([
      { chapter_id: shapes.id, curriculum_node_id: NODE_IDS.geometry, decision: "approve" },
      { chapter_id: shapes.id, curriculum_node_id: NODE_IDS.patterns, decision: "approve" },
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { published: boolean; decisions: { state: string; reviewer_auth_id: string; reviewed_at: string; changed: boolean }[] };
    expect(body.published).toBe(false);
    expect(body.decisions.every((d) => d.state === "approved" && d.reviewer_auth_id === GUARDIAN_A.userId && d.reviewed_at === env.clock.now.toISOString() && d.changed)).toBe(true);
    expect(env.store.audit.at(-1)).toMatchObject({ action: "import.mappings_reviewed", actorAuthId: GUARDIAN_A.userId, householdId: HH_A });

    env.advance(60_000);
    const again = (await (await decide([{ chapter_id: shapes.id, curriculum_node_id: NODE_IDS.geometry, decision: "approve" }], OWNER_A)).json()) as { decisions: { changed: boolean; reviewer_auth_id: string }[] };
    expect(again.decisions[0]).toMatchObject({ changed: false, reviewer_auth_id: GUARDIAN_A.userId });
    await expectError(await decide([{ chapter_id: shapes.id, curriculum_node_id: NODE_IDS.geometry, decision: "reject" }], OWNER_A), 409, "conflict");
    expect(env.cs.mappings.find((m) => m.chapterId === shapes.id && m.curriculumNodeId === NODE_IDS.geometry)).toMatchObject({ state: "approved", reviewerAuthId: GUARDIAN_A.userId });
  });

  it("rejected suggestions can later be approved; overrides add an explicit approved row", async () => {
    const { shapes, decide } = await setup();
    expect((await decide([{ chapter_id: shapes.id, curriculum_node_id: NODE_IDS.patterns, decision: "reject" }])).status).toBe(200);
    expect((await decide([{ chapter_id: shapes.id, curriculum_node_id: NODE_IDS.patterns, decision: "approve" }])).status).toBe(200);
    expect((await decide([{ chapter_id: shapes.id, curriculum_node_id: NODE_IDS.measurement, decision: "approve" }])).status).toBe(200);
    expect(env.cs.mappings.find((m) => m.curriculumNodeId === NODE_IDS.measurement && m.chapterId === shapes.id)).toMatchObject({ state: "approved", confidence: null });
  });

  it("validates chapter membership, mappable topics, duplicates and CSRF atomically", async () => {
    const { shapes, decide, jobId } = await setup();
    const before = structuredClone(env.cs.mappings);
    await expectError(await decide([{ chapter_id: shapes.id, curriculum_node_id: NODE_IDS.g6geometry, decision: "approve" }]), 422, "validation_failed");
    await expectError(await decide([{ chapter_id: shapes.id, curriculum_node_id: NODE_IDS.subjectMath, decision: "approve" }]), 422, "validation_failed");
    await expectError(
      await decide([
        { chapter_id: shapes.id, curriculum_node_id: NODE_IDS.geometry, decision: "approve" },
        { chapter_id: "0c000000-0000-4000-8000-000000000000", curriculum_node_id: NODE_IDS.geometry, decision: "approve" },
      ]),
      422,
      "validation_failed",
    );
    await expectError(
      await decide([
        { chapter_id: shapes.id, curriculum_node_id: NODE_IDS.geometry, decision: "approve" },
        { chapter_id: shapes.id, curriculum_node_id: NODE_IDS.geometry, decision: "reject" },
      ]),
      422,
      "validation_failed",
    );
    await expectError(await decide([]), 422, "validation_failed");
    await expectError(
      await jobReview.POST(req("POST", `/api/v1/admin/imports/${jobId}/review`, { session: sess(OWNER_A), csrf: false, body: { decisions: [{ chapter_id: shapes.id, curriculum_node_id: NODE_IDS.geometry, decision: "approve" }] } }), p({ jobId })),
      403,
      "forbidden",
    );
    expect(env.cs.mappings).toEqual(before);
  });
});

describe("SEC-001: curriculum/import pages verify the session server-side", () => {
  it.each(["curriculum/page.tsx", "imports/page.tsx", "imports/[jobId]/page.tsx"])("%s calls requireAdultPage()", async (f) => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL(`../../src/app/admin/(portal)/${f}`, import.meta.url), "utf8");
    expect(src).toMatch(/await requireAdultPage\(\)/);
    // The guard runs before any data is loaded.
    expect(src.indexOf("await requireAdultPage()")).toBeLessThan(src.search(/load(ForHousehold|Curriculum)\(/));
  });
});
