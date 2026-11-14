/**
 * Data access for the assessment endpoints (M08). Thin SQL; handlers own the rules. Every method runs inside
 * the caller's `withDevice` (or job) transaction, so RLS scopes it to one household independently of the
 * handler checks (ADR-0005). Answer keys are never read here: questions come from
 * `bnl.quiz_questions_for_version` and correctness from `bnl.score_answer` (both SECURITY DEFINER).
 */
import type { PublicItem, ScheduledReview, Stage } from "@bnl/assessment";
import type { Sql } from "../db-port";

export interface IdempotencyClaim {
  readonly scope: string;
  readonly key: string;
  readonly ownerId: string;
  readonly householdId: string | null;
  readonly requestSha256: string;
  readonly now: Date;
}

export type IdempotencyState =
  | { readonly kind: "new" }
  | { readonly kind: "replay"; readonly status: number; readonly body: unknown }
  | { readonly kind: "mismatch" };

export interface LiveLesson {
  readonly lessonId: string;
  readonly topicId: string | null;
  readonly versionId: string;
  readonly versionNo: number;
  readonly stableKey: string;
  /** `content.config` of the live version (factor, quiz_question_count, …). */
  readonly config: Record<string, unknown>;
}

export interface VersionRef {
  readonly versionId: string;
  readonly versionNo: number;
  readonly stableKey: string;
  readonly config: Record<string, unknown>;
}

export interface AttemptRow {
  readonly id: string;
  readonly householdId: string;
  readonly learnerId: string;
  readonly deviceId: string;
  readonly lessonId: string;
  readonly lessonVersionId: string;
  readonly clientAttemptId: string;
  readonly stage: Stage;
  readonly seed: string;
  readonly questionKeys: string[];
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly totalQuestions: number;
  readonly correctQuestions: number;
}

export interface AttemptInsert {
  readonly householdId: string;
  readonly learnerId: string;
  readonly deviceId: string;
  readonly lessonId: string;
  readonly lessonVersionId: string;
  readonly clientAttemptId: string;
  readonly stage: Stage;
  readonly seed: string;
  readonly questionKeys: readonly string[];
  readonly startedAt: Date;
  /** Set for attempts that cannot be answered (insufficient_items). */
  readonly finishedAt: Date | null;
}

export interface ResponseRow {
  readonly attemptId: string;
  readonly questionVersionKey: string;
  readonly correct: boolean;
  readonly answeredAt: Date;
}

export interface ScoreResult {
  readonly correct: boolean;
  readonly correctOptionId: string;
  readonly alreadyAnswered: boolean;
}

export interface ReviewRow extends ScheduledReview {
  readonly learnerId: string;
}

export interface ReviewInsert {
  readonly householdId: string;
  readonly learnerId: string;
  readonly lessonId: string;
  readonly topicId: string | null;
  readonly sourceAttemptId: string;
  readonly dueAt: Date;
}

export interface AssessmentRepo {
  claimIdempotency(sql: Sql, c: IdempotencyClaim): Promise<IdempotencyState>;
  completeIdempotency(sql: Sql, c: { scope: string; key: string; ownerId: string; status: number; body: unknown }): Promise<void>;

  learnerInHousehold(sql: Sql, householdId: string, learnerId: string): Promise<boolean>;
  householdTimezone(sql: Sql, householdId: string): Promise<string | null>;
  liveLesson(sql: Sql, lessonId: string): Promise<LiveLesson | null>;
  versionRef(sql: Sql, versionId: string): Promise<VersionRef | null>;
  /** Questions WITHOUT answer keys (bnl.quiz_questions_for_version). */
  publicItems(sql: Sql, versionId: string): Promise<PublicItem[]>;
  /** Any learner_progress row for (learner, lesson): the learner has been exposed to the lesson. */
  hasProgress(sql: Sql, learnerId: string, lessonId: string): Promise<boolean>;

  attemptByClientId(sql: Sql, clientAttemptId: string): Promise<AttemptRow | null>;
  /** Locks the row (`for update`); null when not visible in this household. */
  attemptForUpdate(sql: Sql, attemptId: string): Promise<AttemptRow | null>;
  learnerLessonAttempts(sql: Sql, learnerId: string, lessonId: string): Promise<AttemptRow[]>;
  /** Null when client_attempt_id already exists (in any household). */
  insertAttempt(sql: Sql, a: AttemptInsert): Promise<AttemptRow | null>;
  /** Sets finished_at; the DB computes total/correct from scored responses. */
  finishAttempt(sql: Sql, attemptId: string, at: Date): Promise<AttemptRow>;

  responsesFor(sql: Sql, attemptIds: readonly string[]): Promise<ResponseRow[]>;
  scoreAnswer(sql: Sql, p: { attemptId: string; questionVersionKey: string; selectedOptionId: string; responseMs: number | null }): Promise<ScoreResult>;

  reviewsForLearner(sql: Sql, learnerId: string, lessonId?: string): Promise<ReviewRow[]>;
  /** `on conflict do nothing` (one open review per learner+lesson); returns whether a row was inserted. */
  insertReview(sql: Sql, r: ReviewInsert): Promise<boolean>;
  completeOpenReviews(sql: Sql, learnerId: string, lessonId: string): Promise<number>;
}
