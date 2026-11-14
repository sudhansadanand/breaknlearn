import type { Sql } from "../db-port";
import type {
  CandidateNodeRow,
  ChapterRow,
  CurriculumRepo,
  JobError,
  JobRow,
  MappingRow,
  NodeRow,
  PlanRow,
} from "./types";

type Json = Parameters<Sql["json"]>[0];
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

const NODE_COLS = (sql: Sql) => sql`
  n.id, n.stable_key as "stableKey", n.parent_id as "parentId", n.grade, n.subject_key as "subjectKey",
  n.node_type as "nodeType", n.title, n.authority, n.review_status as "reviewStatus",
  n.source_document_id as "sourceDocumentId", n.source_ref as "sourceRef", n.sort_order as "sortOrder",
  n.provenance, n.created_by as "createdBy", n.reviewed_by as "reviewedBy", n.reviewed_at as "reviewedAt"`;

const PLAN_COLS = (sql: Sql) => sql`
  id, household_id as "householdId", grade, subject_key as "subjectKey", academic_year as "academicYear",
  school_label as "schoolLabel", textbook_title as "textbookTitle", textbook_edition as "textbookEdition",
  archived_at as "archivedAt", created_at as "createdAt"`;

const JOB_COLS = (sql: Sql) => sql`
  j.id, j.household_id as "householdId", j.school_plan_id as "schoolPlanId", j.upload_id as "uploadId",
  j.job_type as "jobType", j.status, j.errors, j.created_at as "createdAt", j.finished_at as "finishedAt",
  u.object_key as "objectKey", u.mime_type as "mimeType", u.size_bytes as "sizeBytes"`;

const toNode = (r: NodeRow): NodeRow => ({ ...r, grade: Number(r.grade) as 2 | 6, sortOrder: Number(r.sortOrder) });
const toPlan = (r: PlanRow): PlanRow => ({ ...r, grade: Number(r.grade) as 2 | 6 });
const toJob = (r: JobRow): JobRow => ({ ...r, sizeBytes: Number(r.sizeBytes), errors: (r.errors ?? []) as JobError[] });
const toMapping = (r: MappingRow): MappingRow => ({ ...r, confidence: num(r.confidence) });

export const sqlCurriculumRepo: CurriculumRepo = {
  async listNodes(sql, f) {
    const q = f.q ? `%${f.q.replace(/[\\%_]/g, "\\$&")}%` : null;
    const rows = await sql<NodeRow[]>`
      select ${NODE_COLS(sql)} from bnl.curriculum_nodes n
       where true
         ${f.grade !== undefined ? sql`and n.grade = ${f.grade}` : sql``}
         ${f.subjectKey !== undefined ? sql`and n.subject_key = ${f.subjectKey}` : sql``}
         ${f.reviewStatus !== undefined ? sql`and n.review_status = ${f.reviewStatus}` : sql``}
         ${q !== null ? sql`and n.title ilike ${q}` : sql``}
         ${f.after
           ? sql`and (n.grade, n.subject_key, (n.node_type <> 'subject'), n.sort_order, n.stable_key)
                   > (${f.after.grade}, ${f.after.subjectKey}, ${f.after.isTopic}, ${f.after.sortOrder}, ${f.after.stableKey})`
           : sql``}
       order by n.grade, n.subject_key, (n.node_type <> 'subject'), n.sort_order, n.stable_key
       limit ${f.limit}`;
    return rows.map(toNode);
  },
  async getNodeForUpdate(sql, id) {
    const [r] = await sql<NodeRow[]>`select ${NODE_COLS(sql)} from bnl.curriculum_nodes n where n.id = ${id} for update`;
    return r ? toNode(r) : null;
  },
  async lastSubmitter(sql, nodeId) {
    const [r] = await sql<{ actor: string | null }[]>`
      select actor_auth_id as actor from bnl.audit_logs
       where target_type = 'curriculum_node' and target_id = ${nodeId} and action = 'curriculum.node_submitted'
       order by created_at desc, id desc limit 1`;
    return r?.actor ?? null;
  },
  async sourceDocumentExists(sql, id) {
    const rows = await sql`select 1 from bnl.source_documents where id = ${id}`;
    return rows.length > 0;
  },
  async listSourceDocuments(sql) {
    return sql<{ id: string; title: string; versionLabel: string | null }[]>`
      select id, title, version_label as "versionLabel" from bnl.source_documents order by title, version_label limit 200`;
  },
  async subjectAuthority(sql, grade, subjectKey) {
    const [r] = await sql<{ authority: string }[]>`select authority from bnl.grade_subjects where grade = ${grade} and subject_key = ${subjectKey}`;
    return r?.authority ?? null;
  },
  async updateNodeReview(sql, u) {
    const [r] = await sql<NodeRow[]>`
      update bnl.curriculum_nodes n set
        review_status = ${u.reviewStatus},
        authority = coalesce(${u.authority ?? null}, n.authority),
        source_document_id = coalesce(${u.sourceDocumentId ?? null}::uuid, n.source_document_id),
        source_ref = coalesce(${u.sourceRef ?? null}, n.source_ref),
        reviewed_by = coalesce(${u.reviewedBy ?? null}::uuid, n.reviewed_by),
        reviewed_at = coalesce(${u.reviewedAt ?? null}::timestamptz, n.reviewed_at),
        provenance = n.provenance || ${sql.json((u.provenancePatch ?? {}) as Json)}
       where n.id = ${u.id}
       returning ${NODE_COLS(sql)}`;
    if (!r) throw new Error("curriculum node update returned no row");
    return toNode(r);
  },
  async candidateNodes(sql, grade) {
    const rows = await sql<CandidateNodeRow[]>`
      select id, stable_key as "stableKey", grade, subject_key as "subjectKey", title, node_type as "nodeType", review_status as "reviewStatus"
        from bnl.curriculum_nodes
       where grade = ${grade} and node_type in ('topic', 'subtopic') and review_status <> 'archived'
       order by subject_key, sort_order, stable_key`;
    return rows.map((r) => ({ ...r, grade: Number(r.grade) as 2 | 6 }));
  },
  async getCandidateNode(sql, id) {
    const [r] = await sql<CandidateNodeRow[]>`
      select id, stable_key as "stableKey", grade, subject_key as "subjectKey", title, node_type as "nodeType", review_status as "reviewStatus"
        from bnl.curriculum_nodes where id = ${id}`;
    return r ? { ...r, grade: Number(r.grade) as 2 | 6 } : null;
  },

  async insertPlan(sql, p) {
    const [r] = await sql<PlanRow[]>`
      insert into bnl.school_plans (id, household_id, grade, subject_key, academic_year, school_label, textbook_title, textbook_edition, created_by)
      values (${p.id}, ${p.householdId}, ${p.grade}, ${p.subjectKey}, ${p.academicYear}, ${p.schoolLabel}, ${p.textbookTitle}, ${p.textbookEdition}, ${p.createdBy})
      returning ${PLAN_COLS(sql)}`;
    if (!r) throw new Error("school plan insert returned no row");
    return toPlan(r);
  },
  async getPlan(sql, id, householdId) {
    const [r] = await sql<PlanRow[]>`select ${PLAN_COLS(sql)} from bnl.school_plans where id = ${id} and household_id = ${householdId}`;
    return r ? toPlan(r) : null;
  },
  async listPlans(sql, householdId) {
    const rows = await sql<PlanRow[]>`
      select ${PLAN_COLS(sql)} from bnl.school_plans where household_id = ${householdId} order by created_at desc, id limit 200`;
    return rows.map(toPlan);
  },

  async findDuplicate(sql, schoolPlanId, sha256) {
    const [r] = await sql<{ uploadId: string; jobId: string | null }[]>`
      select u.id as "uploadId",
             (select j.id from bnl.import_jobs j where j.upload_id = u.id order by j.created_at, j.id limit 1) as "jobId"
        from bnl.syllabus_uploads u
       where u.school_plan_id = ${schoolPlanId} and u.sha256 = ${sha256}
       limit 1`;
    return r ?? null;
  },
  async insertUpload(sql, u) {
    await sql`
      insert into bnl.syllabus_uploads (id, household_id, school_plan_id, object_key, sha256, original_filename, mime_type, size_bytes, status, uploaded_by)
      values (${u.id}, ${u.householdId}, ${u.schoolPlanId}, ${u.objectKey}, ${u.sha256}, ${u.originalFilename}, ${u.mimeType}, ${u.sizeBytes}, ${u.status}, ${u.uploadedBy})`;
  },
  async insertJob(sql, j) {
    await sql`
      insert into bnl.import_jobs (id, household_id, school_plan_id, upload_id, job_type, input_sha256, status, errors, created_by, finished_at)
      values (${j.id}, ${j.householdId}, ${j.schoolPlanId}, ${j.uploadId}, ${j.jobType}, ${j.inputSha256}, ${j.status},
              ${sql.json(j.errors as unknown as Json)}, ${j.createdBy}, ${j.finishedAt})`;
  },
  async insertChapters(sql, rows) {
    if (rows.length === 0) return;
    const values = rows.map((r) => ({
      id: r.id,
      household_id: r.householdId,
      school_plan_id: r.schoolPlanId,
      upload_id: r.uploadId,
      chapter_number: r.chapterNumber,
      title: r.title,
      page_start: r.pageStart,
      source_page: r.sourcePage,
      sort_order: r.sortOrder,
      extraction_confidence: r.extractionConfidence,
    }));
    await sql`insert into bnl.syllabus_chapters ${sql(values)}`;
  },
  async insertSuggestions(sql, rows) {
    if (rows.length === 0) return;
    const values = rows.map((r) => ({
      household_id: r.householdId,
      chapter_id: r.chapterId,
      curriculum_node_id: r.curriculumNodeId,
      state: "suggested",
      confidence: r.confidence,
    }));
    await sql`insert into bnl.chapter_topic_mappings ${sql(values)}`;
  },
  async getJob(sql, jobId, householdId) {
    const [r] = await sql<JobRow[]>`
      select ${JOB_COLS(sql)} from bnl.import_jobs j join bnl.syllabus_uploads u on u.id = j.upload_id
       where j.id = ${jobId} and j.household_id = ${householdId}`;
    return r ? toJob(r) : null;
  },
  async listJobs(sql, householdId, limit) {
    const rows = await sql<(JobRow & { chapterCount: number })[]>`
      select ${JOB_COLS(sql)},
             (select count(*) from bnl.syllabus_chapters c where c.upload_id = j.upload_id)::int as "chapterCount"
        from bnl.import_jobs j join bnl.syllabus_uploads u on u.id = j.upload_id
       where j.household_id = ${householdId}
       order by j.created_at desc, j.id limit ${limit}`;
    return rows.map((r) => ({ ...toJob(r), chapterCount: Number(r.chapterCount) }));
  },
  async jobChapters(sql, uploadId, householdId) {
    const chapters = await sql<Omit<ChapterRow, "mappings">[]>`
      select id, chapter_number as "chapterNumber", title, page_start as "pageStart", source_page as "sourcePage",
             sort_order as "sortOrder", extraction_confidence as "extractionConfidence"
        from bnl.syllabus_chapters
       where upload_id = ${uploadId} and household_id = ${householdId}
       order by sort_order, id`;
    if (chapters.length === 0) return [];
    const mappings = await sql<ChapterRow["mappings"]>`
      select m.id, m.chapter_id as "chapterId", m.curriculum_node_id as "curriculumNodeId", m.state, m.confidence,
             m.reviewer_auth_id as "reviewerAuthId", m.reviewed_at as "reviewedAt",
             n.stable_key as "stableKey", n.title as "nodeTitle", n.authority
        from bnl.chapter_topic_mappings m join bnl.curriculum_nodes n on n.id = m.curriculum_node_id
       where m.household_id = ${householdId} and m.chapter_id in ${sql(chapters.map((c) => c.id))}
       order by m.confidence desc nulls last, n.stable_key`;
    return chapters.map((c) => ({
      ...c,
      extractionConfidence: num(c.extractionConfidence),
      mappings: mappings.filter((m) => m.chapterId === c.id).map((m) => ({ ...m, confidence: num(m.confidence) })),
    }));
  },
  async getMappingForUpdate(sql, chapterId, nodeId, householdId) {
    const [r] = await sql<MappingRow[]>`
      select id, chapter_id as "chapterId", curriculum_node_id as "curriculumNodeId", state, confidence,
             reviewer_auth_id as "reviewerAuthId", reviewed_at as "reviewedAt"
        from bnl.chapter_topic_mappings
       where chapter_id = ${chapterId} and curriculum_node_id = ${nodeId} and household_id = ${householdId}
       for update`;
    return r ? toMapping(r) : null;
  },
  async decideExisting(sql, p) {
    const [r] = await sql<MappingRow[]>`
      update bnl.chapter_topic_mappings set state = ${p.state}, reviewer_auth_id = ${p.reviewer}, reviewed_at = ${p.at}
       where id = ${p.id}
       returning id, chapter_id as "chapterId", curriculum_node_id as "curriculumNodeId", state, confidence,
                 reviewer_auth_id as "reviewerAuthId", reviewed_at as "reviewedAt"`;
    if (!r) throw new Error("mapping update returned no row");
    return toMapping(r);
  },
  async insertDecision(sql, p) {
    const [r] = await sql<MappingRow[]>`
      insert into bnl.chapter_topic_mappings (household_id, chapter_id, curriculum_node_id, state, confidence, reviewer_auth_id, reviewed_at)
      values (${p.householdId}, ${p.chapterId}, ${p.curriculumNodeId}, ${p.state}, null, ${p.reviewer}, ${p.at})
      returning id, chapter_id as "chapterId", curriculum_node_id as "curriculumNodeId", state, confidence,
                reviewer_auth_id as "reviewerAuthId", reviewed_at as "reviewedAt"`;
    if (!r) throw new Error("mapping insert returned no row");
    return toMapping(r);
  },

  async getIdempotency(sql, scope, actor, key) {
    const [r] = await sql<{ requestSha256: string; statusCode: number; response: unknown }[]>`
      select request_sha256 as "requestSha256", status_code as "statusCode", response
        from bnl.idempotency_keys
       where scope = ${scope} and actor_or_device = ${actor} and key = ${key} and expires_at > now()
       for update`;
    return r ? { ...r, statusCode: Number(r.statusCode) } : null;
  },
  async putIdempotency(sql, p) {
    await sql`
      insert into bnl.idempotency_keys (key, scope, actor_or_device, household_id, request_sha256, response, status_code)
      values (${p.key}, ${p.scope}, ${p.actor}, ${p.householdId}, ${p.requestSha256}, ${sql.json(p.response as Json)}, ${p.statusCode})
      on conflict (scope, actor_or_device, key) do update
        set request_sha256 = excluded.request_sha256, response = excluded.response, status_code = excluded.status_code,
            expires_at = now() + interval '24 hours'
        where bnl.idempotency_keys.expires_at <= now()`;
  },
};
