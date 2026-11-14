-- BreakNLearn 0002: grants, SECURITY DEFINER access helpers, row-level security policies (ADR-0005).
--
-- Request roles (always entered with SET LOCAL ROLE by @bnl/db inside a transaction):
--   bnl_public  published catalog only (lessons/versions with a live publication, manifests)
--   bnl_device  one household + one non-revoked device (bnl.household_id, bnl.device_id)
--   bnl_adult   one auth user (bnl.actor_id); households via owner/guardian membership
--   bnl_staff   one auth user (bnl.actor_id); content per staff_roles; never child-level rows
--   bnl_job     scheduled jobs (aggregation, scoring, retention); server-only
--   bnl_owner   owns SECURITY DEFINER functions; never used by request code
-- anon/authenticated get nothing. Every table: ENABLE + FORCE ROW LEVEL SECURITY.

-- ---------------------------------------------------------------------------
-- Access helpers (SECURITY DEFINER, owned by bnl_owner, fixed search_path)
-- ---------------------------------------------------------------------------
create or replace function bnl.device_ok() returns boolean
language sql stable security definer set search_path = pg_catalog, pg_temp
as $$
  select exists (
    select 1 from bnl.paired_devices d
    where d.id = bnl.current_device_id()
      and d.household_id = bnl.current_household_id()
      and d.revoked_at is null)
$$;

create or replace function bnl.adult_household_ids() returns setof uuid
language sql stable security definer set search_path = pg_catalog, pg_temp
as $$
  select m.household_id from bnl.household_memberships m
  where m.auth_user_id = bnl.current_actor_id() and m.active and m.revoked_at is null
$$;

create or replace function bnl.adult_owner_household_ids() returns setof uuid
language sql stable security definer set search_path = pg_catalog, pg_temp
as $$
  select m.household_id from bnl.household_memberships m
  where m.auth_user_id = bnl.current_actor_id() and m.active and m.revoked_at is null and m.role = 'owner'
$$;

create or replace function bnl.has_staff_role(p_role text) returns boolean
language sql stable security definer set search_path = pg_catalog, pg_temp
as $$
  select exists (
    select 1 from bnl.staff_roles s
    where s.auth_user_id = bnl.current_actor_id() and s.role = p_role and s.revoked_at is null)
$$;

create or replace function bnl.is_staff() returns boolean
language sql stable security definer set search_path = pg_catalog, pg_temp
as $$
  select exists (
    select 1 from bnl.staff_roles s
    where s.auth_user_id = bnl.current_actor_id() and s.revoked_at is null)
$$;

create or replace function bnl.lesson_is_live(p_lesson_id uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, pg_temp
as $$
  select exists (select 1 from bnl.publication_records p where p.lesson_id = p_lesson_id and p.unpublished_at is null)
$$;

create or replace function bnl.version_is_live(p_version_id uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, pg_temp
as $$
  select exists (select 1 from bnl.publication_records p where p.lesson_version_id = p_version_id and p.unpublished_at is null)
$$;

-- Ever published: attempts and progress stay pinned to the version they started on (CAT-007).
create or replace function bnl.version_was_published(p_version_id uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, pg_temp
as $$
  select exists (select 1 from bnl.publication_records p where p.lesson_version_id = p_version_id)
$$;

create or replace function bnl.lesson_was_published(p_lesson_id uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, pg_temp
as $$
  select exists (select 1 from bnl.publication_records p where p.lesson_id = p_lesson_id)
$$;

create or replace function bnl.version_is_draft(p_version_id uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, pg_temp
as $$
  select exists (select 1 from bnl.lesson_versions v where v.id = p_version_id and v.status = 'draft')
$$;

do $owners$
declare
  f text;
begin
  foreach f in array array[
    'bnl.device_ok()', 'bnl.adult_household_ids()', 'bnl.adult_owner_household_ids()',
    'bnl.has_staff_role(text)', 'bnl.is_staff()', 'bnl.lesson_is_live(uuid)', 'bnl.version_is_live(uuid)',
    'bnl.version_was_published(uuid)', 'bnl.lesson_was_published(uuid)', 'bnl.version_is_draft(uuid)'
  ] loop
    execute format('alter function %s owner to bnl_owner', f);
  end loop;
end
$owners$;

-- ---------------------------------------------------------------------------
-- Baseline: revoke everything, enable + force RLS, give bnl_owner full access
-- ---------------------------------------------------------------------------
revoke all on all tables in schema bnl from public, anon, authenticated;
revoke all on all sequences in schema bnl from public, anon, authenticated;
revoke all on all functions in schema bnl from public, anon, authenticated;

grant usage on schema bnl to bnl_public, bnl_device, bnl_adult, bnl_staff, bnl_job, bnl_owner;
grant all on all tables in schema bnl to bnl_owner;
grant usage, select, update on all sequences in schema bnl to bnl_owner;

do $rls$
declare
  t record;
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'bnl' and c.relkind in ('r', 'p') loop
    execute format('alter table bnl.%I enable row level security', t.relname);
    execute format('alter table bnl.%I force row level security', t.relname);
    execute format('drop policy if exists owner_all on bnl.%I', t.relname);
    execute format('create policy owner_all on bnl.%I for all to bnl_owner using (true) with check (true)', t.relname);
    -- bnl_job sees rows of every table it is GRANTed on (grants below are the real limit).
    execute format('drop policy if exists job_all on bnl.%I', t.relname);
    execute format('create policy job_all on bnl.%I for all to bnl_job using (true) with check (true)', t.relname);
  end loop;
end
$rls$;

-- Context helpers are callable by every request role (they only read settings / evaluate policies).
grant execute on function bnl.setting_uuid(text), bnl.current_household_id(), bnl.current_device_id(),
  bnl.current_actor_id(), bnl.system_actor_id(), bnl.sha256_hex(text),
  bnl.device_ok(), bnl.adult_household_ids(), bnl.adult_owner_household_ids(), bnl.has_staff_role(text),
  bnl.is_staff(), bnl.lesson_is_live(uuid), bnl.version_is_live(uuid), bnl.version_was_published(uuid),
  bnl.lesson_was_published(uuid), bnl.version_is_draft(uuid)
  to bnl_public, bnl_device, bnl_adult, bnl_staff, bnl_job, bnl_owner;
grant execute on function bnl.uuid_v5(uuid, text) to bnl_owner, bnl_staff, bnl_job;

-- ---------------------------------------------------------------------------
-- Published catalog: grade_subjects, published_manifests, lessons, lesson_versions
-- ---------------------------------------------------------------------------
grant select on bnl.grade_subjects to bnl_public, bnl_device, bnl_adult, bnl_staff;
drop policy if exists read_all on bnl.grade_subjects;
create policy read_all on bnl.grade_subjects for select to bnl_public, bnl_device, bnl_adult, bnl_staff using (true);

grant select on bnl.published_manifests to bnl_public, bnl_device, bnl_adult, bnl_staff;
drop policy if exists read_all on bnl.published_manifests;
create policy read_all on bnl.published_manifests for select to bnl_public, bnl_device, bnl_adult, bnl_staff using (true);

-- Public/device/adult see only catalog columns (no authoring metadata).
grant select (id, stable_key, grade, subject_key, topic_id, title, template_key, sort_order, created_at, updated_at)
  on bnl.lessons to bnl_public, bnl_device, bnl_adult;
grant select (id, lesson_id, version_no, content, checksum, status, published_at, created_at)
  on bnl.lesson_versions to bnl_public, bnl_device, bnl_adult;

drop policy if exists public_live on bnl.lessons;
create policy public_live on bnl.lessons for select to bnl_public using (bnl.lesson_is_live(id));
drop policy if exists public_live on bnl.lesson_versions;
create policy public_live on bnl.lesson_versions for select to bnl_public using (bnl.version_is_live(id));

drop policy if exists device_published on bnl.lessons;
create policy device_published on bnl.lessons for select to bnl_device
  using (bnl.device_ok() and bnl.lesson_was_published(id));
drop policy if exists device_published on bnl.lesson_versions;
create policy device_published on bnl.lesson_versions for select to bnl_device
  using (bnl.device_ok() and bnl.version_was_published(id));

drop policy if exists adult_published on bnl.lessons;
create policy adult_published on bnl.lessons for select to bnl_adult using (bnl.lesson_was_published(id));
drop policy if exists adult_published on bnl.lesson_versions;
create policy adult_published on bnl.lesson_versions for select to bnl_adult using (bnl.version_was_published(id));

-- ---------------------------------------------------------------------------
-- Staff: content tables per staff role (ADR-0003). No grants on any child/household table.
-- ---------------------------------------------------------------------------
grant select, insert on bnl.lessons to bnl_staff;
-- stable_key, grade and subject_key are fixed after creation (catalog identity).
grant update (title, topic_id, sort_order) on bnl.lessons to bnl_staff;
drop policy if exists staff_read on bnl.lessons;
create policy staff_read on bnl.lessons for select to bnl_staff using (bnl.is_staff());
drop policy if exists editor_insert on bnl.lessons;
create policy editor_insert on bnl.lessons for insert to bnl_staff
  with check (bnl.has_staff_role('editor') and created_by = bnl.current_actor_id());
drop policy if exists editor_update on bnl.lessons;
create policy editor_update on bnl.lessons for update to bnl_staff
  using (bnl.has_staff_role('editor')) with check (bnl.has_staff_role('editor'));

grant select, insert, update, delete on bnl.lesson_versions to bnl_staff;
drop policy if exists staff_read on bnl.lesson_versions;
create policy staff_read on bnl.lesson_versions for select to bnl_staff using (bnl.is_staff());
drop policy if exists editor_insert on bnl.lesson_versions;
create policy editor_insert on bnl.lesson_versions for insert to bnl_staff
  with check (bnl.has_staff_role('editor') and status = 'draft' and created_by = bnl.current_actor_id()
              and submitted_by is null and reviewed_by is null and approved_at is null and published_at is null);
-- Editors edit drafts only and cannot change status; transitions go through bnl.transition_lesson_version.
drop policy if exists editor_update on bnl.lesson_versions;
create policy editor_update on bnl.lesson_versions for update to bnl_staff
  using (bnl.has_staff_role('editor') and status = 'draft')
  with check (bnl.has_staff_role('editor') and status = 'draft' and submitted_by is null
              and reviewed_by is null and approved_at is null and published_at is null);
drop policy if exists editor_delete on bnl.lesson_versions;
create policy editor_delete on bnl.lesson_versions for delete to bnl_staff
  using (bnl.has_staff_role('editor') and status = 'draft');

grant select, insert, update, delete on bnl.quiz_items to bnl_staff;
drop policy if exists staff_read on bnl.quiz_items;
create policy staff_read on bnl.quiz_items for select to bnl_staff
  using (bnl.has_staff_role('editor') or bnl.has_staff_role('reviewer') or bnl.has_staff_role('publisher'));
drop policy if exists editor_write on bnl.quiz_items;
create policy editor_write on bnl.quiz_items for all to bnl_staff
  using (bnl.has_staff_role('editor') and bnl.version_is_draft(lesson_version_id))
  with check (bnl.has_staff_role('editor') and bnl.version_is_draft(lesson_version_id));

grant select, insert, delete on bnl.lesson_outcomes to bnl_staff;
drop policy if exists staff_read on bnl.lesson_outcomes;
create policy staff_read on bnl.lesson_outcomes for select to bnl_staff using (bnl.is_staff());
drop policy if exists editor_write on bnl.lesson_outcomes;
create policy editor_write on bnl.lesson_outcomes for all to bnl_staff
  using (bnl.has_staff_role('editor')) with check (bnl.has_staff_role('editor'));

grant select, insert, update on bnl.media_assets to bnl_staff;
drop policy if exists staff_read on bnl.media_assets;
create policy staff_read on bnl.media_assets for select to bnl_staff using (bnl.is_staff());
drop policy if exists editor_insert on bnl.media_assets;
create policy editor_insert on bnl.media_assets for insert to bnl_staff
  with check (bnl.has_staff_role('editor') and uploaded_by = bnl.current_actor_id());
drop policy if exists editor_update on bnl.media_assets;
create policy editor_update on bnl.media_assets for update to bnl_staff
  using (bnl.has_staff_role('editor')) with check (bnl.has_staff_role('editor'));

grant select on bnl.publication_records to bnl_staff;
drop policy if exists staff_read on bnl.publication_records;
create policy staff_read on bnl.publication_records for select to bnl_staff using (bnl.is_staff());

-- Curriculum + sources: staff read; editors draft; reviewers verify. Adults read (for school mapping).
grant select, insert, update on bnl.source_documents, bnl.curriculum_frameworks, bnl.curriculum_nodes,
  bnl.learning_outcomes to bnl_staff;
grant select on bnl.curriculum_frameworks, bnl.curriculum_nodes, bnl.learning_outcomes to bnl_adult;
do $cur$
declare
  t text;
begin
  foreach t in array array['source_documents', 'curriculum_frameworks', 'curriculum_nodes', 'learning_outcomes'] loop
    execute format('drop policy if exists staff_read on bnl.%I', t);
    execute format('create policy staff_read on bnl.%I for select to bnl_staff using (bnl.is_staff())', t);
    execute format('drop policy if exists editor_insert on bnl.%I', t);
    execute format($p$create policy editor_insert on bnl.%I for insert to bnl_staff
      with check (bnl.has_staff_role('editor'))$p$, t);
    execute format('drop policy if exists content_update on bnl.%I', t);
    execute format($p$create policy content_update on bnl.%I for update to bnl_staff
      using (bnl.has_staff_role('editor') or bnl.has_staff_role('reviewer'))
      with check (bnl.has_staff_role('editor') or bnl.has_staff_role('reviewer'))$p$, t);
  end loop;
  foreach t in array array['curriculum_frameworks', 'curriculum_nodes', 'learning_outcomes'] loop
    execute format('drop policy if exists adult_read on bnl.%I', t);
    execute format('create policy adult_read on bnl.%I for select to bnl_adult using (true)', t);
  end loop;
end
$cur$;
-- Only reviewers may mark curriculum verified (CAT-006); editors may not self-verify.
create or replace function bnl.tg_curriculum_review_guard() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp
as $$
begin
  if current_user = 'bnl_staff' and new.review_status = 'verified'
     and (tg_op = 'INSERT' or old.review_status is distinct from 'verified')
     and not bnl.has_staff_role('reviewer') then
    raise exception 'bnl: only a reviewer can verify curriculum records' using errcode = '42501';
  end if;
  return new;
end
$$;
drop trigger if exists curriculum_review_guard on bnl.curriculum_nodes;
create trigger curriculum_review_guard before insert or update on bnl.curriculum_nodes
  for each row execute function bnl.tg_curriculum_review_guard();
drop trigger if exists curriculum_review_guard on bnl.learning_outcomes;
create trigger curriculum_review_guard before insert or update on bnl.learning_outcomes
  for each row execute function bnl.tg_curriculum_review_guard();

-- Analyst & content roles: metric definitions and run status only (no child rows).
grant select on bnl.metric_definitions, bnl.aggregation_runs, bnl.score_runs to bnl_staff;
grant select on bnl.metric_definitions to bnl_adult;
do $met$
declare
  t text;
begin
  foreach t in array array['metric_definitions', 'aggregation_runs', 'score_runs'] loop
    execute format('drop policy if exists staff_read on bnl.%I', t);
    execute format('create policy staff_read on bnl.%I for select to bnl_staff using (bnl.is_staff())', t);
  end loop;
end
$met$;
drop policy if exists adult_read on bnl.metric_definitions;
create policy adult_read on bnl.metric_definitions for select to bnl_adult using (true);

-- staff_roles: a user sees only their own roles (adult context needs it for /me).
grant select on bnl.staff_roles to bnl_staff, bnl_adult;
drop policy if exists own_roles on bnl.staff_roles;
create policy own_roles on bnl.staff_roles for select to bnl_staff, bnl_adult
  using (auth_user_id = bnl.current_actor_id());

-- ---------------------------------------------------------------------------
-- Households and memberships (adult)
-- ---------------------------------------------------------------------------
grant select (id, label, timezone, created_at, updated_at) on bnl.households to bnl_adult, bnl_device;
grant update (label, timezone) on bnl.households to bnl_adult;
drop policy if exists adult_read on bnl.households;
create policy adult_read on bnl.households for select to bnl_adult using (id in (select bnl.adult_household_ids()));
drop policy if exists owner_update on bnl.households;
create policy owner_update on bnl.households for update to bnl_adult
  using (id in (select bnl.adult_owner_household_ids())) with check (id in (select bnl.adult_owner_household_ids()));
drop policy if exists device_read on bnl.households;
create policy device_read on bnl.households for select to bnl_device
  using (id = bnl.current_household_id() and bnl.device_ok());

grant select on bnl.household_memberships to bnl_adult;
grant insert (household_id, auth_user_id, role, invited_by) on bnl.household_memberships to bnl_adult;
grant update (role, revoked_at) on bnl.household_memberships to bnl_adult;
drop policy if exists adult_read on bnl.household_memberships;
create policy adult_read on bnl.household_memberships for select to bnl_adult
  using (household_id in (select bnl.adult_household_ids()));
drop policy if exists owner_insert on bnl.household_memberships;
create policy owner_insert on bnl.household_memberships for insert to bnl_adult
  with check (household_id in (select bnl.adult_owner_household_ids()) and invited_by = bnl.current_actor_id());
drop policy if exists owner_update on bnl.household_memberships;
create policy owner_update on bnl.household_memberships for update to bnl_adult
  using (household_id in (select bnl.adult_owner_household_ids()) and auth_user_id <> bnl.current_actor_id())
  with check (household_id in (select bnl.adult_owner_household_ids()));

-- ---------------------------------------------------------------------------
-- Learner profiles (device + adult)
-- ---------------------------------------------------------------------------
grant select, insert, update on bnl.learner_profiles to bnl_device;
grant select, insert, update, delete on bnl.learner_profiles to bnl_adult;
drop policy if exists device_rw on bnl.learner_profiles;
create policy device_rw on bnl.learner_profiles for all to bnl_device
  using (household_id = bnl.current_household_id() and bnl.device_ok())
  with check (household_id = bnl.current_household_id() and bnl.device_ok());
drop policy if exists adult_rw on bnl.learner_profiles;
create policy adult_rw on bnl.learner_profiles for all to bnl_adult
  using (household_id in (select bnl.adult_household_ids()))
  with check (household_id in (select bnl.adult_household_ids()));

-- ---------------------------------------------------------------------------
-- Devices (adult manages; tokens never readable). Pairing codes: functions only.
-- ---------------------------------------------------------------------------
grant select (id, household_id, label, token_version, approved_by, paired_at, last_seen_at, revoked_at, created_at, updated_at)
  on bnl.paired_devices to bnl_adult;
grant update (label) on bnl.paired_devices to bnl_adult;
-- A2 approve-pairing flow (bnl_adult) creates the device row for one of the adult's households.
grant insert (id, household_id, label, token_version, approved_by, paired_at) on bnl.paired_devices to bnl_adult;
drop policy if exists adult_insert on bnl.paired_devices;
create policy adult_insert on bnl.paired_devices for insert to bnl_adult
  with check (household_id in (select bnl.adult_household_ids()) and revoked_at is null);
-- Every device request reads its own row (token_version / revoked_at check, even when revoked) and bumps
-- last_seen_at; the refresh flow (bnl_device) rotates or revokes its own credential.
grant select on bnl.paired_devices to bnl_device;
grant update (refresh_token_hash, refresh_rotated_at, revoked_at, token_version, last_seen_at) on bnl.paired_devices to bnl_device;
drop policy if exists device_own_read on bnl.paired_devices;
create policy device_own_read on bnl.paired_devices for select to bnl_device
  using (id = bnl.current_device_id() and household_id = bnl.current_household_id());
drop policy if exists device_own_update on bnl.paired_devices;
create policy device_own_update on bnl.paired_devices for update to bnl_device
  using (id = bnl.current_device_id() and household_id = bnl.current_household_id() and revoked_at is null)
  with check (id = bnl.current_device_id() and household_id = bnl.current_household_id());
-- A2 redeem flow (bnl_job) installs the first refresh-token hash.
grant select, update (refresh_token_hash, refresh_rotated_at, last_seen_at) on bnl.paired_devices to bnl_job;

-- Pairing codes. Approve (bnl_adult): see unclaimed, unexpired codes and claim them for an own household.
grant select on bnl.device_pairing_codes to bnl_adult;
grant update (household_id, approved_by, approved_at, device_id) on bnl.device_pairing_codes to bnl_adult;
drop policy if exists adult_claim_read on bnl.device_pairing_codes;
create policy adult_claim_read on bnl.device_pairing_codes for select to bnl_adult
  using ((household_id is null and expires_at > now() and redeemed_at is null)
         or household_id in (select bnl.adult_household_ids()));
drop policy if exists adult_claim on bnl.device_pairing_codes;
create policy adult_claim on bnl.device_pairing_codes for update to bnl_adult
  using (household_id is null and expires_at > now() and redeemed_at is null)
  with check (household_id in (select bnl.adult_household_ids()) and approved_by = bnl.current_actor_id());
-- Create + redeem (bnl_job, server-only, pre-auth endpoints).
grant select, insert, update, delete on bnl.device_pairing_codes to bnl_job;
drop policy if exists adult_read on bnl.paired_devices;
create policy adult_read on bnl.paired_devices for select to bnl_adult
  using (household_id in (select bnl.adult_household_ids()));
drop policy if exists adult_update on bnl.paired_devices;
create policy adult_update on bnl.paired_devices for update to bnl_adult
  using (household_id in (select bnl.adult_household_ids()))
  with check (household_id in (select bnl.adult_household_ids()));

-- ---------------------------------------------------------------------------
-- Consent (adult)
-- ---------------------------------------------------------------------------
grant select on bnl.consent_records to bnl_adult;
grant insert (household_id, guardian_auth_user_id, consent_version, scope) on bnl.consent_records to bnl_adult;
grant update (revoked_at) on bnl.consent_records to bnl_adult;
drop policy if exists adult_read on bnl.consent_records;
create policy adult_read on bnl.consent_records for select to bnl_adult
  using (household_id in (select bnl.adult_household_ids()));
drop policy if exists adult_insert on bnl.consent_records;
create policy adult_insert on bnl.consent_records for insert to bnl_adult
  with check (household_id in (select bnl.adult_household_ids()) and guardian_auth_user_id = bnl.current_actor_id());
drop policy if exists adult_revoke on bnl.consent_records;
create policy adult_revoke on bnl.consent_records for update to bnl_adult
  using (household_id in (select bnl.adult_household_ids()) and guardian_auth_user_id = bnl.current_actor_id())
  with check (household_id in (select bnl.adult_household_ids()));

-- ---------------------------------------------------------------------------
-- School plans & uploads (adult only; job processes imports)
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on bnl.school_plans, bnl.syllabus_uploads, bnl.syllabus_chapters,
  bnl.chapter_topic_mappings, bnl.import_jobs to bnl_adult;
do $school$
declare
  t text;
begin
  foreach t in array array['school_plans', 'syllabus_uploads', 'syllabus_chapters', 'chapter_topic_mappings', 'import_jobs'] loop
    execute format('drop policy if exists adult_rw on bnl.%I', t);
    execute format($p$create policy adult_rw on bnl.%I for all to bnl_adult
      using (household_id in (select bnl.adult_household_ids()))
      with check (household_id in (select bnl.adult_household_ids()))$p$, t);
  end loop;
end
$school$;

-- ---------------------------------------------------------------------------
-- Learning data: device writes own household (non-revoked); adult reads own households
-- ---------------------------------------------------------------------------
grant select, insert, update on bnl.learner_progress, bnl.learning_sessions, bnl.assessment_attempts,
  bnl.review_schedule, bnl.migration_runs to bnl_device;
grant select, insert on bnl.learning_events, bnl.migration_aliases to bnl_device;
grant select on bnl.question_responses, bnl.recommendations to bnl_device;

do $learn$
declare
  t text;
begin
  -- Plain household scoping.
  foreach t in array array['learner_progress', 'review_schedule', 'question_responses', 'recommendations'] loop
    execute format('drop policy if exists device_rw on bnl.%I', t);
    execute format($p$create policy device_rw on bnl.%I for all to bnl_device
      using (household_id = bnl.current_household_id() and bnl.device_ok())
      with check (household_id = bnl.current_household_id() and bnl.device_ok())$p$, t);
  end loop;
  -- Rows carrying device_id: writes must come from the current device.
  foreach t in array array['learning_sessions', 'learning_events', 'assessment_attempts', 'migration_runs', 'migration_aliases'] loop
    execute format('drop policy if exists device_rw on bnl.%I', t);
    execute format($p$create policy device_rw on bnl.%I for all to bnl_device
      using (household_id = bnl.current_household_id() and bnl.device_ok())
      with check (household_id = bnl.current_household_id() and bnl.device_ok()
                  and device_id = bnl.current_device_id())$p$, t);
  end loop;
  foreach t in array array['learner_progress', 'learning_sessions', 'learning_events', 'assessment_attempts',
                           'question_responses', 'review_schedule', 'mastery_snapshots', 'recommendations',
                           'migration_runs', 'migration_aliases', 'data_deletion_requests'] loop
    execute format('grant select on bnl.%I to bnl_adult', t);
    execute format('drop policy if exists adult_read on bnl.%I', t);
    execute format($p$create policy adult_read on bnl.%I for select to bnl_adult
      using (household_id in (select bnl.adult_household_ids()))$p$, t);
  end loop;
end
$learn$;
-- Attempts must be pinned to a published version.
drop policy if exists device_published_version on bnl.assessment_attempts;
create policy device_published_version on bnl.assessment_attempts as restrictive for insert to bnl_device
  with check (bnl.version_was_published(lesson_version_id));

-- Device progress/telemetry may only reference lessons that are (or were) published.
drop policy if exists device_published_lesson on bnl.learner_progress;
create policy device_published_lesson on bnl.learner_progress as restrictive for insert to bnl_device
  with check (bnl.lesson_was_published(lesson_id)
              and (lesson_version_id is null or bnl.version_was_published(lesson_version_id)));
drop policy if exists device_published_lesson on bnl.learning_events;
create policy device_published_lesson on bnl.learning_events as restrictive for insert to bnl_device
  with check ((lesson_id is null or bnl.lesson_was_published(lesson_id))
              and (lesson_version_id is null or bnl.version_was_published(lesson_version_id)));

grant update (dismissed_at) on bnl.recommendations to bnl_adult;
drop policy if exists adult_dismiss on bnl.recommendations;
create policy adult_dismiss on bnl.recommendations for update to bnl_adult
  using (household_id in (select bnl.adult_household_ids()))
  with check (household_id in (select bnl.adult_household_ids()));

grant insert (household_id, requested_by, scope, learner_id) on bnl.data_deletion_requests to bnl_adult;
drop policy if exists adult_request on bnl.data_deletion_requests;
create policy adult_request on bnl.data_deletion_requests for insert to bnl_adult
  with check (household_id in (select bnl.adult_owner_household_ids()) and requested_by = bnl.current_actor_id());

-- ---------------------------------------------------------------------------
-- Audit logs (append-only)
-- ---------------------------------------------------------------------------
grant insert on bnl.audit_logs to bnl_device, bnl_adult, bnl_staff, bnl_job;
grant select on bnl.audit_logs to bnl_adult, bnl_staff;
-- actor_type is set by trigger from the request role. A device may audit itself even right after it
-- revoked itself (refresh-token reuse), so device_ok() is not required here.
drop policy if exists device_insert on bnl.audit_logs;
create policy device_insert on bnl.audit_logs for insert to bnl_device
  with check (household_id = bnl.current_household_id()
              and (actor_auth_id is null or actor_auth_id = bnl.current_device_id()));
drop policy if exists adult_insert on bnl.audit_logs;
create policy adult_insert on bnl.audit_logs for insert to bnl_adult
  with check ((actor_auth_id is null or actor_auth_id = bnl.current_actor_id())
              and household_id in (select bnl.adult_household_ids()));
drop policy if exists adult_read on bnl.audit_logs;
create policy adult_read on bnl.audit_logs for select to bnl_adult
  using (household_id in (select bnl.adult_household_ids()));
drop policy if exists staff_insert on bnl.audit_logs;
create policy staff_insert on bnl.audit_logs for insert to bnl_staff
  with check ((actor_auth_id is null or actor_auth_id = bnl.current_actor_id()) and household_id is null and bnl.is_staff());
drop policy if exists staff_read on bnl.audit_logs;
create policy staff_read on bnl.audit_logs for select to bnl_staff using (household_id is null and bnl.is_staff());

-- ---------------------------------------------------------------------------
-- Idempotency keys (scoped to the calling device or user)
-- ---------------------------------------------------------------------------
grant select, insert, update on bnl.idempotency_keys to bnl_device, bnl_adult, bnl_staff;
drop policy if exists device_own on bnl.idempotency_keys;
create policy device_own on bnl.idempotency_keys for all to bnl_device
  using (actor_or_device = bnl.current_device_id() and household_id = bnl.current_household_id() and bnl.device_ok())
  with check (actor_or_device = bnl.current_device_id() and household_id = bnl.current_household_id() and bnl.device_ok());
drop policy if exists actor_own on bnl.idempotency_keys;
create policy actor_own on bnl.idempotency_keys for all to bnl_adult, bnl_staff
  using (actor_or_device = bnl.current_actor_id())
  with check (actor_or_device = bnl.current_actor_id()
              and (household_id is null or household_id in (select bnl.adult_household_ids())));

-- ---------------------------------------------------------------------------
-- Jobs: aggregation, scoring, retention, import processing (server-only role)
-- ---------------------------------------------------------------------------
grant select on bnl.households, bnl.learner_profiles, bnl.learning_sessions, bnl.learning_events,
  bnl.learner_progress, bnl.assessment_attempts, bnl.question_responses, bnl.lessons, bnl.lesson_versions,
  bnl.curriculum_nodes, bnl.learning_outcomes, bnl.lesson_outcomes, bnl.publication_records, bnl.consent_records
  to bnl_job;
grant select, insert, update, delete on bnl.mastery_snapshots, bnl.recommendations, bnl.score_runs,
  bnl.metric_definitions, bnl.aggregation_runs, bnl.job_runs, bnl.review_schedule to bnl_job;
grant update (foreground_estimated_ms, playback_ms, interaction_count, ended_at) on bnl.learning_sessions to bnl_job;
grant update (quality_flag, session_id) on bnl.learning_events to bnl_job;
grant delete on bnl.learning_events, bnl.idempotency_keys to bnl_job;
grant select on bnl.idempotency_keys to bnl_job;
-- A2 rate limiting (bnl_job): INSERT ... ON CONFLICT (key, window_start) DO UPDATE.
grant select, insert, update, delete on bnl.rate_limit_buckets to bnl_job;
grant select, update on bnl.data_deletion_requests, bnl.import_jobs, bnl.syllabus_uploads to bnl_job;
grant select, insert, update on bnl.syllabus_chapters, bnl.chapter_topic_mappings to bnl_job;
grant select on bnl.school_plans to bnl_job;
grant select on bnl.audit_logs to bnl_job;
drop policy if exists job_insert on bnl.audit_logs;
create policy job_insert on bnl.audit_logs for insert to bnl_job with check (actor_type = 'job');

-- Job policy on audit_logs must be insert-only + read; drop the generic one there.
drop policy if exists job_all on bnl.audit_logs;
drop policy if exists job_read on bnl.audit_logs;
create policy job_read on bnl.audit_logs for select to bnl_job using (true);

-- Final sweep (every migration ends with this): nothing in bnl is reachable by PUBLIC/anon/authenticated.
revoke all on all tables in schema bnl from public, anon, authenticated;
revoke all on all sequences in schema bnl from public, anon, authenticated;
revoke all on all functions in schema bnl from public, anon, authenticated;
