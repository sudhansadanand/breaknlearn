-- OPERATOR PROCEDURE (OPS-005 interim, until an automated deletion job exists): execute ONE guardian deletion request.
-- Runs with the migration/owner connection (never a request role), inside one transaction, scoped to exactly one
-- household. Audited without names. See docs/ops/PRIVACY.md §Deletion for the full procedure and approvals.
--
--   psql "$MIGRATION_DB_URL" -v ON_ERROR_STOP=1 -1 \
--        -c "select set_config('bnl_ops.request_id', '<data_deletion_requests.id>', false)" \
--        -f scripts/ops/sql/process-deletion-request.sql
--
-- Scopes (from the request row): 'telemetry_only' = raw events + sessions of the household (or one learner);
-- 'learner' = everything about one learner (profile, progress, events, sessions, attempts, responses, reviews,
-- scores, recommendations, aliases); 'household' = the household and everything in it (devices, memberships,
-- consent, school uploads metadata). Storage objects under '<household_id>/' must be removed separately
-- (Supabase Storage: bucket school-syllabi), listed in the audit metadata as object_keys_to_remove.
-- Act as the owner of every bnl table (owner_all policies); FORCE RLS would otherwise hide every row from the migration login.
set local role bnl_owner;
do $proc$
declare
  v_req bnl.data_deletion_requests;
  v_counts jsonb := '{}'::jsonb;
  v_n bigint;
  v_keys jsonb;
  t text;
begin
  select * into v_req from bnl.data_deletion_requests
   where id = current_setting('bnl_ops.request_id')::uuid and status in ('requested', 'processing') for update;
  if not found then
    raise exception 'deletion request % not found or already processed', current_setting('bnl_ops.request_id');
  end if;
  update bnl.data_deletion_requests set status = 'processing' where id = v_req.id;

  if v_req.scope = 'telemetry_only' then
    foreach t in array array['learning_events', 'learning_sessions'] loop
      execute format('delete from bnl.%I where household_id = $1 and ($2::uuid is null or learner_id = $2)', t) using v_req.household_id, v_req.learner_id;
      get diagnostics v_n = row_count;
      v_counts := v_counts || jsonb_build_object(t, v_n);
    end loop;

  elsif v_req.scope = 'learner' then
    if not exists (select 1 from bnl.learner_profiles where id = v_req.learner_id and household_id = v_req.household_id) then
      raise exception 'learner % is not in household %', v_req.learner_id, v_req.household_id;
    end if;
    foreach t in array array['question_responses', 'review_schedule', 'assessment_attempts', 'learning_events', 'learning_sessions',
                             'learner_progress', 'mastery_snapshots', 'recommendations', 'migration_aliases'] loop
      execute format('delete from bnl.%I where household_id = $1 and learner_id = $2', t) using v_req.household_id, v_req.learner_id;
      get diagnostics v_n = row_count;
      v_counts := v_counts || jsonb_build_object(t, v_n);
    end loop;
    delete from bnl.idempotency_keys where household_id = v_req.household_id;  -- 24 h response caches may echo learner state
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object('idempotency_keys', v_n);
    delete from bnl.learner_profiles where id = v_req.learner_id and household_id = v_req.household_id;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object('learner_profiles', v_n);

  elsif v_req.scope = 'household' then
    select coalesce(jsonb_agg(object_key), '[]'::jsonb) into v_keys from bnl.syllabus_uploads where household_id = v_req.household_id;
    v_counts := v_counts || jsonb_build_object('object_keys_to_remove', v_keys);
    -- Children whose foreign keys to devices carry no cascade go first; the household delete cascades the rest.
    foreach t in array array['question_responses', 'review_schedule', 'assessment_attempts', 'learning_events', 'learning_sessions',
                             'migration_aliases', 'migration_runs', 'device_pairing_codes', 'idempotency_keys'] loop
      execute format('delete from bnl.%I where household_id = $1', t) using v_req.household_id;
      get diagnostics v_n = row_count;
      v_counts := v_counts || jsonb_build_object(t, v_n);
    end loop;
    delete from bnl.households where id = v_req.household_id;  -- cascades profiles, progress, scores, devices, plans, consent, this request
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object('households', v_n);
  else
    raise exception 'unknown scope %', v_req.scope;
  end if;

  if v_req.scope <> 'household' then
    update bnl.data_deletion_requests set status = 'completed', completed_at = now(), result = v_counts where id = v_req.id;
  end if;
  insert into bnl.audit_logs (actor_type, household_id, action, target_type, target_id, metadata)
  values ('system', case when v_req.scope = 'household' then null else v_req.household_id end, 'privacy.deletion_completed',
          'data_deletion_request', v_req.id, jsonb_build_object('scope', v_req.scope, 'counts', v_counts));
end
$proc$;
