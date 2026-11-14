import type { PublicItem } from "@bnl/assessment";
import type { Sql } from "../db-port";
import { sqlLearningRepo } from "../learning/sql-repo";
import type { AssessmentRepo, AttemptRow, ReviewRow } from "./repo";

type JsonParam = Parameters<Sql["json"]>[0];
const json = (sql: Sql, v: unknown) => sql.json(v as JsonParam);

const ATTEMPT_COLS = `id, household_id as "householdId", learner_id as "learnerId", device_id as "deviceId", lesson_id as "lessonId",
  lesson_version_id as "lessonVersionId", client_attempt_id as "clientAttemptId", stage, seed, question_keys as "questionKeys",
  started_at as "startedAt", finished_at as "finishedAt", total_questions::int4 as "totalQuestions",
  correct_questions::int4 as "correctQuestions"`;

const REVIEW_COLS = `id, learner_id as "learnerId", lesson_id as "lessonId", topic_id as "topicId",
  source_attempt_id as "sourceAttemptId", due_at as "dueAt", status`;

const asAttempt = (r: AttemptRow): AttemptRow => ({
  ...r,
  startedAt: new Date(r.startedAt),
  finishedAt: r.finishedAt === null ? null : new Date(r.finishedAt),
  questionKeys: Array.isArray(r.questionKeys) ? r.questionKeys.map(String) : [],
});
const asReview = (r: ReviewRow): ReviewRow => ({ ...r, dueAt: new Date(r.dueAt) });

export const sqlAssessmentRepo: AssessmentRepo = {
  // Same table and semantics as the learning endpoints (bnl.idempotency_keys, 24 h TTL).
  claimIdempotency: (sql, c) => sqlLearningRepo.claimIdempotency(sql, c),
  completeIdempotency: (sql, c) => sqlLearningRepo.completeIdempotency(sql, c),

  async learnerInHousehold(sql, householdId, learnerId) {
    const rows = await sql`select 1 from bnl.learner_profiles where id = ${learnerId} and household_id = ${householdId}`;
    return rows.length > 0;
  },

  async householdTimezone(sql, householdId) {
    const [row] = await sql<{ timezone: string }[]>`select timezone from bnl.households where id = ${householdId}`;
    return row?.timezone ?? null;
  },

  async liveLesson(sql, lessonId) {
    const [row] = await sql<{ lessonId: string; topicId: string | null; versionId: string; versionNo: number; stableKey: string; config: unknown }[]>`
      select l.id as "lessonId", l.topic_id as "topicId", v.id as "versionId", v.version_no as "versionNo", l.stable_key as "stableKey",
             v.content->'config' as config
        from bnl.lessons l join bnl.lesson_versions v on v.lesson_id = l.id
       where l.id = ${lessonId} and bnl.version_is_live(v.id)
       order by v.version_no desc limit 1`;
    if (!row) return null;
    return { ...row, config: typeof row.config === "object" && row.config !== null ? (row.config as Record<string, unknown>) : {} };
  },

  async versionRef(sql, versionId) {
    const [row] = await sql<{ versionId: string; versionNo: number; stableKey: string; config: unknown }[]>`
      select v.id as "versionId", v.version_no as "versionNo", l.stable_key as "stableKey", v.content->'config' as config
        from bnl.lesson_versions v join bnl.lessons l on l.id = v.lesson_id where v.id = ${versionId}`;
    if (!row) return null;
    return { ...row, config: typeof row.config === "object" && row.config !== null ? (row.config as Record<string, unknown>) : {} };
  },

  async publicItems(sql, versionId) {
    return sql<PublicItem[]>`
      select question_version_key, outcome_key, stage_eligibility, prompt, options, sort_order
        from bnl.quiz_questions_for_version(${versionId})`;
  },

  async hasProgress(sql, learnerId, lessonId) {
    const rows = await sql`select 1 from bnl.learner_progress where learner_id = ${learnerId} and lesson_id = ${lessonId} limit 1`;
    return rows.length > 0;
  },

  async attemptByClientId(sql, clientAttemptId) {
    const [row] = await sql<AttemptRow[]>`select ${sql.unsafe(ATTEMPT_COLS)} from bnl.assessment_attempts where client_attempt_id = ${clientAttemptId}`;
    return row ? asAttempt(row) : null;
  },

  async attemptForUpdate(sql, attemptId) {
    const [row] = await sql<AttemptRow[]>`select ${sql.unsafe(ATTEMPT_COLS)} from bnl.assessment_attempts where id = ${attemptId} for update`;
    return row ? asAttempt(row) : null;
  },

  async learnerLessonAttempts(sql, learnerId, lessonId) {
    const rows = await sql<AttemptRow[]>`
      select ${sql.unsafe(ATTEMPT_COLS)} from bnl.assessment_attempts
       where learner_id = ${learnerId} and lesson_id = ${lessonId} order by started_at, id`;
    return rows.map(asAttempt);
  },

  async insertAttempt(sql, a) {
    const [row] = await sql<AttemptRow[]>`
      insert into bnl.assessment_attempts (household_id, learner_id, device_id, lesson_id, lesson_version_id, client_attempt_id,
        stage, seed, question_keys, started_at, finished_at)
      values (${a.householdId}, ${a.learnerId}, ${a.deviceId}, ${a.lessonId}, ${a.lessonVersionId}, ${a.clientAttemptId},
        ${a.stage}, ${a.seed}, ${json(sql, a.questionKeys)}, ${a.startedAt}, ${a.finishedAt})
      on conflict (client_attempt_id) do nothing
      returning ${sql.unsafe(ATTEMPT_COLS)}`;
    return row ? asAttempt(row) : null;
  },

  async finishAttempt(sql, attemptId, at) {
    const [row] = await sql<AttemptRow[]>`
      update bnl.assessment_attempts set finished_at = ${at} where id = ${attemptId} and finished_at is null
      returning ${sql.unsafe(ATTEMPT_COLS)}`;
    if (!row) throw new Error("attempt was not open while locked");
    return asAttempt(row);
  },

  async responsesFor(sql, attemptIds) {
    if (attemptIds.length === 0) return [];
    return (
      await sql<{ attemptId: string; questionVersionKey: string; correct: boolean; answeredAt: Date }[]>`
        select attempt_id as "attemptId", question_version_key as "questionVersionKey", correct, answered_at as "answeredAt"
          from bnl.question_responses where attempt_id = any(${sql.array([...attemptIds])}::uuid[])
         order by answered_at, id`
    ).map((r) => ({ ...r, answeredAt: new Date(r.answeredAt) }));
  },

  async scoreAnswer(sql, p) {
    const [row] = await sql<{ correct: boolean; correct_option_id: string; already_answered: boolean }[]>`
      select correct, correct_option_id, already_answered
        from bnl.score_answer(${p.attemptId}, ${p.questionVersionKey}, ${p.selectedOptionId}, ${p.responseMs}::integer)`;
    if (!row) throw new Error("score_answer returned no row");
    return { correct: row.correct, correctOptionId: row.correct_option_id, alreadyAnswered: row.already_answered };
  },

  async reviewsForLearner(sql, learnerId, lessonId) {
    const rows = await sql<ReviewRow[]>`
      select ${sql.unsafe(REVIEW_COLS)} from bnl.review_schedule
       where learner_id = ${learnerId} ${lessonId ? sql`and lesson_id = ${lessonId}` : sql``}
       order by due_at, id`;
    return rows.map(asReview);
  },

  async insertReview(sql, r) {
    const rows = await sql`
      insert into bnl.review_schedule (household_id, learner_id, topic_id, lesson_id, source_attempt_id, due_at)
      values (${r.householdId}, ${r.learnerId}, ${r.topicId}, ${r.lessonId}, ${r.sourceAttemptId}, ${r.dueAt})
      on conflict (learner_id, lesson_id) where status = 'due' and lesson_id is not null do nothing
      returning id`;
    return rows.length > 0;
  },

  async completeOpenReviews(sql, learnerId, lessonId) {
    const rows = await sql`
      update bnl.review_schedule set status = 'completed'
       where learner_id = ${learnerId} and lesson_id = ${lessonId} and status = 'due' returning id`;
    return rows.length;
  },
};
