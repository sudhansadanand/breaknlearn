import type { Sql } from "../db-port";

/**
 * Repository port for curriculum (M02) and school import (M03). SQL lives in `sql-repo.ts`; route
 * tests use an in-memory fake. Every method runs inside the caller's RLS-scoped transaction, and
 * household-scoped reads also filter on the household id explicitly (defence in depth).
 */
export type Authority = "editorial_unverified" | "cisce_verified" | "school_specific" | "local_enrichment";
export type ReviewStatus = "draft" | "in_review" | "verified" | "archived";
export type NodeType = "subject" | "strand" | "topic" | "subtopic";
export type MappingState = "suggested" | "approved" | "rejected";
export type JobStatus = "queued" | "extracting" | "review" | "failed" | "approved";
export type JobType = "pdf_text" | "docx" | "csv" | "manual_toc" | "ocr";
export type UploadMime = "application/pdf" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document" | "text/csv" | "text/plain";

export interface NodeRow {
  readonly id: string;
  readonly stableKey: string;
  readonly parentId: string | null;
  readonly grade: 2 | 6;
  readonly subjectKey: string;
  readonly nodeType: NodeType;
  readonly title: string;
  readonly authority: Authority;
  readonly reviewStatus: ReviewStatus;
  readonly sourceDocumentId: string | null;
  readonly sourceRef: string | null;
  readonly sortOrder: number;
  readonly provenance: Record<string, unknown>;
  readonly createdBy: string | null;
  readonly reviewedBy: string | null;
  readonly reviewedAt: Date | null;
}

export interface NodeCursor {
  readonly grade: number;
  readonly subjectKey: string;
  readonly isTopic: boolean;
  readonly sortOrder: number;
  readonly stableKey: string;
}

export interface NodeFilter {
  readonly grade?: 2 | 6;
  readonly subjectKey?: string;
  readonly reviewStatus?: ReviewStatus;
  readonly q?: string;
  readonly after?: NodeCursor;
  readonly limit: number;
}

export interface NodeReviewUpdate {
  readonly id: string;
  readonly reviewStatus: ReviewStatus;
  readonly authority?: Authority;
  readonly sourceDocumentId?: string;
  readonly sourceRef?: string;
  readonly reviewedBy?: string;
  readonly reviewedAt?: Date;
  readonly provenancePatch?: Record<string, unknown>;
}

export interface PlanRow {
  readonly id: string;
  readonly householdId: string;
  readonly grade: 2 | 6;
  readonly subjectKey: string;
  readonly academicYear: string;
  readonly schoolLabel: string | null;
  readonly textbookTitle: string | null;
  readonly textbookEdition: string | null;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
}

export interface PlanInsert {
  readonly id: string;
  readonly householdId: string;
  readonly grade: 2 | 6;
  readonly subjectKey: string;
  readonly academicYear: string;
  readonly schoolLabel: string | null;
  readonly textbookTitle: string | null;
  readonly textbookEdition: string | null;
  readonly createdBy: string;
}

export interface JobError {
  readonly row: number | null;
  readonly code: string;
  readonly message: string;
  readonly severity: "error" | "warning";
}

export interface JobRow {
  readonly id: string;
  readonly householdId: string;
  readonly schoolPlanId: string;
  readonly uploadId: string;
  readonly jobType: JobType;
  readonly status: JobStatus;
  readonly errors: JobError[];
  readonly createdAt: Date;
  readonly finishedAt: Date | null;
  readonly objectKey: string;
  readonly mimeType: UploadMime;
  readonly sizeBytes: number;
}

export interface UploadInsert {
  readonly id: string;
  readonly householdId: string;
  readonly schoolPlanId: string;
  readonly objectKey: string;
  readonly sha256: string;
  readonly originalFilename: string | null;
  readonly mimeType: UploadMime;
  readonly sizeBytes: number;
  readonly status: "review" | "failed";
  readonly uploadedBy: string;
}

export interface JobInsert {
  readonly id: string;
  readonly householdId: string;
  readonly schoolPlanId: string;
  readonly uploadId: string;
  readonly jobType: JobType;
  readonly inputSha256: string;
  readonly status: "review" | "failed";
  readonly errors: JobError[];
  readonly createdBy: string;
  readonly finishedAt: Date;
}

export interface ChapterInsert {
  readonly id: string;
  readonly householdId: string;
  readonly schoolPlanId: string;
  readonly uploadId: string;
  readonly chapterNumber: string | null;
  readonly title: string;
  readonly pageStart: number | null;
  readonly sourcePage: number | null;
  readonly sortOrder: number;
  readonly extractionConfidence: number;
}

export interface MappingRow {
  readonly id: string;
  readonly chapterId: string;
  readonly curriculumNodeId: string;
  readonly state: MappingState;
  readonly confidence: number | null;
  readonly reviewerAuthId: string | null;
  readonly reviewedAt: Date | null;
}

export interface ChapterRow {
  readonly id: string;
  readonly chapterNumber: string | null;
  readonly title: string;
  readonly pageStart: number | null;
  readonly sourcePage: number | null;
  readonly sortOrder: number;
  readonly extractionConfidence: number | null;
  readonly mappings: (MappingRow & { readonly stableKey: string; readonly nodeTitle: string; readonly authority: Authority })[];
}

export interface CandidateNodeRow {
  readonly id: string;
  readonly stableKey: string;
  readonly grade: 2 | 6;
  readonly subjectKey: string;
  readonly title: string;
  readonly nodeType: NodeType;
  readonly reviewStatus: ReviewStatus;
}

export interface IdempotencyRecord {
  readonly requestSha256: string;
  readonly statusCode: number;
  readonly response: unknown;
}

export interface CurriculumRepo {
  listNodes(sql: Sql, f: NodeFilter): Promise<NodeRow[]>;
  /** Locks the row (FOR UPDATE). */
  getNodeForUpdate(sql: Sql, id: string): Promise<NodeRow | null>;
  /** Auth id of the most recent `curriculum.node_submitted` audit row for this node, if any. */
  lastSubmitter(sql: Sql, nodeId: string): Promise<string | null>;
  sourceDocumentExists(sql: Sql, id: string): Promise<boolean>;
  /** Staff only: citable source documents (id, title, version). */
  listSourceDocuments(sql: Sql): Promise<{ id: string; title: string; versionLabel: string | null }[]>;
  /** grade_subjects.authority for the node's subject ('cisce' | 'local_enrichment'). */
  subjectAuthority(sql: Sql, grade: number, subjectKey: string): Promise<string | null>;
  updateNodeReview(sql: Sql, u: NodeReviewUpdate): Promise<NodeRow>;
  /** Topic/subtopic nodes of one grade that are not archived (mapping targets). */
  candidateNodes(sql: Sql, grade: 2 | 6): Promise<CandidateNodeRow[]>;
  getCandidateNode(sql: Sql, id: string): Promise<CandidateNodeRow | null>;

  insertPlan(sql: Sql, p: PlanInsert): Promise<PlanRow>;
  getPlan(sql: Sql, id: string, householdId: string): Promise<PlanRow | null>;
  listPlans(sql: Sql, householdId: string): Promise<PlanRow[]>;

  /** Existing upload (and its job) with this checksum for the plan. */
  findDuplicate(sql: Sql, schoolPlanId: string, sha256: string): Promise<{ uploadId: string; jobId: string | null } | null>;
  insertUpload(sql: Sql, u: UploadInsert): Promise<void>;
  insertJob(sql: Sql, j: JobInsert): Promise<void>;
  insertChapters(sql: Sql, rows: readonly ChapterInsert[]): Promise<void>;
  insertSuggestions(sql: Sql, rows: readonly { householdId: string; chapterId: string; curriculumNodeId: string; confidence: number }[]): Promise<void>;
  getJob(sql: Sql, jobId: string, householdId: string): Promise<JobRow | null>;
  listJobs(sql: Sql, householdId: string, limit: number): Promise<(JobRow & { chapterCount: number })[]>;
  jobChapters(sql: Sql, uploadId: string, householdId: string): Promise<ChapterRow[]>;
  /** Locks the row (FOR UPDATE). */
  getMappingForUpdate(sql: Sql, chapterId: string, nodeId: string, householdId: string): Promise<MappingRow | null>;
  decideExisting(sql: Sql, p: { id: string; state: "approved" | "rejected"; reviewer: string; at: Date }): Promise<MappingRow>;
  insertDecision(sql: Sql, p: { householdId: string; chapterId: string; curriculumNodeId: string; state: "approved" | "rejected"; reviewer: string; at: Date }): Promise<MappingRow>;

  getIdempotency(sql: Sql, scope: string, actor: string, key: string): Promise<IdempotencyRecord | null>;
  putIdempotency(sql: Sql, p: { scope: string; actor: string; key: string; householdId: string | null; requestSha256: string; statusCode: number; response: unknown }): Promise<void>;
}
