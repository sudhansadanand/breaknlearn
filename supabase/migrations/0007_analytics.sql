-- BreakNLearn 0007 (A8, Intelligence & Analytics): per-lesson score snapshots, explainable recommendations,
-- and the analytics half of the retention purge.
--
-- 1. mastery_snapshots: + lesson_id (null = topic-level row), + evidence (flags + per-stage reasons).
--    The ×1..×10 lessons share one topic, so the 0001 key (score_run_id, learner_id, topic_id) cannot hold
--    one row per table; it is replaced by (score_run_id, learner_id, topic_id, lesson_id). The scoring job is
--    idempotent on (learner_id, topic_id, lesson_id, score_date, weights_version): re-running a day replaces
--    that day's row; a new weights_version or as-of date adds rows and never mutates history (ELS-008).
-- 2. recommendations: + lesson_id, + detail (rule version, thresholds, inputs), + superseded_at. At most one
--    ACTIVE (not superseded) row per (learner, topic, lesson, reason); dismissal stays on that row, so a
--    recommendation a guardian dismissed is not re-raised by the next nightly run (reversible: clear dismissed_at).
-- 3. bnl.purge_expired_analytics(days): deletes aggregates older than the aggregate window (default 395 d ≈ 13
--    months) that bnl.purge_expired (0003) does not cover. SECURITY DEFINER, owned by bnl_owner, fixed
--    search_path, EXECUTE for bnl_job only, audited.
-- Additive and re-runnable. No table is created, so ENABLE + FORCE RLS and ADR-0005 grants are unchanged:
-- bnl_job already writes mastery_snapshots/recommendations/score_runs; bnl_adult reads its households' rows and
-- may update only recommendations.dismissed_at (0002).

alter table bnl.mastery_snapshots add column if not exists lesson_id uuid references bnl.lessons(id);
alter table bnl.mastery_snapshots add column if not exists evidence jsonb not null default '{}'::jsonb;
alter table bnl.recommendations add column if not exists lesson_id uuid references bnl.lessons(id);
alter table bnl.recommendations add column if not exists detail jsonb not null default '{}'::jsonb;
alter table bnl.recommendations add column if not exists superseded_at timestamptz;
do $chk$
begin
  if not exists (select 1 from pg_constraint where conname = 'mastery_snapshots_evidence_object') then
    alter table bnl.mastery_snapshots add constraint mastery_snapshots_evidence_object check (jsonb_typeof(evidence) = 'object');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'recommendations_detail_object') then
    alter table bnl.recommendations add constraint recommendations_detail_object check (jsonb_typeof(detail) = 'object');
  end if;
end
$chk$;

drop index if exists bnl.uq_mastery_run_learner_topic;
create unique index if not exists uq_mastery_run_learner_topic_lesson
  on bnl.mastery_snapshots(score_run_id, learner_id, topic_id, lesson_id) nulls not distinct where score_run_id is not null;
create unique index if not exists uq_mastery_daily
  on bnl.mastery_snapshots(learner_id, topic_id, lesson_id, score_date, weights_version) nulls not distinct;
create index if not exists idx_mastery_household_learner_date on bnl.mastery_snapshots(household_id, learner_id, score_date desc);

create unique index if not exists uq_recommendation_active
  on bnl.recommendations(learner_id, topic_id, lesson_id, reason_code) nulls not distinct where superseded_at is null;

create or replace function bnl.purge_expired_analytics(p_aggregate_days integer default 395) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
declare
  v_cutoff timestamptz;
  v_sessions bigint;
  v_attempts bigint;
  v_reviews bigint;
  v_runs bigint;
  v_aggr bigint;
  v_jobs bigint;
  v_result jsonb;
begin
  if p_aggregate_days is null or p_aggregate_days < 30 then
    raise exception 'bnl: invalid aggregate retention window' using errcode = '22023';
  end if;
  v_cutoff := now() - make_interval(days => p_aggregate_days);
  -- Closed reviews first (open ones stay until answered/dismissed or their source attempt expires).
  delete from bnl.review_schedule where status <> 'due' and due_at < v_cutoff;
  get diagnostics v_reviews = row_count;
  -- Assessment records (responses and dependent reviews cascade).
  delete from bnl.assessment_attempts where started_at < v_cutoff;
  get diagnostics v_attempts = row_count;
  -- Session totals (raw events are purged earlier by bnl.purge_expired; any leftovers cascade).
  delete from bnl.learning_sessions where started_at < v_cutoff;
  get diagnostics v_sessions = row_count;
  -- Score runs no snapshot or recommendation still refers to.
  delete from bnl.score_runs r where r.started_at < v_cutoff
     and not exists (select 1 from bnl.mastery_snapshots s where s.score_run_id = r.id)
     and not exists (select 1 from bnl.recommendations x where x.score_run_id = r.id);
  get diagnostics v_runs = row_count;
  delete from bnl.aggregation_runs where started_at < v_cutoff;
  get diagnostics v_aggr = row_count;
  delete from bnl.job_runs where started_at < v_cutoff;
  get diagnostics v_jobs = row_count;
  v_result := jsonb_build_object('learning_sessions', v_sessions, 'assessment_attempts', v_attempts,
    'review_schedule', v_reviews, 'score_runs', v_runs, 'aggregation_runs', v_aggr, 'job_runs', v_jobs,
    'aggregate_days', p_aggregate_days);
  perform bnl._audit('job', null, null, 'retention.purge_analytics', 'job_run', null, v_result);
  return v_result;
end
$$;

alter function bnl.purge_expired_analytics(integer) owner to bnl_owner;
revoke all on function bnl.purge_expired_analytics(integer) from public;
grant execute on function bnl.purge_expired_analytics(integer) to bnl_job;

-- Final sweep (every migration ends with this): nothing in bnl is reachable by PUBLIC/anon/authenticated.
revoke all on all tables in schema bnl from public, anon, authenticated;
revoke all on all sequences in schema bnl from public, anon, authenticated;
revoke all on all functions in schema bnl from public, anon, authenticated;
