import type { BankItem, ValidationError } from "@bnl/lesson-engine";
import type { Grade, LessonStatus, SubjectKey, TemplateKey } from "@bnl/contracts";
import type { Sql } from "../db-port";

/**
 * Content repository port (M04/M05). All SQL lives in `sql-repo.ts`; route tests inject an
 * in-memory fake through `setContentRepoForTesting`. Handlers own business rules; the SQL
 * workflow functions re-check roles, state and author/reviewer separation in the database.
 */

export interface LessonRow {
  readonly id: string;
  readonly stableKey: string;
  readonly grade: Grade;
  readonly subjectKey: SubjectKey;
  readonly topicId: string | null;
  readonly title: string;
  readonly templateKey: TemplateKey;
  readonly sortOrder: number;
  readonly createdBy: string | null;
  readonly updatedAt: Date;
}

export interface LessonListRow extends LessonRow {
  readonly latest: { readonly id: string; readonly versionNo: number; readonly status: LessonStatus; readonly title: string; readonly errorCount: number; readonly updatedAt: Date } | null;
  readonly live: { readonly id: string; readonly versionNo: number } | null;
}

export interface VersionRow {
  readonly id: string;
  readonly lessonId: string;
  readonly versionNo: number;
  readonly content: unknown;
  readonly checksum: string;
  readonly status: LessonStatus;
  readonly validationErrors: readonly ValidationError[];
  readonly createdBy: string | null;
  readonly submittedBy: string | null;
  readonly submittedAt: Date | null;
  readonly reviewedBy: string | null;
  readonly approvedAt: Date | null;
  readonly rejectedBy: string | null;
  readonly rejectedAt: Date | null;
  readonly reviewComment: string | null;
  readonly publishedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PublicationRow {
  readonly id: string;
  readonly versionId: string;
  readonly versionNo: number;
  readonly publishedBy: string;
  readonly publishedAt: Date;
  readonly reason: string;
  readonly manifestRevision: number | null;
  readonly unpublishedAt: Date | null;
  readonly unpublishedBy: string | null;
  readonly unpublishReason: string | null;
}

export interface ManifestRevisionRow {
  readonly revision: number;
  readonly grade: Grade;
  readonly checksum: string;
  readonly pinnedFromRevision: number | null;
  readonly createdAt: Date;
  readonly lessonCount: number;
}

export interface ManifestRow {
  readonly revision: number;
  readonly checksum: string;
  readonly manifest: unknown;
}

export interface PublishedLessonRow {
  readonly id: string;
  readonly versionId: string;
  readonly versionNo: number;
  readonly checksum: string;
  readonly publishedAt: Date | null;
  readonly content: unknown;
}

export interface TopicRow {
  readonly id: string;
  readonly grade: number;
  readonly subjectKey: string;
}

export type IdempotencyClaim =
  | { readonly kind: "new" }
  | { readonly kind: "replay"; readonly status: number; readonly body: unknown }
  | { readonly kind: "conflict" };

export interface ContentRepo {
  // Catalog (public context)
  latestManifest(sql: Sql, grade: Grade): Promise<ManifestRow | null>;
  /** Number of the given version ids visible to the caller (public: live versions only). */
  countVisibleVersions(sql: Sql, versionIds: readonly string[]): Promise<number>;
  publishedLesson(sql: Sql, lessonId: string): Promise<PublishedLessonRow | null>;

  // Staff reads
  listLessons(sql: Sql, p: { afterKey: string | null; limit: number }): Promise<LessonListRow[]>;
  getLesson(sql: Sql, lessonId: string, opts?: { forUpdate?: boolean }): Promise<LessonRow | null>;
  listVersions(sql: Sql, lessonId: string): Promise<VersionRow[]>;
  getVersion(sql: Sql, lessonId: string, versionId: string, opts?: { forUpdate?: boolean }): Promise<VersionRow | null>;
  listPublications(sql: Sql, lessonId: string): Promise<PublicationRow[]>;
  listManifests(sql: Sql, grade: Grade, limit: number): Promise<ManifestRevisionRow[]>;
  findTopic(sql: Sql, topicKey: string): Promise<TopicRow | null>;
  /** bnl.lesson_content_errors (structural checks in SQL). */
  sqlContentErrors(sql: Sql, lessonId: string, content: unknown): Promise<ValidationError[]>;
  countItems(sql: Sql, versionId: string): Promise<number>;

  // Editor writes (drafts only; RLS-enforced)
  insertLesson(
    sql: Sql,
    p: { stableKey: string; grade: Grade; subjectKey: SubjectKey; topicId: string | null; title: string; templateKey: TemplateKey; createdBy: string },
  ): Promise<{ kind: "ok"; row: LessonRow } | { kind: "stable_key_taken" }>;
  insertVersion(sql: Sql, p: { lessonId: string; versionNo: number; content: unknown; createdBy: string; validationErrors: readonly ValidationError[] }): Promise<VersionRow>;
  updateDraft(sql: Sql, p: { versionId: string; content: unknown; validationErrors: readonly ValidationError[] }): Promise<VersionRow>;
  replaceItems(sql: Sql, versionId: string, items: readonly BankItem[]): Promise<void>;
  linkOutcomes(sql: Sql, lessonId: string, outcomeKeys: readonly string[]): Promise<void>;

  // Workflow (SECURITY DEFINER functions; audited in SQL)
  transition(sql: Sql, p: { versionId: string; action: "submit" | "approve" | "reject"; actor: string; comment: string | null }): Promise<LessonStatus>;
  publish(sql: Sql, p: { lessonId: string; versionId: string; reason: string; actor: string }): Promise<{ manifestRevision: number; publishedAt: Date }>;
  unpublish(sql: Sql, p: { lessonId: string; reason: string; actor: string }): Promise<{ manifestRevision: number; unpublishedAt: Date }>;
  pin(sql: Sql, p: { revision: number; actor: string }): Promise<{ manifestRevision: number; pinnedFromRevision: number }>;

  // Idempotency (bnl.idempotency_keys, scoped to the actor by RLS)
  claimIdempotency(sql: Sql, p: { scope: string; actor: string; key: string; requestSha256: string; now: Date }): Promise<IdempotencyClaim>;
  completeIdempotency(sql: Sql, p: { scope: string; actor: string; key: string; status: number; body: unknown }): Promise<void>;
}
