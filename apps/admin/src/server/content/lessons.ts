import { HttpError, type AdultIdentity } from "@bnl/auth";
import {
  LessonContent,
  PageQuery,
  PublishRequest,
  PublishResponse,
  SaveDraftLessonRequest,
  SaveDraftLessonResponse,
  StaffRole,
  Uuid,
  VersionTransitionRequest,
} from "@bnl/contracts";
import { bankItemsForContent, previewPictureGroups, validateLessonContent, withoutAnswerKey, type ValidationError } from "@bnl/lesson-engine";
import { z } from "zod";
import { requireAdult, requireCsrf, withStaff } from "../authn";
import type { Sql } from "../db-port";
import { json, readJson, validationFailed, type Ctx } from "../http";
import { mapDbErrors } from "./errors";
import { enforceContentRateLimit, idempotent, requireIdempotencyKey } from "./guards";
import { contentRepo } from "./port";
import type { LessonListRow, LessonRow, ManifestRevisionRow, PublicationRow, VersionRow } from "./types";

export const ANY_STAFF: readonly StaffRole[] = StaffRole.options;

/** Unpublish body (OpenAPI declares no schema; see docs/adr/proposals/A4-cms-contract-additions.md). */
export const UnpublishRequest = z.object({ reason: z.string().trim().min(1).max(500) });
/** Pin takes no fields; an empty body or `{}` is accepted. */
export const PinRequest = z.object({}).strict();

const iso = (d: Date | null | undefined) => (d === null || d === undefined ? null : new Date(d).toISOString());
const notFound = () => new HttpError(404, "not_found", "Not found");

function parseId(raw: string, name: string): string {
  const id = Uuid.safeParse(raw);
  if (!id.success) throw validationFailed([{ path: [name], code: "invalid_string" }], `${name} must be a UUID`);
  return id.data;
}

// ---------------------------------------------------------------------------
// Serializers (staff views). User ids are opaque UUIDs; no names or emails are stored here.
// ---------------------------------------------------------------------------
export function lessonOut(l: LessonRow) {
  return { id: l.id, stable_key: l.stableKey, grade: l.grade, subject_key: l.subjectKey, topic_id: l.topicId, title: l.title, template_key: l.templateKey, sort_order: l.sortOrder };
}

export function lessonListItem(l: LessonListRow) {
  return {
    ...lessonOut(l),
    latest_version: l.latest
      ? { id: l.latest.id, version_no: l.latest.versionNo, status: l.latest.status, title: l.latest.title, validation_error_count: l.latest.errorCount, updated_at: iso(l.latest.updatedAt) }
      : null,
    live_version: l.live ? { id: l.live.id, version_no: l.live.versionNo } : null,
  };
}

export function versionOut(v: VersionRow) {
  return {
    id: v.id, version_no: v.versionNo, status: v.status, checksum: v.checksum, content: v.content,
    validation_errors: v.validationErrors, created_by: v.createdBy, submitted_by: v.submittedBy, submitted_at: iso(v.submittedAt),
    reviewed_by: v.reviewedBy, approved_at: iso(v.approvedAt), rejected_by: v.rejectedBy, rejected_at: iso(v.rejectedAt),
    review_comment: v.reviewComment, published_at: iso(v.publishedAt), created_at: iso(v.createdAt), updated_at: iso(v.updatedAt),
  };
}

export function publicationOut(p: PublicationRow) {
  return {
    id: p.id, version_id: p.versionId, version_no: p.versionNo, published_by: p.publishedBy, published_at: iso(p.publishedAt),
    reason: p.reason, manifest_revision: p.manifestRevision, unpublished_at: iso(p.unpublishedAt), unpublished_by: p.unpublishedBy,
    unpublish_reason: p.unpublishReason,
  };
}

export function manifestRevisionOut(m: ManifestRevisionRow) {
  return { revision: m.revision, grade: m.grade, checksum: m.checksum, pinned_from_revision: m.pinnedFromRevision, created_at: iso(m.createdAt), lesson_count: m.lessonCount };
}

// ---------------------------------------------------------------------------
// Validation: TS publish-readiness (lesson-engine) + SQL structural checks + catalog identity.
// ---------------------------------------------------------------------------
const MAX_STABLE_KEY = 100; // leaves room for `.fact-N.vN` in the 128-char item key

export async function lessonErrors(sql: Sql, lesson: LessonRow, content: unknown): Promise<ValidationError[]> {
  const repo = contentRepo();
  const errors: ValidationError[] = [...validateLessonContent(content), ...(await repo.sqlContentErrors(sql, lesson.id, content))];
  const parsed = LessonContent.safeParse(content);
  if (parsed.success) {
    const topic = await repo.findTopic(sql, parsed.data.topic_key);
    if (!topic || lesson.topicId === null || topic.id !== lesson.topicId) {
      errors.push({ path: "topic_key", message: "topic_key must be the lesson's curriculum topic (same grade and subject)" });
    }
    if (parsed.data.stable_key.length > MAX_STABLE_KEY) errors.push({ path: "stable_key", message: `At most ${MAX_STABLE_KEY} characters` });
  }
  const seen = new Set<string>();
  return errors.filter((e) => {
    const k = `${e.path}\u0000${e.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const sameIdentity = (l: LessonRow, c: LessonContent) =>
  c.stable_key === l.stableKey && c.grade === l.grade && c.subject_key === l.subjectKey && c.template === l.templateKey;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
const encodeCursor = (k: string) => Buffer.from(k, "utf8").toString("base64url");
function decodeCursor(raw: string | undefined): string | null {
  if (raw === undefined || raw === "") return null;
  const k = Buffer.from(raw, "base64url").toString("utf8");
  if (!/^[a-z0-9._-]{1,200}$/.test(k)) throw validationFailed([{ path: ["cursor"], code: "invalid_string" }], "Invalid cursor");
  return k;
}

/** GET /api/v1/admin/lessons — any staff role. */
export async function listLessonsHandler(req: Request, c: Ctx): Promise<Response> {
  const adult = await requireAdult(req, c);
  const sp = new URL(req.url).searchParams;
  const q = PageQuery.safeParse({ cursor: sp.get("cursor") ?? undefined, limit: sp.get("limit") ?? undefined });
  if (!q.success) throw validationFailed(q.error.issues);
  const afterKey = decodeCursor(q.data.cursor);
  const rows = await withStaff(c, adult, ANY_STAFF, (sql) => contentRepo().listLessons(sql, { afterKey, limit: q.data.limit + 1 }));
  const page = rows.slice(0, q.data.limit);
  const last = page.at(-1);
  return json(c, { items: page.map(lessonListItem), next_cursor: rows.length > q.data.limit && last ? encodeCursor(last.stableKey) : null });
}

export async function loadLessonDetail(sql: Sql, lessonId: string, held: readonly StaffRole[], userId: string) {
  const repo = contentRepo();
  const lesson = await repo.getLesson(sql, lessonId);
  if (!lesson) return null;
  const [versions, publications, manifests] = [
    await repo.listVersions(sql, lessonId),
    await repo.listPublications(sql, lessonId),
    await repo.listManifests(sql, lesson.grade, 20),
  ];
  const live = publications.find((p) => p.unpublishedAt === null) ?? null;
  return {
    lesson: lessonOut(lesson),
    live_version_id: live?.versionId ?? null,
    versions: versions.map(versionOut),
    publications: publications.map(publicationOut),
    manifests: manifests.map(manifestRevisionOut),
    viewer: { user_id: userId, roles: [...held] },
  };
}

/** GET /api/v1/admin/lessons/{id} — versions, status and publication history. */
export async function getLessonHandler(req: Request, c: Ctx, lessonIdParam: string): Promise<Response> {
  const adult = await requireAdult(req, c);
  const lessonId = Uuid.safeParse(lessonIdParam);
  if (!lessonId.success) throw notFound();
  const detail = await withStaff(c, adult, ANY_STAFF, (sql, held) => loadLessonDetail(sql, lessonId.data, held, adult.userId));
  if (!detail) throw notFound();
  return json(c, detail);
}

export async function buildPreview(sql: Sql, lessonId: string, versionId: string, held: readonly StaffRole[]) {
  const repo = contentRepo();
  const lesson = await repo.getLesson(sql, lessonId);
  const version = lesson ? await repo.getVersion(sql, lessonId, versionId) : null;
  if (!lesson || !version) return null;
  const errors = version.status === "draft" ? await lessonErrors(sql, lesson, version.content) : [...validateLessonContent(version.content)];
  const themes = previewPictureGroups(version.content);
  const cfg = LessonContent.safeParse(version.content);
  const config = cfg.success ? cfg.data.config : {};
  const items = bankItemsForContent(version.content, version.versionNo) ?? [];
  // Answer keys are server-only (ADR-0002 C3); only reviewers checking correctness see them.
  const withKeys = held.includes("reviewer");
  return {
    lesson_id: lesson.id,
    version_id: version.id,
    version_no: version.versionNo,
    status: version.status,
    template_key: lesson.templateKey,
    validation_errors: errors,
    renderable: themes !== null,
    seconds_per_slide: typeof config.seconds_per_slide === "number" ? config.seconds_per_slide : 7,
    quiz_question_count: typeof config.quiz_question_count === "number" ? config.quiz_question_count : 3,
    themes: themes ?? [],
    answer_keys_included: withKeys,
    quiz_items: withKeys ? items : items.map(withoutAnswerKey),
  };
}

/** GET /api/v1/admin/lessons/{id}/versions/{vid}/preview — any staff role. */
export async function previewHandler(req: Request, c: Ctx, lessonIdParam: string, versionIdParam: string): Promise<Response> {
  const adult = await requireAdult(req, c);
  const lessonId = Uuid.safeParse(lessonIdParam);
  const versionId = Uuid.safeParse(versionIdParam);
  if (!lessonId.success || !versionId.success) throw notFound();
  const preview = await withStaff(c, adult, ANY_STAFF, (sql, held) => buildPreview(sql, lessonId.data, versionId.data, held));
  if (!preview) throw notFound();
  return json(c, preview);
}

// ---------------------------------------------------------------------------
// Editor: save draft (M04 — invalid drafts are saveable, never publishable)
// ---------------------------------------------------------------------------
async function saveDraft(sql: Sql, c: Ctx, adult: AdultIdentity, body: z.infer<typeof SaveDraftLessonRequest>) {
  const repo = contentRepo();
  const content = body.content;
  let lesson: LessonRow;
  let createdLesson = false;
  if (body.lesson_id) {
    const found = await repo.getLesson(sql, body.lesson_id, { forUpdate: true });
    if (!found) throw notFound();
    if (!sameIdentity(found, content)) {
      throw new HttpError(422, "validation_failed", "stable_key, grade, subject_key and template are fixed for an existing lesson");
    }
    lesson = found;
  } else {
    const topic = await repo.findTopic(sql, content.topic_key);
    const topicOk = topic !== null && topic.grade === content.grade && topic.subjectKey === content.subject_key;
    const inserted = await repo.insertLesson(sql, {
      stableKey: content.stable_key, grade: content.grade, subjectKey: content.subject_key, topicId: topicOk ? topic.id : null,
      title: content.title, templateKey: content.template, createdBy: adult.userId,
    });
    if (inserted.kind === "stable_key_taken") throw new HttpError(409, "conflict", "A lesson with this stable_key already exists; pass its lesson_id");
    lesson = inserted.row;
    createdLesson = true;
  }

  const errors = await lessonErrors(sql, lesson, content);
  const [latest] = await repo.listVersions(sql, lesson.id);
  // A draft is edited in place; anything past draft is immutable, so edits create the next version (CAT-007).
  const version =
    latest && latest.status === "draft"
      ? await repo.updateDraft(sql, { versionId: latest.id, content, validationErrors: errors })
      : await repo.insertVersion(sql, { lessonId: lesson.id, versionNo: (latest?.versionNo ?? 0) + 1, content, createdBy: adult.userId, validationErrors: errors });
  // Item bank from lesson-engine while the version is still a draft (frozen with it on submit).
  await repo.replaceItems(sql, version.id, bankItemsForContent(content, version.versionNo) ?? []);
  await repo.linkOutcomes(sql, lesson.id, content.learning_outcome_keys);
  await c.deps.repos.audit.insert(sql, {
    actorAuthId: adult.userId, householdId: null, action: "lesson_version.save_draft", targetType: "lesson_version", targetId: version.id,
    metadata: { lesson_id: lesson.id, version_no: version.versionNo, created_lesson: createdLesson, validation_error_count: errors.length },
  });
  return SaveDraftLessonResponse.parse({ lesson_id: lesson.id, version_id: version.id, version_no: version.versionNo, status: version.status, validation_errors: errors });
}

/** POST /api/v1/admin/lessons — editor. */
export async function saveDraftHandler(req: Request, c: Ctx): Promise<Response> {
  const adult = await requireAdult(req, c);
  requireCsrf(req, c);
  await enforceContentRateLimit(c, "save", adult.userId);
  const body = await readJson(req, SaveDraftLessonRequest);
  const out = await withStaff(c, adult, ["editor"], (sql) => mapDbErrors(() => saveDraft(sql, c, adult, body)));
  return json(c, out, 201);
}

// ---------------------------------------------------------------------------
// Review workflow (bnl.transition_lesson_version)
// ---------------------------------------------------------------------------
/** POST /api/v1/admin/lessons/{id}/versions/{vid}/transition */
export async function transitionHandler(req: Request, c: Ctx, lessonIdParam: string, versionIdParam: string): Promise<Response> {
  const adult = await requireAdult(req, c);
  requireCsrf(req, c);
  const lessonId = parseId(lessonIdParam, "lessonId");
  const versionId = parseId(versionIdParam, "versionId");
  const body = await readJson(req, VersionTransitionRequest);
  const roles: readonly StaffRole[] = body.action === "submit" ? ["editor"] : ["reviewer"];
  const out = await withStaff(c, adult, roles, (sql) =>
    mapDbErrors(async () => {
      const repo = contentRepo();
      const lesson = await repo.getLesson(sql, lessonId);
      const version = lesson ? await repo.getVersion(sql, lessonId, versionId) : null;
      if (!lesson || !version) throw notFound();
      if (body.action === "submit") {
        if (version.status !== "draft") throw new HttpError(409, "conflict", "Only a draft can be submitted");
        const errors = await lessonErrors(sql, lesson, version.content);
        if (errors.length > 0) {
          throw new HttpError(422, "validation_failed", "Fix the validation errors before submitting", { validation_errors: errors.slice(0, 50) });
        }
        await repo.replaceItems(sql, version.id, bankItemsForContent(version.content, version.versionNo) ?? []);
      } else {
        if (version.status !== "in_review") throw new HttpError(409, "conflict", "Only a version in review can be approved or rejected");
        if (version.createdBy === adult.userId) throw new HttpError(403, "forbidden", "A reviewer may not review their own version");
      }
      const status = await repo.transition(sql, { versionId, action: body.action, actor: adult.userId, comment: body.comment ?? null });
      return { lesson_id: lessonId, version_id: versionId, status };
    }),
  );
  return json(c, out);
}

// ---------------------------------------------------------------------------
// Publisher: publish / unpublish / pin (Idempotency-Key, audited in SQL, one transaction — OPS-003)
// ---------------------------------------------------------------------------
const MAX_OPTIONAL_BODY_BYTES = 1024;

/** For bodiless actions (pin): an empty body or a small JSON object validated by `schema`. */
async function readOptionalJson<T>(req: Request, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_OPTIONAL_BODY_BYTES) throw new HttpError(413, "payload_too_large", "Request body too large");
  let raw: unknown = {};
  if (text.trim() !== "") {
    if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) throw new HttpError(415, "unsupported_media_type", "Expected application/json");
    try {
      raw = JSON.parse(text);
    } catch {
      throw new HttpError(400, "validation_failed", "Malformed JSON");
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw validationFailed(parsed.error.issues);
  return parsed.data;
}

function replayable(c: Ctx, r: { status: number; body: unknown; replayed: boolean }): Response {
  return json(c, r.body, r.status, r.replayed ? { "idempotent-replayed": "true" } : {});
}

/** POST /api/v1/admin/lessons/{id}/publish — publisher only; approved versions only. */
export async function publishHandler(req: Request, c: Ctx, lessonIdParam: string): Promise<Response> {
  const adult = await requireAdult(req, c);
  requireCsrf(req, c);
  const key = requireIdempotencyKey(req);
  const lessonId = parseId(lessonIdParam, "lessonId");
  await enforceContentRateLimit(c, "publish", adult.userId);
  const body = await readJson(req, PublishRequest);
  const r = await withStaff(c, adult, ["publisher"], (sql) =>
    idempotent(sql, c, { scope: "admin.lesson.publish", actor: adult.userId, key, request: { lesson_id: lessonId, ...body } }, () =>
      mapDbErrors(async () => {
        const repo = contentRepo();
        // No FOR UPDATE here: publishers hold no UPDATE policy; bnl.publish_lesson_version locks the rows.
        const lesson = await repo.getLesson(sql, lessonId);
        const version = lesson ? await repo.getVersion(sql, lessonId, body.version_id) : null;
        if (!lesson || !version) throw notFound();
        if (version.status !== "approved") throw new HttpError(409, "conflict", "Only an approved version can be published");
        // Re-check publish readiness (SEC-008: markup in text is never published, whatever path approved it).
        const errors = validateLessonContent(version.content);
        if (errors.length > 0) throw new HttpError(422, "validation_failed", "This version is not publishable", { validation_errors: errors.slice(0, 50) });
        if (lesson.templateKey === "picture_groups_v1" && (await repo.countItems(sql, version.id)) === 0) {
          throw new HttpError(409, "conflict", "This version has no quiz item bank");
        }
        const done = await repo.publish(sql, { lessonId, versionId: version.id, reason: body.reason, actor: adult.userId });
        return { status: 200, body: PublishResponse.parse({ manifest_revision: done.manifestRevision, published_at: iso(done.publishedAt) }) };
      }),
    ),
  );
  return replayable(c, r);
}

/** POST /api/v1/admin/lessons/{id}/unpublish — publisher only. */
export async function unpublishHandler(req: Request, c: Ctx, lessonIdParam: string): Promise<Response> {
  const adult = await requireAdult(req, c);
  requireCsrf(req, c);
  const key = requireIdempotencyKey(req);
  const lessonId = parseId(lessonIdParam, "lessonId");
  await enforceContentRateLimit(c, "publish", adult.userId);
  const body = await readJson(req, UnpublishRequest);
  const r = await withStaff(c, adult, ["publisher"], (sql) =>
    idempotent(sql, c, { scope: "admin.lesson.unpublish", actor: adult.userId, key, request: { lesson_id: lessonId, ...body } }, () =>
      mapDbErrors(async () => {
        const done = await contentRepo().unpublish(sql, { lessonId, reason: body.reason, actor: adult.userId });
        return { status: 200, body: { manifest_revision: done.manifestRevision, unpublished_at: iso(done.unpublishedAt) } };
      }),
    ),
  );
  return replayable(c, r);
}

/** POST /api/v1/admin/manifests/{revision}/pin — publisher only; rollback to an earlier manifest. */
export async function pinHandler(req: Request, c: Ctx, revisionParam: string): Promise<Response> {
  const adult = await requireAdult(req, c);
  requireCsrf(req, c);
  const key = requireIdempotencyKey(req);
  if (!/^[1-9]\d{0,15}$/.test(revisionParam)) throw validationFailed([{ path: ["revision"], code: "invalid_type" }], "revision must be a positive integer");
  const revision = Number(revisionParam);
  await enforceContentRateLimit(c, "publish", adult.userId);
  await readOptionalJson(req, PinRequest);
  const r = await withStaff(c, adult, ["publisher"], (sql) =>
    idempotent(sql, c, { scope: "admin.manifest.pin", actor: adult.userId, key, request: { revision } }, () =>
      mapDbErrors(async () => {
        const done = await contentRepo().pin(sql, { revision, actor: adult.userId });
        return { status: 200, body: { manifest_revision: done.manifestRevision, pinned_from_revision: done.pinnedFromRevision } };
      }),
    ),
  );
  return replayable(c, r);
}
