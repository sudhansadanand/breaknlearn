/**
 * ELS evidence for one learner, for the scoring job (A8, `bnl_job` context) or an adult read (`bnl_adult`,
 * RLS-limited to own households). Loads stored attempts + server-scored responses and turns them into
 * `@bnl/intelligence` ElsInput per topic with `buildElsInputs` — missing stages stay null (never zero).
 */
import { DEFAULT_TIMEZONE, buildElsInputs, safeTimezone, type AttemptEvidence, type Stage, type TopicEls } from "@bnl/assessment";
import type { Sql } from "../db-port";

interface Row {
  id: string;
  lesson_id: string;
  topic_id: string | null;
  stage: Stage;
  started_at: Date;
  finished_at: Date | null;
  question_keys: unknown;
  timezone: string | null;
}

export async function loadAttemptEvidence(sql: Sql, learnerId: string): Promise<{ attempts: AttemptEvidence[]; timezone: string; exposureByLesson: Map<string, Date> }> {
  const rows = await sql<Row[]>`
    select a.id, a.lesson_id, l.topic_id, a.stage, a.started_at, a.finished_at, a.question_keys, h.timezone
      from bnl.assessment_attempts a
      join bnl.lessons l on l.id = a.lesson_id
      join bnl.households h on h.id = a.household_id
     where a.learner_id = ${learnerId}
     order by a.started_at, a.id`;
  const ids = rows.map((r) => r.id);
  const responses =
    ids.length === 0
      ? []
      : await sql<{ attempt_id: string; question_version_key: string; correct: boolean; answered_at: Date }[]>`
          select attempt_id, question_version_key, correct, answered_at from bnl.question_responses
           where attempt_id = any(${sql.array(ids)}::uuid[])`;
  const exposure = await sql<{ lesson_id: string; first_at: Date }[]>`
    select lesson_id, min(created_at) as first_at from bnl.learner_progress where learner_id = ${learnerId} group by lesson_id`;

  const attempts = rows.map((r): AttemptEvidence => ({
    attemptId: r.id,
    lessonId: r.lesson_id,
    topicId: r.topic_id,
    stage: r.stage,
    startedAt: new Date(r.started_at),
    finishedAt: r.finished_at === null ? null : new Date(r.finished_at),
    questionKeys: Array.isArray(r.question_keys) ? r.question_keys.map(String) : [],
    responses: responses
      .filter((x) => x.attempt_id === r.id)
      .map((x) => ({ questionVersionKey: x.question_version_key, correct: x.correct, answeredAt: new Date(x.answered_at) })),
  }));
  return {
    attempts,
    timezone: safeTimezone(rows[0]?.timezone ?? DEFAULT_TIMEZONE),
    exposureByLesson: new Map(exposure.map((e) => [e.lesson_id, new Date(e.first_at)])),
  };
}

/** ELS inputs per topic for one learner (completion, when known, is supplied by the caller from progress). */
export async function elsInputsForLearner(
  sql: Sql,
  learnerId: string,
  now: Date,
  completionByTopic?: ReadonlyMap<string | null, { completedSlides: number; assignedSlides: number }>,
): Promise<TopicEls[]> {
  const ev = await loadAttemptEvidence(sql, learnerId);
  return buildElsInputs({ learnerId, attempts: ev.attempts, now, timezone: ev.timezone, exposureByLesson: ev.exposureByLesson, ...(completionByTopic ? { completionByTopic } : {}) });
}
