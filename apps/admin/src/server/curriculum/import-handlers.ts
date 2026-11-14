import { createHash } from "node:crypto";
import { HttpError, type AdultIdentity } from "@bnl/auth";
import { GRADE_SUBJECTS, Grade, IDEMPOTENCY_HEADER, IdempotencyKey, MappingReviewRequest, SubjectKey, Uuid } from "@bnl/contracts";
import { extractChapters, suggestForChapter, type ExtractionResult, type SourceKind } from "@bnl/curriculum";
import { MIME_CSV, MIME_DOCX, MIME_PDF, MIME_TEXT, sniffMime } from "@bnl/storage";
import { z } from "zod";
import { requireAdult, requireCsrf, withAdultHousehold, type HouseholdMembership } from "../authn";
import type { Sql } from "../db-port";
import { empty, json, readJson, type Ctx } from "../http";
import { db, enforceCurriculumRateLimit, pathUuid, PlainText, readBodyBounded, readJsonBounded } from "./common";
import { SYLLABI_BUCKET, getCurriculumDeps, type CurriculumDeps } from "./deps";
import type { ChapterRow, JobError, JobRow, JobType, PlanRow, UploadMime } from "./types";

const IMPORT_SCOPE = "admin.imports";
/** Multipart framing allowance on top of IMPORT_MAX_MB. */
const MULTIPART_OVERHEAD = 64 * 1024;
const MAX_PASTED_TOC_CHARS = 200_000;

// ---------------------------------------------------------------------------
// School plans
// ---------------------------------------------------------------------------
export const CreateSchoolPlanRequest = z
  .object({
    grade: Grade,
    subject_key: SubjectKey,
    academic_year: z.string().trim().regex(/^[0-9]{4}(-[0-9]{2,4})?$/),
    school_label: PlainText(120).optional(),
    textbook_title: PlainText(200).optional(),
    edition: PlainText(80).optional(),
  })
  .strict()
  .refine((p) => GRADE_SUBJECTS[p.grade].some((s) => s.key === p.subject_key), { message: "subject is not taught in this grade", path: ["subject_key"] });

export function toApiPlan(p: PlanRow) {
  return {
    id: p.id,
    grade: p.grade,
    subject_key: p.subjectKey,
    academic_year: p.academicYear,
    school_label: p.schoolLabel,
    textbook_title: p.textbookTitle,
    edition: p.textbookEdition,
    archived_at: p.archivedAt ? p.archivedAt.toISOString() : null,
    created_at: p.createdAt.toISOString(),
  };
}

/** POST /api/v1/admin/school-plans — owner/guardian, scoped to their household. */
export async function createSchoolPlanHandler(req: Request, c: Ctx, deps: CurriculumDeps = getCurriculumDeps()): Promise<Response> {
  const adult = await requireAdult(req, c);
  requireCsrf(req, c);
  const body = await readJson(req, CreateSchoolPlanRequest);
  const plan = await withAdultHousehold(c, adult, async (sql, m) => {
    const row = await db(
      deps.repo.insertPlan(sql, {
        id: c.deps.uuid(),
        householdId: m.householdId,
        grade: body.grade,
        subjectKey: body.subject_key,
        academicYear: body.academic_year,
        schoolLabel: body.school_label ?? null,
        textbookTitle: body.textbook_title ?? null,
        textbookEdition: body.edition ?? null,
        createdBy: adult.userId,
      }),
    );
    await c.deps.repos.audit.insert(sql, {
      actorAuthId: adult.userId,
      householdId: m.householdId,
      action: "school_plan.created",
      targetType: "school_plan",
      targetId: row.id,
      metadata: { grade: row.grade, subject_key: row.subjectKey, academic_year: row.academicYear, role: m.role },
    });
    return row;
  });
  return json(c, { school_plan: toApiPlan(plan) }, 201);
}

/** GET /api/v1/admin/school-plans */
export async function listSchoolPlansHandler(req: Request, c: Ctx, deps: CurriculumDeps = getCurriculumDeps()): Promise<Response> {
  const adult = await requireAdult(req, c);
  const plans = await withAdultHousehold(c, adult, (sql, m) => deps.repo.listPlans(sql, m.householdId));
  return json(c, { school_plans: plans.map(toApiPlan) });
}

// ---------------------------------------------------------------------------
// Upload classification (MIME + magic)
// ---------------------------------------------------------------------------
export interface ClassifiedUpload {
  readonly kind: SourceKind;
  readonly mime: UploadMime;
  readonly jobType: JobType;
}

const unsupported = (why: string) => new HttpError(415, "unsupported_media_type", why);

/** Declared type and extension must agree with the magic bytes; anything else is 415. */
export function classifyUpload(bytes: Uint8Array, declaredType: string, filename: string): ClassifiedUpload {
  const declared = declaredType.split(";")[0]?.trim().toLowerCase() ?? "";
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(filename)?.[1]?.toLowerCase() ?? "";
  const sniffed = sniffMime(bytes);
  if (!sniffed) throw unsupported("File type not supported: upload a PDF, DOCX, CSV or plain-text table of contents");
  const generic = declared === "" || declared === "application/octet-stream";
  switch (sniffed.kind) {
    case "pdf":
      if ((generic || declared === MIME_PDF) && (ext === "pdf" || ext === "")) return { kind: "pdf", mime: MIME_PDF, jobType: "pdf_text" };
      break;
    case "docx":
      if ((generic || declared === MIME_DOCX) && (ext === "docx" || ext === "")) return { kind: "docx", mime: MIME_DOCX, jobType: "docx" };
      break;
    case "text":
      if ((declared === MIME_CSV || declared === "application/vnd.ms-excel" || (generic && ext === "csv")) && (ext === "csv" || ext === "")) {
        return { kind: "csv", mime: MIME_CSV, jobType: "csv" };
      }
      if ((declared === MIME_TEXT || (generic && ext === "txt")) && (ext === "txt" || ext === "")) return { kind: "text", mime: MIME_TEXT, jobType: "manual_toc" };
      break;
  }
  throw unsupported("The file's contents do not match its declared type");
}

/** Keeps only a safe basename for the private uploads table; never used in a storage key or URL. */
export function sanitizeFilename(name: string): string | null {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.normalize("NFKC").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, 100);
  return cleaned || null;
}

// ---------------------------------------------------------------------------
// POST /api/v1/admin/imports
// ---------------------------------------------------------------------------
export const PastedTocRequest = z
  .object({
    school_plan_id: Uuid,
    toc_text: z.string().min(1).max(MAX_PASTED_TOC_CHARS),
    format: z.enum(["lines", "csv"]).default("lines"),
  })
  .strict();

interface ImportInput {
  readonly schoolPlanId: string;
  readonly bytes: Uint8Array;
  readonly classified: ClassifiedUpload;
  readonly filename: string | null;
  /** Hash of the whole logical request (plan + content + type), for idempotency replay checks. */
  readonly requestSha256: string;
}

const toArrayBuffer = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

async function readImportInput(req: Request, deps: CurriculumDeps): Promise<ImportInput> {
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  if (type.startsWith("application/json")) {
    const body = await readJsonBounded(req, PastedTocRequest, MAX_PASTED_TOC_CHARS * 4 + 4096);
    const bytes = new TextEncoder().encode(body.toc_text);
    const classified: ClassifiedUpload = body.format === "csv" ? { kind: "csv", mime: MIME_CSV, jobType: "csv" } : { kind: "text", mime: MIME_TEXT, jobType: "manual_toc" };
    if (bytes.byteLength > deps.importMaxBytes) throw new HttpError(413, "payload_too_large", "Request body too large");
    return { schoolPlanId: body.school_plan_id.toLowerCase(), bytes, classified, filename: null, requestSha256: sha256(`json\n${body.school_plan_id}\n${body.format}\n${sha256(bytes)}`) };
  }
  if (type.startsWith("multipart/form-data")) {
    const raw = await readBodyBounded(req, deps.importMaxBytes + MULTIPART_OVERHEAD);
    let form: FormData;
    try {
      form = await new Response(toArrayBuffer(raw), { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData();
    } catch (err) {
      if (err instanceof TypeError) throw new HttpError(400, "validation_failed", "Malformed multipart body");
      throw err;
    }
    const file = form.get("file");
    const plan = form.get("school_plan_id");
    const planId = Uuid.safeParse(typeof plan === "string" ? plan.trim() : "");
    if (!(file instanceof File) || !planId.success) {
      throw new HttpError(422, "validation_failed", "A file and a school_plan_id are required", {
        issues: [...(file instanceof File ? [] : [{ path: "file", code: "required" }]), ...(planId.success ? [] : [{ path: "school_plan_id", code: "invalid_string" }])],
      });
    }
    if (file.size > deps.importMaxBytes) throw new HttpError(413, "payload_too_large", "File is larger than the import limit");
    if (file.size === 0) throw new HttpError(422, "validation_failed", "The file is empty", { issues: [{ path: "file", code: "too_small" }] });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const classified = classifyUpload(bytes, file.type, file.name);
    return { schoolPlanId: planId.data.toLowerCase(), bytes, classified, filename: sanitizeFilename(file.name), requestSha256: sha256(`file\n${planId.data}\n${classified.mime}\n${sha256(bytes)}`) };
  }
  throw new HttpError(415, "unsupported_media_type", "Expected multipart/form-data or application/json");
}

function toJobErrors(r: ExtractionResult): JobError[] {
  return r.errors.slice(0, 500).map((e) => ({ row: e.row, code: e.code, message: e.message, severity: e.severity }));
}

export interface ImportResponse {
  readonly job_id: string;
  readonly duplicate_of: string | null;
  readonly status: "review" | "failed";
  readonly chapters: number;
  readonly suggestions: number;
  /** Always false: imports stage review candidates only (CAT-009). */
  readonly published: false;
}

/**
 * Stores the file privately, extracts chapters inline (small files; the production path for large
 * files is a queue worker processing `import_jobs`), stages chapters and suggestions, and publishes nothing.
 */
export async function createImportHandler(req: Request, c: Ctx, deps: CurriculumDeps = getCurriculumDeps()): Promise<Response> {
  const adult = await requireAdult(req, c);
  requireCsrf(req, c);
  const keyHeader = req.headers.get(IDEMPOTENCY_HEADER);
  const key = IdempotencyKey.safeParse(keyHeader ?? "");
  if (!key.success) throw new HttpError(400, "validation_failed", "A valid Idempotency-Key header is required", { issues: [{ path: "Idempotency-Key", code: keyHeader ? "invalid_string" : "required" }] });
  await enforceCurriculumRateLimit(c, "importByUser", adult.userId);
  const input = await readImportInput(req, deps);

  const result = await withAdultHousehold(c, adult, async (sql, m) => {
    const prior = await deps.repo.getIdempotency(sql, IMPORT_SCOPE, adult.userId, key.data);
    if (prior) {
      if (prior.requestSha256 !== input.requestSha256) throw new HttpError(409, "idempotency_conflict", "Idempotency-Key was already used for a different request");
      return { status: prior.statusCode, body: prior.response as ImportResponse };
    }
    const plan = await deps.repo.getPlan(sql, input.schoolPlanId, m.householdId);
    if (!plan) throw new HttpError(404, "not_found", "School plan not found");
    if (plan.archivedAt) throw new HttpError(409, "conflict", "The school plan is archived");
    const digest = sha256(input.bytes);
    const body = await stageImport(sql, c, deps, adult, m, plan, input, digest);
    await db(deps.repo.putIdempotency(sql, { scope: IMPORT_SCOPE, actor: adult.userId, key: key.data, householdId: m.householdId, requestSha256: input.requestSha256, statusCode: 202, response: body }));
    return { status: 202, body };
  });
  return json(c, result.body, result.status);
}

async function stageImport(sql: Sql, c: Ctx, deps: CurriculumDeps, adult: AdultIdentity, m: HouseholdMembership, plan: PlanRow, input: ImportInput, digest: string): Promise<ImportResponse> {
  // CAT-010: the same file for the same plan returns the existing job; nothing new is staged.
  const dup = await deps.repo.findDuplicate(sql, plan.id, digest);
  if (dup?.jobId) {
    const existing = await deps.repo.getJob(sql, dup.jobId, m.householdId);
    await c.deps.repos.audit.insert(sql, { actorAuthId: adult.userId, householdId: m.householdId, action: "import.duplicate", targetType: "import_job", targetId: dup.jobId, metadata: { school_plan_id: plan.id } });
    return { job_id: dup.jobId, duplicate_of: dup.jobId, status: existing?.status === "failed" ? "failed" : "review", chapters: 0, suggestions: 0, published: false };
  }
  if (dup) throw new HttpError(409, "conflict", "This file is already being imported for this plan");

  const extraction = extractChapters(input.classified.kind, input.bytes, { grade: plan.grade, subjectKey: plan.subjectKey as SubjectKey });
  const status = extraction.status === "ok" ? "review" : "failed";
  const uploadId = c.deps.uuid();
  const jobId = c.deps.uuid();
  const objectKey = `${m.householdId}/${c.deps.uuid()}`;
  const now = c.deps.now();
  const candidates = status === "review" ? await deps.repo.candidateNodes(sql, plan.grade) : [];
  const chapters = extraction.chapters.map((ch) => ({ id: c.deps.uuid(), ch }));
  const suggestions = chapters.flatMap(({ id, ch }) =>
    suggestForChapter({ title: ch.title, grade: plan.grade, subjectKey: plan.subjectKey }, candidates, { threshold: deps.suggestThreshold }).map((s) => ({
      householdId: m.householdId,
      chapterId: id,
      curriculumNodeId: s.curriculumNodeId,
      confidence: s.confidence,
    })),
  );

  await deps.storage.put(SYLLABI_BUCKET, objectKey, input.bytes, input.classified.mime);
  try {
    await db(
      deps.repo.insertUpload(sql, {
        id: uploadId,
        householdId: m.householdId,
        schoolPlanId: plan.id,
        objectKey,
        sha256: digest,
        originalFilename: input.filename,
        mimeType: input.classified.mime,
        sizeBytes: input.bytes.byteLength,
        status,
        uploadedBy: adult.userId,
      }),
    );
    await db(deps.repo.insertJob(sql, { id: jobId, householdId: m.householdId, schoolPlanId: plan.id, uploadId, jobType: input.classified.jobType, inputSha256: digest, status, errors: toJobErrors(extraction), createdBy: adult.userId, finishedAt: now }));
    await db(
      deps.repo.insertChapters(
        sql,
        chapters.map(({ id, ch }) => ({
          id,
          householdId: m.householdId,
          schoolPlanId: plan.id,
          uploadId,
          chapterNumber: ch.chapterNumber,
          title: ch.title,
          pageStart: ch.pageStart,
          sourcePage: ch.sourceRow,
          sortOrder: ch.sortOrder,
          extractionConfidence: ch.extractionConfidence,
        })),
      ),
    );
    await db(deps.repo.insertSuggestions(sql, suggestions));
    await c.deps.repos.audit.insert(sql, {
      actorAuthId: adult.userId,
      householdId: m.householdId,
      action: "import.created",
      targetType: "import_job",
      targetId: jobId,
      metadata: { school_plan_id: plan.id, job_type: input.classified.jobType, status, size_bytes: input.bytes.byteLength, chapters: chapters.length, suggestions: suggestions.length, errors: extraction.errors.length },
    });
  } catch (err) {
    // The transaction rolls back; do not leave an orphaned private object behind. Rethrown unchanged.
    await deps.storage.remove(SYLLABI_BUCKET, objectKey);
    throw err;
  }
  return { job_id: jobId, duplicate_of: null, status, chapters: chapters.length, suggestions: suggestions.length, published: false };
}

// ---------------------------------------------------------------------------
// GET /api/v1/admin/imports, /imports/{jobId}
// ---------------------------------------------------------------------------
export function toApiJob(job: JobRow, chapters: readonly ChapterRow[], plan: PlanRow | null) {
  return {
    id: job.id,
    status: job.status,
    school_plan_id: job.schoolPlanId,
    job_type: job.jobType,
    created_at: job.createdAt.toISOString(),
    finished_at: job.finishedAt ? job.finishedAt.toISOString() : null,
    size_bytes: job.sizeBytes,
    mime_type: job.mimeType,
    plan: plan ? toApiPlan(plan) : null,
    published: false,
    errors: job.errors.map((e) => ({ row: e.row, code: e.code, message: e.message, severity: e.severity ?? "error" })),
    chapters: chapters.map((ch) => ({
      id: ch.id,
      chapter_number: ch.chapterNumber,
      title: ch.title,
      page_start: ch.pageStart,
      source_row: ch.sourcePage,
      sort_order: ch.sortOrder,
      extraction_confidence: ch.extractionConfidence,
      suggestions: ch.mappings.map((mp) => ({
        curriculum_node_id: mp.curriculumNodeId,
        stable_key: mp.stableKey,
        node_title: mp.nodeTitle,
        node_authority: mp.authority,
        confidence: mp.confidence ?? 0,
        suggested: mp.confidence !== null,
        state: mp.state,
        reviewer_auth_id: mp.reviewerAuthId,
        reviewed_at: mp.reviewedAt ? mp.reviewedAt.toISOString() : null,
      })),
    })),
  };
}

export async function loadJob(sql: Sql, deps: CurriculumDeps, jobId: string, householdId: string) {
  const job = await deps.repo.getJob(sql, jobId, householdId);
  if (!job) return null;
  const [chapters, plan] = [await deps.repo.jobChapters(sql, job.uploadId, householdId), await deps.repo.getPlan(sql, job.schoolPlanId, householdId)];
  return toApiJob(job, chapters, plan);
}

/** GET /api/v1/admin/imports/{jobId} — household-scoped; other households get 404. */
export async function getImportHandler(req: Request, c: Ctx, rawJobId: string, deps: CurriculumDeps = getCurriculumDeps()): Promise<Response> {
  const adult = await requireAdult(req, c);
  const jobId = pathUuid(rawJobId);
  const job = await withAdultHousehold(c, adult, (sql, m) => loadJob(sql, deps, jobId, m.householdId));
  if (!job) throw new HttpError(404, "not_found", "Not found");
  return json(c, job);
}

/** GET /api/v1/admin/imports */
export async function listImportsHandler(req: Request, c: Ctx, deps: CurriculumDeps = getCurriculumDeps()): Promise<Response> {
  const adult = await requireAdult(req, c);
  const jobs = await withAdultHousehold(c, adult, (sql, m) => deps.repo.listJobs(sql, m.householdId, 100));
  return json(c, {
    jobs: jobs.map((j) => ({ id: j.id, status: j.status, school_plan_id: j.schoolPlanId, job_type: j.jobType, created_at: j.createdAt.toISOString(), chapters: j.chapterCount, errors: j.errors.length })),
  });
}

// ---------------------------------------------------------------------------
// POST /api/v1/admin/imports/{jobId}/review
// ---------------------------------------------------------------------------
/**
 * Owner/guardian decisions per (chapter, node). Approved mappings are immutable (handler + DB trigger):
 * re-approving is a no-op and rejecting an approved mapping is 409. A node that was not suggested can be
 * approved as an explicit override (new row). Nothing is published.
 */
export async function reviewImportHandler(req: Request, c: Ctx, rawJobId: string, deps: CurriculumDeps = getCurriculumDeps()): Promise<Response> {
  const adult = await requireAdult(req, c);
  requireCsrf(req, c);
  const jobId = pathUuid(rawJobId);
  const body = await readJsonBounded(req, MappingReviewRequest, 128 * 1024);
  await enforceCurriculumRateLimit(c, "mappingReviewByUser", adult.userId);
  const now = c.deps.now();
  const out = await withAdultHousehold(c, adult, async (sql, m) => {
    const job = await deps.repo.getJob(sql, jobId, m.householdId);
    if (!job) throw new HttpError(404, "not_found", "Not found");
    const plan = await deps.repo.getPlan(sql, job.schoolPlanId, m.householdId);
    if (!plan) throw new HttpError(404, "not_found", "Not found");
    const chapterIds = new Set((await deps.repo.jobChapters(sql, job.uploadId, m.householdId)).map((ch) => ch.id));
    const results: { chapter_id: string; curriculum_node_id: string; state: string; reviewer_auth_id: string | null; reviewed_at: string | null; changed: boolean }[] = [];
    const seen = new Set<string>();
    for (const [i, d] of body.decisions.entries()) {
      const chapterId = d.chapter_id.toLowerCase();
      const nodeId = d.curriculum_node_id.toLowerCase();
      const pair = `${chapterId}/${nodeId}`;
      if (seen.has(pair)) throw new HttpError(422, "validation_failed", "Each (chapter, node) pair may appear once", { issues: [{ path: `decisions.${i}`, code: "duplicate" }] });
      seen.add(pair);
      if (!chapterIds.has(chapterId)) throw new HttpError(422, "validation_failed", "Chapter is not part of this import", { issues: [{ path: `decisions.${i}.chapter_id`, code: "not_in_job" }] });
      const existing = await deps.repo.getMappingForUpdate(sql, chapterId, nodeId, m.householdId);
      const state = d.decision === "approve" ? "approved" : "rejected";
      if (existing?.state === "approved") {
        if (state === "approved") {
          results.push({ chapter_id: chapterId, curriculum_node_id: nodeId, state: "approved", reviewer_auth_id: existing.reviewerAuthId, reviewed_at: existing.reviewedAt?.toISOString() ?? null, changed: false });
          continue;
        }
        throw new HttpError(409, "conflict", "Approved mappings are immutable", { issues: [{ path: `decisions.${i}`, code: "approved_immutable" }] });
      }
      if (!existing) {
        const node = await deps.repo.getCandidateNode(sql, nodeId);
        if (!node || node.grade !== plan.grade || node.reviewStatus === "archived" || (node.nodeType !== "topic" && node.nodeType !== "subtopic")) {
          throw new HttpError(422, "validation_failed", "Topic is not a mappable topic for this grade", { issues: [{ path: `decisions.${i}.curriculum_node_id`, code: "not_mappable" }] });
        }
      }
      const row = existing
        ? await db(deps.repo.decideExisting(sql, { id: existing.id, state, reviewer: adult.userId, at: now }))
        : await db(deps.repo.insertDecision(sql, { householdId: m.householdId, chapterId, curriculumNodeId: nodeId, state, reviewer: adult.userId, at: now }));
      results.push({ chapter_id: chapterId, curriculum_node_id: nodeId, state: row.state, reviewer_auth_id: row.reviewerAuthId, reviewed_at: row.reviewedAt?.toISOString() ?? null, changed: true });
    }
    await c.deps.repos.audit.insert(sql, {
      actorAuthId: adult.userId,
      householdId: m.householdId,
      action: "import.mappings_reviewed",
      targetType: "import_job",
      targetId: jobId,
      metadata: {
        role: m.role,
        decisions: results.filter((r) => r.changed).map((r) => ({ chapter_id: r.chapter_id, curriculum_node_id: r.curriculum_node_id, state: r.state })),
        unchanged: results.filter((r) => !r.changed).length,
      },
    });
    return results;
  });
  return json(c, { job_id: jobId, decisions: out, published: false });
}

// ---------------------------------------------------------------------------
// GET /api/v1/admin/imports/{jobId}/file  (SEC-007)
// ---------------------------------------------------------------------------
/** 302 to a short-lived signed URL for the owning household only; 404 for anyone else. */
export async function importFileHandler(req: Request, c: Ctx, rawJobId: string, deps: CurriculumDeps = getCurriculumDeps()): Promise<Response> {
  const adult = await requireAdult(req, c);
  const jobId = pathUuid(rawJobId);
  const objectKey = await withAdultHousehold(c, adult, async (sql, m) => {
    const job = await deps.repo.getJob(sql, jobId, m.householdId);
    if (!job || !job.objectKey.startsWith(`${m.householdId}/`)) throw new HttpError(404, "not_found", "Not found");
    await c.deps.repos.audit.insert(sql, { actorAuthId: adult.userId, householdId: m.householdId, action: "import.file_accessed", targetType: "import_job", targetId: jobId, metadata: { role: m.role } });
    return job.objectKey;
  });
  const url = await deps.storage.signedUrl(SYLLABI_BUCKET, objectKey, deps.signedUrlTtlSeconds);
  return empty(c, 302, { location: url, "referrer-policy": "no-referrer" });
}

/**
 * Dev/test only: serves a LocalFsStorage signed URL. Requires the adult session as well as a valid,
 * unexpired signature, and the object must belong to the caller's household. 404 when the
 * deployment uses Supabase storage.
 */
export async function localObjectHandler(req: Request, c: Ctx, deps: CurriculumDeps = getCurriculumDeps()): Promise<Response> {
  const adult = await requireAdult(req, c);
  const local = deps.localStorage;
  if (!local) throw new HttpError(404, "not_found", "Not found");
  const ref = local.verifySignedUrl(new URL(req.url).searchParams);
  if (!ref || ref.bucket !== SYLLABI_BUCKET) throw new HttpError(404, "not_found", "Not found");
  await withAdultHousehold(c, adult, async (_sql, m) => {
    if (!ref.key.startsWith(`${m.householdId}/`)) throw new HttpError(404, "not_found", "Not found");
  });
  const bytes = await local.get(ref.bucket, ref.key);
  if (!bytes) throw new HttpError(404, "not_found", "Not found");
  return new Response(toArrayBuffer(bytes), {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": 'attachment; filename="school-syllabus"',
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "X-Request-Id": c.requestId,
    },
  });
}

