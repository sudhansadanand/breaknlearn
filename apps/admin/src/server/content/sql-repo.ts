import type { ValidationError } from "@bnl/lesson-engine";
import type { LessonStatus } from "@bnl/contracts";
import type { Sql } from "../db-port";
import type { ContentRepo, LessonListRow, LessonRow, ManifestRevisionRow, ManifestRow, PublicationRow, PublishedLessonRow, TopicRow, VersionRow } from "./types";

type Json = Parameters<Sql["json"]>[0];
const asJson = (v: unknown): Json => v as Json;

const LESSON_COLS = `l.id, l.stable_key as "stableKey", l.grade, l.subject_key as "subjectKey", l.topic_id as "topicId",
  l.title, l.template_key as "templateKey", l.sort_order as "sortOrder", l.created_by as "createdBy", l.updated_at as "updatedAt"`;

const VERSION_COLS = `v.id, v.lesson_id as "lessonId", v.version_no as "versionNo", v.content, v.checksum, v.status,
  v.validation_errors as "validationErrors", v.created_by as "createdBy", v.submitted_by as "submittedBy",
  v.submitted_at as "submittedAt", v.reviewed_by as "reviewedBy", v.approved_at as "approvedAt",
  v.rejected_by as "rejectedBy", v.rejected_at as "rejectedAt", v.review_comment as "reviewComment",
  v.published_at as "publishedAt", v.created_at as "createdAt", v.updated_at as "updatedAt"`;

const one = <T>(rows: readonly T[], what: string): T => {
  const row = rows[0];
  if (row === undefined) throw new Error(`${what} returned no row`);
  return row;
};

function uniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

/** bnl content tables and workflow functions (0001-0003, 0005). Runs under bnl_staff / bnl_public. */
export const sqlContentRepo: ContentRepo = {
  async latestManifest(sql, grade) {
    const rows = await sql<ManifestRow[]>`
      select revision::int as revision, checksum, manifest from bnl.published_manifests
      where grade = ${grade} order by revision desc limit 1`;
    return rows[0] ?? null;
  },

  async countVisibleVersions(sql, versionIds) {
    if (versionIds.length === 0) return 0;
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from bnl.lesson_versions where id = any(${versionIds as string[]}::uuid[])`;
    return row?.n ?? 0;
  },

  async publishedLesson(sql, lessonId) {
    // Column list matches the bnl_public grant; RLS limits rows to live versions.
    const rows = await sql<PublishedLessonRow[]>`
      select l.id, v.id as "versionId", v.version_no as "versionNo", v.checksum, v.published_at as "publishedAt", v.content
      from bnl.lessons l join bnl.lesson_versions v on v.lesson_id = l.id
      where l.id = ${lessonId} and v.status = 'published'
      order by v.version_no desc limit 2`;
    // Exactly one live version per lesson; anything else fails closed.
    return rows.length === 1 ? (rows[0] ?? null) : null;
  },

  async listLessons(sql, p) {
    return sql<LessonListRow[]>`
      select ${sql.unsafe(LESSON_COLS)},
        (select jsonb_build_object('id', v.id, 'versionNo', v.version_no, 'status', v.status, 'title', v.content->>'title',
                  'errorCount', jsonb_array_length(v.validation_errors), 'updatedAt', v.updated_at)
           from bnl.lesson_versions v where v.lesson_id = l.id order by v.version_no desc limit 1) as latest,
        (select jsonb_build_object('id', v.id, 'versionNo', v.version_no)
           from bnl.publication_records pr join bnl.lesson_versions v on v.id = pr.lesson_version_id
          where pr.lesson_id = l.id and pr.unpublished_at is null) as live
      from bnl.lessons l
      where ${p.afterKey === null ? sql`true` : sql`l.stable_key > ${p.afterKey}`}
      order by l.stable_key limit ${p.limit}`.then((rows) =>
      rows.map((r) => ({ ...r, latest: r.latest ? { ...r.latest, updatedAt: new Date(r.latest.updatedAt) } : null })),
    );
  },

  async getLesson(sql, lessonId, opts) {
    const rows = await sql<LessonRow[]>`
      select ${sql.unsafe(LESSON_COLS)} from bnl.lessons l where l.id = ${lessonId}
      ${opts?.forUpdate ? sql`for update` : sql``}`;
    return rows[0] ?? null;
  },

  async listVersions(sql, lessonId) {
    return sql<VersionRow[]>`
      select ${sql.unsafe(VERSION_COLS)} from bnl.lesson_versions v where v.lesson_id = ${lessonId} order by v.version_no desc`;
  },

  async getVersion(sql, lessonId, versionId, opts) {
    const rows = await sql<VersionRow[]>`
      select ${sql.unsafe(VERSION_COLS)} from bnl.lesson_versions v where v.id = ${versionId} and v.lesson_id = ${lessonId}
      ${opts?.forUpdate ? sql`for update` : sql``}`;
    return rows[0] ?? null;
  },

  async listPublications(sql, lessonId) {
    return sql<PublicationRow[]>`
      select pr.id, pr.lesson_version_id as "versionId", v.version_no as "versionNo", pr.published_by as "publishedBy",
        pr.published_at as "publishedAt", pr.reason, pr.manifest_revision::int as "manifestRevision",
        pr.unpublished_at as "unpublishedAt", pr.unpublished_by as "unpublishedBy", pr.unpublish_reason as "unpublishReason"
      from bnl.publication_records pr join bnl.lesson_versions v on v.id = pr.lesson_version_id
      where pr.lesson_id = ${lessonId} order by pr.published_at desc, pr.created_at desc`;
  },

  async listManifests(sql, grade, limit) {
    return sql<ManifestRevisionRow[]>`
      select m.revision::int as revision, m.grade, m.checksum, m.pinned_from_revision::int as "pinnedFromRevision",
        m.created_at as "createdAt",
        (select count(*)::int from jsonb_array_elements(m.manifest->'subjects') s,
           jsonb_array_elements(s->'topics') t, jsonb_array_elements(t->'lessons') x) as "lessonCount"
      from bnl.published_manifests m where m.grade = ${grade} order by m.revision desc limit ${limit}`;
  },

  async findTopic(sql, topicKey) {
    const rows = await sql<TopicRow[]>`
      select id, grade, subject_key as "subjectKey" from bnl.curriculum_nodes
      where stable_key = ${topicKey} and node_type <> 'subject'`;
    return rows[0] ?? null;
  },

  async sqlContentErrors(sql, lessonId, content) {
    const [row] = await sql<{ errors: ValidationError[] }[]>`
      select bnl.lesson_content_errors(${lessonId}, ${sql.json(asJson(content))}) as errors`;
    return row?.errors ?? [];
  },

  async countItems(sql, versionId) {
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from bnl.quiz_items where lesson_version_id = ${versionId}`;
    return row?.n ?? 0;
  },

  async insertLesson(sql, p) {
    try {
      const rows = await sql.savepoint((s) => s<LessonRow[]>`
        insert into bnl.lessons as l (stable_key, grade, subject_key, topic_id, title, template_key, sort_order, created_by)
        values (${p.stableKey}, ${p.grade}, ${p.subjectKey}, ${p.topicId}, ${p.title}, ${p.templateKey},
          coalesce((select max(x.sort_order) + 1 from bnl.lessons x where x.topic_id is not distinct from ${p.topicId}), 1),
          ${p.createdBy})
        returning ${s.unsafe(LESSON_COLS)}`);
      return { kind: "ok", row: one(rows, "lessons insert") };
    } catch (err) {
      if (uniqueViolation(err)) return { kind: "stable_key_taken" };
      throw err;
    }
  },

  async insertVersion(sql, p) {
    const rows = await sql<VersionRow[]>`
      insert into bnl.lesson_versions as v (lesson_id, version_no, content, created_by, validation_errors)
      values (${p.lessonId}, ${p.versionNo}, ${sql.json(asJson(p.content))}, ${p.createdBy}, ${sql.json(asJson(p.validationErrors))})
      returning ${sql.unsafe(VERSION_COLS)}`;
    return one(rows, "lesson_versions insert");
  },

  async updateDraft(sql, p) {
    const rows = await sql<VersionRow[]>`
      update bnl.lesson_versions as v set content = ${sql.json(asJson(p.content))}, validation_errors = ${sql.json(asJson(p.validationErrors))}
      where v.id = ${p.versionId} and v.status = 'draft'
      returning ${sql.unsafe(VERSION_COLS)}`;
    return one(rows, "lesson_versions draft update");
  },

  async replaceItems(sql, versionId, items) {
    await sql`delete from bnl.quiz_items where lesson_version_id = ${versionId}`;
    for (const it of items) {
      await sql`
        insert into bnl.quiz_items (lesson_version_id, question_version_key, outcome_key, stage_eligibility, prompt, options,
          correct_option_id, sort_order)
        values (${versionId}, ${it.question_version_key}, ${it.outcome_key}, ${it.stage_eligibility as string[]}, ${it.prompt},
          ${sql.json(asJson(it.options))}, ${it.correct_option_id}, ${it.sort_order})`;
    }
  },

  async linkOutcomes(sql, lessonId, outcomeKeys) {
    if (outcomeKeys.length === 0) return;
    await sql`
      insert into bnl.lesson_outcomes (lesson_id, outcome_id)
      select ${lessonId}, o.id from bnl.learning_outcomes o where o.stable_key = any(${outcomeKeys as string[]})
      on conflict do nothing`;
  },

  async transition(sql, p) {
    const rows = await sql<{ status: LessonStatus }[]>`
      select status from bnl.transition_lesson_version(${p.versionId}, ${p.action}, ${p.actor}, ${p.comment})`;
    return one(rows, "transition_lesson_version").status;
  },

  async publish(sql, p) {
    const rows = await sql<{ manifestRevision: number; publishedAt: Date }[]>`
      select manifest_revision::int as "manifestRevision", published_at as "publishedAt"
      from bnl.publish_lesson_version(${p.lessonId}, ${p.versionId}, ${p.reason}, ${p.actor})`;
    return one(rows, "publish_lesson_version");
  },

  async unpublish(sql, p) {
    const rows = await sql<{ manifestRevision: number; unpublishedAt: Date }[]>`
      select manifest_revision::int as "manifestRevision", unpublished_at as "unpublishedAt"
      from bnl.unpublish_lesson(${p.lessonId}, ${p.reason}, ${p.actor})`;
    return one(rows, "unpublish_lesson");
  },

  async pin(sql, p) {
    const rows = await sql<{ manifestRevision: number; pinnedFromRevision: number }[]>`
      select manifest_revision::int as "manifestRevision", pinned_from_revision::int as "pinnedFromRevision"
      from bnl.pin_manifest(${p.revision}, ${p.actor})`;
    return one(rows, "pin_manifest");
  },

  async claimIdempotency(sql, p) {
    const inserted = await sql<{ id: string }[]>`
      insert into bnl.idempotency_keys (key, scope, actor_or_device, request_sha256)
      values (${p.key}, ${p.scope}, ${p.actor}, ${p.requestSha256})
      on conflict (scope, actor_or_device, key) do nothing returning id`;
    if (inserted.length > 0) return { kind: "new" };
    const [row] = await sql<{ requestSha256: string; response: unknown; statusCode: number | null; expiresAt: Date }[]>`
      select request_sha256 as "requestSha256", response, status_code as "statusCode", expires_at as "expiresAt"
      from bnl.idempotency_keys where scope = ${p.scope} and actor_or_device = ${p.actor} and key = ${p.key} for update`;
    if (!row) return { kind: "conflict" };
    if (row.expiresAt.getTime() <= p.now.getTime()) {
      await sql`
        update bnl.idempotency_keys set request_sha256 = ${p.requestSha256}, response = null, status_code = null,
          expires_at = now() + interval '24 hours'
        where scope = ${p.scope} and actor_or_device = ${p.actor} and key = ${p.key}`;
      return { kind: "new" };
    }
    if (row.requestSha256 !== p.requestSha256 || row.statusCode === null) return { kind: "conflict" };
    return { kind: "replay", status: row.statusCode, body: row.response };
  },

  async completeIdempotency(sql, p) {
    await sql`
      update bnl.idempotency_keys set response = ${sql.json(asJson(p.body))}, status_code = ${p.status}
      where scope = ${p.scope} and actor_or_device = ${p.actor} and key = ${p.key}`;
  },
};
