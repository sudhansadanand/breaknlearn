-- BreakNLearn 0009: parental consent enforcement, guardian data export, automated deletion (A9-PRIV-01, OPS-005).
-- Additive and re-runnable (create or replace / if not exists / drop policy if exists). Every function is
-- SECURITY DEFINER, owned by bnl_owner, with a fixed search_path; EXECUTE is granted to exactly one request role.
--
--   bnl.household_has_consent(scope)       bnl_device  true iff the CALLER's household (device context) holds an
--                                                      unrevoked consent row for the scope; never takes a household id
--   bnl.export_household(household_id)     bnl_adult   the household's rows as jsonb, secret columns removed;
--                                                      refuses a household the caller is not an adult member of
--   bnl.process_deletion_request(id, n)    bnl_job     executes one data_deletion_requests row (port of
--                                                      scripts/ops/sql/process-deletion-request.sql), audited without names

-- ---------------------------------------------------------------------------
-- Consent lookups: one indexed probe per gated request
-- ---------------------------------------------------------------------------
create index if not exists idx_consent_active_scope on bnl.consent_records(household_id, scope) where revoked_at is null;

-- Consent is held by the household: any owner/guardian of it may withdraw any active grant (not only their own).
-- Only revoked_at is updatable (column grant in 0002); inserts still require guardian_auth_user_id = the caller.
drop policy if exists adult_revoke on bnl.consent_records;
create policy adult_revoke on bnl.consent_records for update to bnl_adult
  using (household_id in (select bnl.adult_household_ids()))
  with check (household_id in (select bnl.adult_household_ids()));

create or replace function bnl.household_has_consent(p_scope text) returns boolean
language sql stable security definer set search_path = pg_catalog, pg_temp
as $$
  select coalesce(bnl.current_household_id() is not null and bnl.current_device_id() is not null and bnl.device_ok()
    and exists (
      select 1 from bnl.consent_records r
      where r.household_id = bnl.current_household_id() and r.scope = p_scope and r.revoked_at is null), false)
$$;

-- ---------------------------------------------------------------------------
-- Export: every household-scoped row, generic over bnl tables with a household_id column
-- ---------------------------------------------------------------------------
create or replace function bnl.export_household(p_household_id uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp
as $$
declare
  v_tables jsonb := '{}'::jsonb;
  v_rows jsonb;
  v_drop text[];
  t record;
begin
  if p_household_id is null or not exists (select 1 from bnl.adult_household_ids() h where h = p_household_id) then
    raise exception 'bnl: not a member of this household' using errcode = '42501';
  end if;
  for t in
    select c.oid, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'bnl' and c.relkind in ('r', 'p')
      and (c.relname = 'households' or exists (
        select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'household_id' and a.attnum > 0 and not a.attisdropped))
      -- 24 h replay caches (request digests, cached responses); purged daily and not personal records.
      and c.relname <> 'idempotency_keys'
    order by c.relname
  loop
    -- Credentials never leave the database: token/secret/hash/password columns are removed.
    select coalesce(array_agg(a.attname::text), '{}') into v_drop from pg_attribute a
     where a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped and a.attname ~ '(token|secret|hash|password)';
    execute format(
      'select coalesce(jsonb_agg(to_jsonb(x) - $2 order by to_jsonb(x)->>''created_at'', to_jsonb(x)->>''id''), ''[]''::jsonb) from bnl.%I x where %s = $1',
      t.relname, case when t.relname = 'households' then 'x.id' else 'x.household_id' end)
      into v_rows using p_household_id, v_drop;
    v_tables := v_tables || jsonb_build_object(t.relname, v_rows);
  end loop;
  return jsonb_build_object('household_id', p_household_id, 'generated_at', now(), 'tables', v_tables);
end
$$;

-- ---------------------------------------------------------------------------
-- Deletion: one request, executed by the process-deletion-requests job (bnl_job only)
-- ---------------------------------------------------------------------------
-- p_storage_objects_removed: how many school-syllabi objects the job removed from Storage before calling this
-- (household scope only; recorded in the counts). Raises P0002 when the request is unknown or already finished.
create or replace function bnl.process_deletion_request(p_request_id uuid, p_storage_objects_removed integer default 0) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
declare
  v_req bnl.data_deletion_requests;
  v_counts jsonb := '{}'::jsonb;
  v_n bigint;
  v_keys jsonb;
  t text;
begin
  select * into v_req from bnl.data_deletion_requests
   where id = p_request_id and status in ('requested', 'processing') for update;
  if not found then
    raise exception 'bnl: deletion request % not found or already processed', p_request_id using errcode = 'P0002';
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
      -- Never a cross-tenant delete; a learner already removed (or of another household) closes the request.
      update bnl.data_deletion_requests set status = 'rejected', completed_at = now(),
        result = jsonb_build_object('reason', 'learner_not_in_household') where id = v_req.id;
      perform bnl._audit('job', null, v_req.household_id, 'privacy.deletion_rejected', 'data_deletion_request', v_req.id,
        jsonb_build_object('scope', v_req.scope, 'reason', 'learner_not_in_household'));
      return jsonb_build_object('status', 'rejected', 'reason', 'learner_not_in_household');
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
    -- The job removes these objects from Storage first and passes how many it removed. Keys (`<household>/<uuid>`,
    -- never file names) stay listed under object_keys_to_remove only when that count does not cover them all.
    select coalesce(jsonb_agg(object_key order by object_key), '[]'::jsonb) into v_keys from bnl.syllabus_uploads where household_id = v_req.household_id;
    v_counts := v_counts || jsonb_build_object(
      case when coalesce(p_storage_objects_removed, 0) >= jsonb_array_length(v_keys) then 'object_keys_removed' else 'object_keys_to_remove' end, v_keys,
      'storage_objects_removed', greatest(coalesce(p_storage_objects_removed, 0), 0));
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
    raise exception 'bnl: unknown deletion scope %', v_req.scope using errcode = '22023';
  end if;

  if v_req.scope <> 'household' then
    update bnl.data_deletion_requests set status = 'completed', completed_at = now(), result = v_counts where id = v_req.id;
  end if;
  -- The household row is gone for a household delete, so its audit row carries no household id (and never a name).
  perform bnl._audit('job', null, case when v_req.scope = 'household' then null else v_req.household_id end,
    'privacy.deletion_completed', 'data_deletion_request', v_req.id, jsonb_build_object('scope', v_req.scope, 'counts', v_counts));
  return jsonb_build_object('status', 'completed', 'scope', v_req.scope, 'counts', v_counts);
end
$$;

-- ---------------------------------------------------------------------------
-- Ownership and EXECUTE grants (default: nobody)
-- ---------------------------------------------------------------------------
do $own$
declare
  f text;
begin
  foreach f in array array['bnl.household_has_consent(text)', 'bnl.export_household(uuid)', 'bnl.process_deletion_request(uuid,integer)'] loop
    execute format('alter function %s owner to bnl_owner', f);
    execute format('revoke all on function %s from public', f);
  end loop;
end
$own$;

grant execute on function bnl.household_has_consent(text) to bnl_device;
grant execute on function bnl.export_household(uuid) to bnl_adult;
grant execute on function bnl.process_deletion_request(uuid, integer) to bnl_job;

-- Final sweep (every migration ends with this): nothing in bnl is reachable by PUBLIC/anon/authenticated.
revoke all on all tables in schema bnl from public, anon, authenticated;
revoke all on all sequences in schema bnl from public, anon, authenticated;
revoke all on all functions in schema bnl from public, anon, authenticated;
