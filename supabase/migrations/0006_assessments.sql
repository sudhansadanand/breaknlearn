-- BreakNLearn 0006 (A7, Assessments): make attempt scoring authoritative inside the database.
--
-- Gap closed: bnl_device holds UPDATE on bnl.assessment_attempts (0002), so a request-path bug could write
-- total_questions / correct_questions directly, and an attempt with empty question_keys let bnl.score_answer
-- accept ANY item of the version. This migration adds:
--   1. assessment_attempts guard: identity columns (learner, device, lesson, version, stage, seed, question_keys,
--      client_attempt_id, started_at) are immutable; totals are COMPUTED from server-scored question_responses
--      when finished_at is first set and frozen afterwards; supplied totals are ignored.
--   2. question_responses guard: a response must be for a question presented in its attempt (question_keys),
--      and the attempt must not be finished. score_answer (0003) remains the only writer.
--   3. One open ('due') review per learner and lesson in review_schedule, so repeated quizzes or concurrent
--      finishes cannot stack reviews.
--   4. Index for "this learner's attempts on this lesson" lookups by stage.
-- Additive and re-runnable; no table is created, so RLS/grants are unchanged (all tables keep ENABLE + FORCE RLS).

create or replace function bnl.tg_assessment_attempts_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
declare
  v_correct integer;
begin
  if tg_op = 'INSERT' then
    new.total_questions := 0;
    new.correct_questions := 0;
    if new.finished_at is not null then
      -- An attempt created already finished (e.g. insufficient_items) has no responses yet.
      new.total_questions := jsonb_array_length(new.question_keys);
    end if;
    return new;
  end if;

  if new.household_id is distinct from old.household_id or new.learner_id is distinct from old.learner_id
     or new.device_id is distinct from old.device_id or new.lesson_id is distinct from old.lesson_id
     or new.lesson_version_id is distinct from old.lesson_version_id or new.client_attempt_id is distinct from old.client_attempt_id
     or new.stage is distinct from old.stage or new.seed is distinct from old.seed
     or new.question_keys is distinct from old.question_keys or new.started_at is distinct from old.started_at then
    raise exception 'bnl: assessment attempt % identity is immutable', old.id using errcode = '55000';
  end if;

  if old.finished_at is not null then
    if new.finished_at is distinct from old.finished_at or new.total_questions is distinct from old.total_questions
       or new.correct_questions is distinct from old.correct_questions then
      raise exception 'bnl: assessment attempt % is finished', old.id using errcode = '55000';
    end if;
    return new;
  end if;

  if new.finished_at is null then
    new.total_questions := old.total_questions;
    new.correct_questions := old.correct_questions;
    return new;
  end if;

  -- Finishing: totals come only from server-scored responses to presented questions (TEL-005).
  select count(*) into v_correct from bnl.question_responses r
   where r.attempt_id = old.id and r.correct and old.question_keys ? r.question_version_key;
  new.total_questions := jsonb_array_length(old.question_keys);
  new.correct_questions := least(v_correct, new.total_questions);
  return new;
end
$$;

drop trigger if exists assessment_attempts_guard on bnl.assessment_attempts;
create trigger assessment_attempts_guard before insert or update on bnl.assessment_attempts
  for each row execute function bnl.tg_assessment_attempts_guard();

create or replace function bnl.tg_question_responses_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
declare
  a bnl.assessment_attempts;
begin
  if tg_op = 'UPDATE' then
    raise exception 'bnl: question responses are immutable' using errcode = '55000';
  end if;
  select * into a from bnl.assessment_attempts where id = new.attempt_id;
  if not found then
    raise exception 'bnl: attempt not found' using errcode = 'P0002';
  end if;
  if a.finished_at is not null then
    raise exception 'bnl: attempt already finished' using errcode = '55000';
  end if;
  if not (a.question_keys ? new.question_version_key) then
    raise exception 'bnl: question is not part of this attempt' using errcode = '22023';
  end if;
  if new.learner_id is distinct from a.learner_id or new.household_id is distinct from a.household_id then
    raise exception 'bnl: response does not match its attempt' using errcode = '22023';
  end if;
  return new;
end
$$;

drop trigger if exists question_responses_guard on bnl.question_responses;
create trigger question_responses_guard before insert or update on bnl.question_responses
  for each row execute function bnl.tg_question_responses_guard();

create unique index if not exists uq_review_open_per_lesson on bnl.review_schedule(learner_id, lesson_id)
  where status = 'due' and lesson_id is not null;
create index if not exists idx_attempts_learner_lesson_stage on bnl.assessment_attempts(learner_id, lesson_id, stage, started_at);

alter function bnl.tg_assessment_attempts_guard() owner to bnl_owner;
alter function bnl.tg_question_responses_guard() owner to bnl_owner;
revoke all on function bnl.tg_assessment_attempts_guard() from public;
revoke all on function bnl.tg_question_responses_guard() from public;

-- Final sweep (every migration ends with this): nothing in bnl is reachable by PUBLIC/anon/authenticated.
revoke all on all tables in schema bnl from public, anon, authenticated;
revoke all on all sequences in schema bnl from public, anon, authenticated;
revoke all on all functions in schema bnl from public, anon, authenticated;
