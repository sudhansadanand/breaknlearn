-- BreakNLearn 0001: schema `bnl`, roles, tables, constraints, indexes, row triggers.
-- Implements spec §5 with the binding deltas of ADR-0005 (roles per ADR-0003, lesson identity per ADR-0004).
-- Plain PostgreSQL (15+; tested on 16). No dependency on Supabase's auth schema: auth user ids are plain uuids.
-- Grants and RLS policies live in 0002_rls.sql; workflow/publish/scoring functions in 0003_functions.sql.
-- Idempotent at cluster level (roles are guarded) so it can be applied to several fresh databases in one cluster.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Roles (cluster-wide, so every CREATE is guarded)
-- ---------------------------------------------------------------------------
do $roles$
declare
  r text;
begin
  -- Supabase API roles: created on stock Postgres so REVOKEs and SEC-005 tests are meaningful.
  foreach r in array array['anon', 'authenticated'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin', r);
    end if;
  end loop;
  -- Request-scoped roles (SET LOCAL ROLE from @bnl/db) plus the owner of SECURITY DEFINER functions.
  foreach r in array array['bnl_public', 'bnl_device', 'bnl_adult', 'bnl_staff', 'bnl_job', 'bnl_owner'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin noinherit', r);
    end if;
  end loop;
  -- The only LOGIN role used by the server. NOINHERIT: it holds no privileges of its own and must
  -- SET ROLE to one of the request roles. No password here; local dev/test scripts set one.
  if not exists (select 1 from pg_roles where rolname = 'bnl_app') then
    create role bnl_app login noinherit;
  end if;
end
$roles$;

grant bnl_public, bnl_device, bnl_adult, bnl_staff, bnl_job to bnl_app;
-- The migrating role must be able to hand ownership of SECURITY DEFINER functions to bnl_owner, which needs
-- SET ROLE on it. On PostgreSQL 16+ a non-superuser CREATEROLE login (Supabase's `postgres`) is automatically
-- granted ADMIN on the roles it creates but with SET and INHERIT off, so a membership row alone is not enough:
-- require SET (to hand over ownership) and INHERIT (later migrations CREATE OR REPLACE functions bnl_owner owns).
do $own$
begin
  if not exists (
    select 1 from pg_auth_members m
    join pg_roles g on g.oid = m.roleid
    join pg_roles u on u.oid = m.member
    where g.rolname = 'bnl_owner' and u.rolname = current_user and m.set_option and m.inherit_option
  ) and not (select rolsuper from pg_roles where rolname = current_user) then
    execute format('grant bnl_owner to %I with set true, inherit true', current_user);
  end if;
end
$own$;

create schema if not exists bnl;
revoke all on schema bnl from public;
revoke all on schema bnl from anon, authenticated;
-- ALTER ... OWNER TO bnl_owner (SECURITY DEFINER functions) requires the new owner to hold CREATE on the schema
-- unless the migrating login is a superuser (it is not on Supabase). bnl_owner is NOLOGIN and not granted to bnl_app.
grant usage, create on schema bnl to bnl_owner;
-- Note: schema-level default privileges can only ADD to the global defaults (functions are EXECUTE-able by
-- PUBLIC by default), so every migration ends with an explicit REVOKE sweep instead (see supabase/README.md).

-- ---------------------------------------------------------------------------
-- Request context helpers (invoker; read transaction-local settings set by @bnl/db)
-- ---------------------------------------------------------------------------
create or replace function bnl.setting_uuid(p_name text) returns uuid
language sql stable set search_path = pg_catalog, pg_temp
as $$ select nullif(current_setting(p_name, true), '')::uuid $$;

create or replace function bnl.current_household_id() returns uuid
language sql stable set search_path = pg_catalog, pg_temp
as $$ select bnl.setting_uuid('bnl.household_id') $$;

create or replace function bnl.current_device_id() returns uuid
language sql stable set search_path = pg_catalog, pg_temp
as $$ select bnl.setting_uuid('bnl.device_id') $$;

create or replace function bnl.current_actor_id() returns uuid
language sql stable set search_path = pg_catalog, pg_temp
as $$ select bnl.setting_uuid('bnl.actor_id') $$;

-- Fixed id of the non-login 'system' actor (seeds, owner-run operations). Usable only from an
-- operations session (see bnl._is_ops_session in 0003), never through bnl_app.
create or replace function bnl.system_actor_id() returns uuid
language sql immutable set search_path = pg_catalog, pg_temp
as $$ select '00000000-0000-0000-0000-00000000005e'::uuid $$;

-- RFC 4122 UUIDv5 (sha1 via pgcrypto); used by seeds to reproduce the fixed ids in @bnl/contracts.
-- pgcrypto lives in `public` on stock Postgres and in `extensions` on Supabase, so the schema is resolved here.
do $uuid5$
declare
  ext_schema text;
begin
  select n.nspname into ext_schema from pg_extension e join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'pgcrypto';
  execute format($f$
    create or replace function bnl.uuid_v5(p_namespace uuid, p_name text) returns uuid
    language plpgsql immutable strict set search_path = pg_catalog, pg_temp
    as $body$
    declare
      h bytea;
    begin
      h := substring(%I.digest(decode(replace(p_namespace::text, '-', ''), 'hex') || convert_to(p_name, 'UTF8'), 'sha1')
                     from 1 for 16);
      h := set_byte(h, 6, (get_byte(h, 6) & 15) | 80);   -- version 5
      h := set_byte(h, 8, (get_byte(h, 8) & 63) | 128);  -- RFC 4122 variant
      return encode(h, 'hex')::uuid;
    end
    $body$$f$, ext_schema);
end
$uuid5$;

create or replace function bnl.sha256_hex(p_text text) returns text
language sql immutable strict set search_path = pg_catalog, pg_temp
as $$ select encode(sha256(convert_to(p_text, 'UTF8')), 'hex') $$;

-- Generic updated_at maintenance.
create or replace function bnl.tg_set_updated_at() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- Reference data that is part of the frozen contract (GRADE_SUBJECTS in @bnl/contracts/catalog.ts)
-- ---------------------------------------------------------------------------
create table if not exists bnl.grade_subjects (
  grade smallint not null check (grade in (2, 6)),
  subject_key text not null check (subject_key in ('english','math','tamil','hindi','science','aadritha','music',
    'physics','chemistry','biology','history_civics','geography','western_violin','carnatic_violin')),
  label text not null,
  icon text not null,
  authority text not null check (authority in ('cisce', 'local_enrichment')),
  sort_order smallint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (grade, subject_key),
  unique (grade, sort_order)
);

insert into bnl.grade_subjects (grade, subject_key, label, icon, authority, sort_order) values
  (2, 'english', 'English', '📖', 'cisce', 1),
  (2, 'math', 'Math', '🔢', 'cisce', 2),
  (2, 'tamil', 'Tamil', '🔤', 'cisce', 3),
  (2, 'hindi', 'Hindi', '🪷', 'cisce', 4),
  (2, 'science', 'Science', '🔬', 'cisce', 5),
  (2, 'aadritha', 'Aadritha', '🪔', 'local_enrichment', 6),
  (2, 'music', 'Music', '🎵', 'local_enrichment', 7),
  (6, 'english', 'English', '📖', 'cisce', 1),
  (6, 'math', 'Math', '🔢', 'cisce', 2),
  (6, 'tamil', 'Tamil', '🔤', 'cisce', 3),
  (6, 'hindi', 'Hindi', '🪷', 'cisce', 4),
  (6, 'physics', 'Physics', '🪐', 'cisce', 5),
  (6, 'chemistry', 'Chemistry', '⚗️', 'cisce', 6),
  (6, 'biology', 'Biology', '🧬', 'cisce', 7),
  (6, 'history_civics', 'History & Civics', '🏛️', 'cisce', 8),
  (6, 'geography', 'Geography', '🌎', 'cisce', 9),
  (6, 'western_violin', 'Western Violin', '🎻', 'local_enrichment', 10),
  (6, 'carnatic_violin', 'Carnatic Violin', '🎼', 'local_enrichment', 11),
  (6, 'aadritha', 'Aadritha', '🪔', 'local_enrichment', 12)
on conflict (grade, subject_key) do nothing;

-- ---------------------------------------------------------------------------
-- Access: households, roles, learners, devices, pairing, consent, legacy migration
-- ---------------------------------------------------------------------------
create table if not exists bnl.households (
  id uuid primary key default gen_random_uuid(),
  label text check (label is null or char_length(label) <= 60),
  timezone text not null default 'Asia/Kolkata',
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function bnl.tg_households_timezone() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp
as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception 'bnl: unknown timezone %', new.timezone using errcode = '22023';
  end if;
  return new;
end
$$;
drop trigger if exists households_timezone on bnl.households;
create trigger households_timezone before insert or update of timezone on bnl.households
  for each row execute function bnl.tg_households_timezone();

-- Household roles only (ADR-0003). Content roles live in staff_roles.
create table if not exists bnl.household_memberships (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references bnl.households(id) on delete cascade,
  auth_user_id uuid not null,
  role text not null check (role in ('owner', 'guardian')),
  active boolean not null default true,  -- A2 contract; access also requires revoked_at is null
  invited_by uuid,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, auth_user_id)
);
create index if not exists idx_memberships_user on bnl.household_memberships(auth_user_id) where revoked_at is null;

-- Global content roles; grant NO household data access.
create table if not exists bnl.staff_roles (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null,
  role text not null check (role in ('editor', 'reviewer', 'publisher', 'analyst')),
  granted_by uuid,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists uq_staff_roles_active on bnl.staff_roles(auth_user_id, role) where revoked_at is null;

create table if not exists bnl.learner_profiles (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references bnl.households(id) on delete cascade,
  slot smallint not null check (slot in (1, 2)),
  display_name text not null check (
    char_length(btrim(display_name)) between 1 and 30
    and display_name !~ '[<>[:cntrl:]]'),
  grade smallint not null check (grade in (2, 6)),
  avatar_id text not null check (avatar_id in ('fox','dragon','unicorn','rocket','panda','lion',
    'robot','superhero','tiger','astronaut','butterfly','penguin')),
  preferences jsonb not null default '{"music_enabled": true, "last_theme_key": null, "last_table": null}'::jsonb
    check (jsonb_typeof(preferences) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint learner_profiles_household_slot_key unique (household_id, slot),
  unique (id, household_id)
);

create table if not exists bnl.paired_devices (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references bnl.households(id) on delete cascade,
  label text not null check (char_length(btrim(label)) between 1 and 40),
  token_version integer not null default 1 check (token_version > 0),
  refresh_token_hash text unique check (refresh_token_hash ~ '^[a-f0-9]{64}$'),
  refresh_rotated_at timestamptz,
  approved_by uuid,
  paired_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, household_id)
);
create index if not exists idx_devices_household on bnl.paired_devices(household_id);

-- TV pairing bootstrap (ADR-0002 P1). Codes and poll secrets are stored only as sha256 hex.
create table if not exists bnl.device_pairing_codes (
  id uuid primary key default gen_random_uuid(),
  pairing_id uuid not null unique,
  code_hash text not null unique check (code_hash ~ '^[a-f0-9]{64}$'),
  poll_secret_hash text not null check (poll_secret_hash ~ '^[a-f0-9]{64}$'),
  household_id uuid references bnl.households(id) on delete cascade,  -- null until approved
  approved_by uuid,
  approved_at timestamptz,
  device_id uuid references bnl.paired_devices(id) on delete cascade,
  redeemed_at timestamptz,
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((approved_at is null) = (household_id is null)),
  check ((approved_at is null) = (device_id is null)),
  check (redeemed_at is null or approved_at is not null)
);
create index if not exists idx_pairing_codes_expiry on bnl.device_pairing_codes(expires_at);

create table if not exists bnl.consent_records (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references bnl.households(id) on delete cascade,
  guardian_auth_user_id uuid not null,
  consent_version text not null check (char_length(consent_version) between 1 and 40),
  scope text not null default 'learning_data' check (scope in ('learning_data', 'telemetry', 'school_uploads')),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_consent_household on bnl.consent_records(household_id, granted_at desc);

-- Legacy localStorage import (ADR-0002 L1/L2, spec §10). Idempotent by migration_run_id + fingerprint.
create table if not exists bnl.migration_runs (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references bnl.households(id) on delete cascade,
  device_id uuid not null,
  migration_run_id uuid not null,
  legacy_fingerprint text not null check (legacy_fingerprint ~ '^[a-f0-9]{64}$'),
  status text not null default 'imported' check (status in ('imported', 'failed')),
  receipt jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, migration_run_id, legacy_fingerprint),
  unique (id, household_id),
  foreign key (device_id, household_id) references bnl.paired_devices(id, household_id)
);

create table if not exists bnl.migration_aliases (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references bnl.households(id) on delete cascade,
  device_id uuid not null,
  local_profile_id text not null check (char_length(local_profile_id) between 1 and 40),
  learner_id uuid not null,
  migration_run_id uuid not null,  -- references migration_runs.id (server id of the run)
  legacy_fingerprint text not null check (legacy_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (device_id, local_profile_id),
  foreign key (device_id, household_id) references bnl.paired_devices(id, household_id),
  foreign key (learner_id, household_id) references bnl.learner_profiles(id, household_id) on delete cascade,
  foreign key (migration_run_id, household_id) references bnl.migration_runs(id, household_id)
);

-- ---------------------------------------------------------------------------
-- Curriculum & provenance (M02)
-- ---------------------------------------------------------------------------
create table if not exists bnl.source_documents (
  id uuid primary key default gen_random_uuid(),
  source_type text not null check (source_type in ('official_pdf', 'textbook', 'editorial', 'school_document', 'other')),
  url text,
  storage_key text,
  title text not null,
  version_label text,
  document_checksum text,
  verified_by uuid,
  verified_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists bnl.curriculum_frameworks (
  id uuid primary key default gen_random_uuid(),
  board text not null,
  level text not null,
  version_label text not null,
  source_document_id uuid references bnl.source_documents(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (board, level, version_label)
);

create table if not exists bnl.curriculum_nodes (
  id uuid primary key default gen_random_uuid(),
  framework_id uuid references bnl.curriculum_frameworks(id),
  stable_key text not null unique check (stable_key ~ '^[a-z0-9]+(\.[a-z0-9_-]+)*$'),
  parent_id uuid references bnl.curriculum_nodes(id),
  grade smallint not null check (grade in (2, 6)),
  subject_key text not null,
  node_type text not null check (node_type in ('subject', 'strand', 'topic', 'subtopic')),
  title text not null check (char_length(title) between 1 and 200),
  authority text not null default 'editorial_unverified'
    check (authority in ('editorial_unverified', 'cisce_verified', 'school_specific', 'local_enrichment')),
  review_status text not null default 'draft' check (review_status in ('draft', 'in_review', 'verified', 'archived')),
  source_document_id uuid references bnl.source_documents(id),
  source_ref text check (source_ref is null or char_length(source_ref) <= 200),
  provenance jsonb not null default '{}'::jsonb,
  sort_order integer not null default 0,
  created_by uuid,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (grade, subject_key) references bnl.grade_subjects(grade, subject_key),
  -- CAT-006: CISCE verification requires a cited source document + page/section.
  check (authority <> 'cisce_verified' or (source_document_id is not null and source_ref is not null))
);
create index if not exists idx_nodes_framework_ref on bnl.curriculum_nodes(framework_id, source_ref);
create index if not exists idx_nodes_parent on bnl.curriculum_nodes(parent_id, sort_order);
create index if not exists idx_nodes_grade_subject on bnl.curriculum_nodes(grade, subject_key, sort_order);

create table if not exists bnl.learning_outcomes (
  id uuid primary key default gen_random_uuid(),
  curriculum_node_id uuid not null references bnl.curriculum_nodes(id),
  stable_key text not null unique,
  statement text not null,
  authority text not null default 'editorial_unverified'
    check (authority in ('editorial_unverified', 'cisce_verified', 'school_specific', 'local_enrichment')),
  review_status text not null default 'draft' check (review_status in ('draft', 'in_review', 'verified', 'archived')),
  source_ref text,
  verified_by uuid,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- School syllabus ingestion (M03) — household-private
-- ---------------------------------------------------------------------------
create table if not exists bnl.school_plans (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references bnl.households(id) on delete cascade,
  grade smallint not null check (grade in (2, 6)),
  subject_key text not null,
  academic_year text not null check (academic_year ~ '^[0-9]{4}(-[0-9]{2,4})?$'),
  school_label text,
  textbook_title text,
  textbook_edition text,
  created_by uuid,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, household_id),
  foreign key (grade, subject_key) references bnl.grade_subjects(grade, subject_key)
);

create table if not exists bnl.syllabus_uploads (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references bnl.households(id) on delete cascade,
  school_plan_id uuid not null,
  object_key text not null unique,  -- storage path, must start with '<household_id>/'
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  original_filename text,           -- private; never exposed in catalog or logs
  mime_type text not null check (mime_type in ('application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/csv', 'text/plain')),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 20 * 1024 * 1024),
  status text not null default 'uploaded' check (status in ('uploaded', 'extracting', 'review', 'failed', 'approved')),
  uploaded_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, household_id),
  foreign key (school_plan_id, household_id) references bnl.school_plans(id, household_id) on delete cascade,
  check (object_key like household_id::text || '/%')
);

create table if not exists bnl.import_jobs (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references bnl.households(id) on delete cascade,
  school_plan_id uuid not null,
  upload_id uuid,
  job_type text not null check (job_type in ('pdf_text', 'docx', 'csv', 'manual_toc', 'ocr')),
  input_sha256 text check (input_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'queued' check (status in ('queued', 'extracting', 'review', 'failed', 'approved')),
  errors jsonb not null default '[]'::jsonb check (jsonb_typeof(errors) = 'array'),
  created_by uuid,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (school_plan_id, household_id) references bnl.school_plans(id, household_id) on delete cascade,
  foreign key (upload_id, household_id) references bnl.syllabus_uploads(id, household_id) on delete cascade
);
create index if not exists idx_import_jobs_plan on bnl.import_jobs(household_id, school_plan_id, created_at desc);

create table if not exists bnl.syllabus_chapters (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references bnl.households(id) on delete cascade,
  school_plan_id uuid not null,
  upload_id uuid,
  chapter_number text,
  title text not null check (char_length(title) between 1 and 300),
  page_start integer check (page_start is null or page_start > 0),
  source_page integer,
  sort_order integer not null,
  extraction_confidence numeric(4, 3) check (extraction_confidence between 0 and 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, household_id),
  foreign key (school_plan_id, household_id) references bnl.school_plans(id, household_id) on delete cascade,
  foreign key (upload_id, household_id) references bnl.syllabus_uploads(id, household_id) on delete cascade
);
create index if not exists idx_chapters_plan_sort on bnl.syllabus_chapters(school_plan_id, sort_order);

create table if not exists bnl.chapter_topic_mappings (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references bnl.households(id) on delete cascade,
  chapter_id uuid not null,
  curriculum_node_id uuid not null references bnl.curriculum_nodes(id),
  state text not null default 'suggested' check (state in ('suggested', 'approved', 'rejected')),
  confidence numeric(4, 3) check (confidence between 0 and 1),
  reviewer_auth_id uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (chapter_id, curriculum_node_id),
  foreign key (chapter_id, household_id) references bnl.syllabus_chapters(id, household_id) on delete cascade,
  check (state = 'suggested' or (reviewer_auth_id is not null and reviewed_at is not null))
);

-- ---------------------------------------------------------------------------
-- Lessons, versions, items, media, publication (M04/M05)
-- ---------------------------------------------------------------------------
create table if not exists bnl.lessons (
  id uuid primary key default gen_random_uuid(),
  stable_key text not null unique check (stable_key ~ '^[a-z0-9]+(\.[a-z0-9_-]+)+$'),
  grade smallint not null check (grade in (2, 6)),
  subject_key text not null check (subject_key in ('english','math','tamil','hindi','science','aadritha','music',
    'physics','chemistry','biology','history_civics','geography','western_violin','carnatic_violin')),
  topic_id uuid references bnl.curriculum_nodes(id),
  title text not null check (char_length(title) between 1 and 120),
  template_key text not null check (template_key in ('picture_groups_v1','slides_v1','video_v1','audio_v1','story_v1','quiz_v1')),
  sort_order integer not null default 0,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_lessons_topic on bnl.lessons(topic_id, sort_order);

create table if not exists bnl.lesson_versions (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references bnl.lessons(id),
  version_no integer not null check (version_no > 0),
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  checksum text not null default '',
  status text not null default 'draft' check (status in ('draft', 'in_review', 'approved', 'published', 'archived')),
  validation_errors jsonb not null default '[]'::jsonb check (jsonb_typeof(validation_errors) = 'array'),
  created_by uuid,
  submitted_by uuid,
  submitted_at timestamptz,
  reviewed_by uuid,
  approved_at timestamptz,
  rejected_by uuid,
  rejected_at timestamptz,
  review_comment text check (review_comment is null or char_length(review_comment) <= 1000),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lesson_id, version_no)
);

-- Content/checksum are immutable once a version leaves draft (CAT-007); reviewer != author.
create or replace function bnl.tg_lesson_versions_guard() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'bnl: lesson version % is % and cannot be deleted', old.id, old.status using errcode = '55000';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    new.checksum := encode(sha256(convert_to(new.content::text, 'UTF8')), 'hex');
    return new;
  end if;
  if old.status <> 'draft' then
    if new.content is distinct from old.content
       or new.checksum is distinct from old.checksum
       or new.lesson_id is distinct from old.lesson_id
       or new.version_no is distinct from old.version_no then
      raise exception 'bnl: lesson version % is % and its content is immutable; create a new version', old.id, old.status
        using errcode = '55000';
    end if;
  else
    new.checksum := encode(sha256(convert_to(new.content::text, 'UTF8')), 'hex');
  end if;
  if new.status = 'approved' and old.status is distinct from 'approved'
     and new.created_by is not null and new.reviewed_by is not distinct from new.created_by then
    raise exception 'bnl: a reviewer may not approve their own version' using errcode = '42501';
  end if;
  return new;
end
$$;
drop trigger if exists lesson_versions_guard on bnl.lesson_versions;
create trigger lesson_versions_guard before insert or update or delete on bnl.lesson_versions
  for each row execute function bnl.tg_lesson_versions_guard();

create table if not exists bnl.lesson_outcomes (
  lesson_id uuid not null references bnl.lessons(id) on delete cascade,
  outcome_id uuid not null references bnl.learning_outcomes(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (lesson_id, outcome_id)
);

-- Item bank. correct_option_id is server-only (ADR-0002 C3): no grant to bnl_public/bnl_device.
create table if not exists bnl.quiz_items (
  id uuid primary key default gen_random_uuid(),
  lesson_version_id uuid not null references bnl.lesson_versions(id) on delete cascade,
  question_version_key text not null unique check (char_length(question_version_key) between 1 and 128),
  outcome_key text not null check (char_length(outcome_key) <= 128),
  stage_eligibility text[] not null check (
    cardinality(stage_eligibility) >= 1 and stage_eligibility <@ array['baseline', 'immediate', 'delayed']::text[]),
  prompt text not null check (char_length(prompt) <= 500),
  options jsonb not null check (
    jsonb_typeof(options) = 'array' and jsonb_array_length(options) between 2 and 6),
  correct_option_id text not null check (char_length(correct_option_id) between 1 and 64),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (options @> jsonb_build_array(jsonb_build_object('id', correct_option_id)))
);
create index if not exists idx_quiz_items_version on bnl.quiz_items(lesson_version_id, sort_order);

create table if not exists bnl.media_assets (
  id uuid primary key default gen_random_uuid(),
  bucket text not null default 'lesson-assets' check (bucket = 'lesson-assets'),
  storage_key text not null unique,
  mime_type text not null,
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes bigint check (size_bytes is null or size_bytes > 0),
  rights_status text not null check (rights_status in ('original_generated_content', 'licensed', 'public_domain', 'owner_supplied')),
  attribution text,
  alt_text text,
  uploaded_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists bnl.publication_records (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references bnl.lessons(id),
  lesson_version_id uuid not null references bnl.lesson_versions(id),
  published_by uuid not null,
  published_at timestamptz not null default now(),
  reason text not null check (char_length(reason) between 1 and 500),
  manifest_revision bigint,
  unpublished_at timestamptz,
  unpublished_by uuid,
  unpublish_reason text check (unpublish_reason is null or char_length(unpublish_reason) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists uq_publication_one_live on bnl.publication_records(lesson_id) where unpublished_at is null;
create index if not exists idx_publication_version on bnl.publication_records(lesson_version_id);

create table if not exists bnl.published_manifests (
  revision bigint generated by default as identity primary key,
  grade smallint not null check (grade in (2, 6)),
  checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object'),
  pinned_from_revision bigint references bnl.published_manifests(revision),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_manifests_grade_revision on bnl.published_manifests(grade, revision desc);

-- ---------------------------------------------------------------------------
-- Learning data (M07/M08/M09) — household-private, composite FKs pin rows to one household
-- ---------------------------------------------------------------------------
create table if not exists bnl.learning_sessions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references bnl.households(id) on delete cascade,
  learner_id uuid not null,
  device_id uuid not null,
  client_session_id uuid not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  foreground_estimated_ms bigint not null default 0 check (foreground_estimated_ms >= 0),
  playback_ms bigint not null default 0 check (playback_ms >= 0),
  interaction_count integer not null default 0 check (interaction_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (device_id, client_session_id),
  unique (id, household_id),
  foreign key (learner_id, household_id) references bnl.learner_profiles(id, household_id) on delete cascade,
  foreign key (device_id, household_id) references bnl.paired_devices(id, household_id)
);
create index if not exists idx_sessions_household_learner_time on bnl.learning_sessions(household_id, learner_id, started_at desc);

create table if not exists bnl.learning_events (
  event_id uuid primary key,
  household_id uuid not null references bnl.households(id) on delete cascade,
  learner_id uuid not null,
  device_id uuid not null,
  session_id uuid,
  client_session_id uuid not null,
  client_sequence bigint not null check (client_sequence >= 0),
  event_type text not null check (event_type in ('app_opened','profile_selected','session_started','lesson_started',
    'slide_entered','slide_exited','playback_paused','playback_resumed','playback_heartbeat','quiz_started',
    'answer_submitted','quiz_completed','lesson_completed','session_ended','app_hidden','sync_failed','sync_succeeded')),
  schema_version smallint not null check (schema_version = 1),
  lesson_id uuid references bnl.lessons(id),
  lesson_version_id uuid references bnl.lesson_versions(id),
  slide_id text check (slide_id is null or char_length(slide_id) <= 128),
  occurred_at timestamptz not null,
  sent_at timestamptz,
  received_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object' and not payload ? 'is_correct'),
  quality_flag text not null default 'ok'
    check (quality_flag in ('ok', 'clamped', 'late_arrival', 'clock_adjusted', 'sequence_gap', 'suspect')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (learner_id, household_id) references bnl.learner_profiles(id, household_id) on delete cascade,
  foreign key (device_id, household_id) references bnl.paired_devices(id, household_id),
  foreign key (session_id, household_id) references bnl.learning_sessions(id, household_id) on delete cascade
);
create index if not exists idx_events_device_session_seq on bnl.learning_events(device_id, client_session_id, client_sequence);
create index if not exists idx_events_household_learner_time on bnl.learning_events(household_id, learner_id, occurred_at desc);
create index if not exists idx_events_received on bnl.learning_events(received_at);

create table if not exists bnl.learner_progress (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references bnl.households(id) on delete cascade,
  learner_id uuid not null,
  lesson_id uuid not null references bnl.lessons(id),
  lesson_version_id uuid references bnl.lesson_versions(id),
  theme_key text check (theme_key in ('puppy', 'candy', 'unicorn', 'school', 'treat', 'farm')),
  attempt_id uuid not null,
  slide_id text check (slide_id is null or char_length(slide_id) <= 128),
  position_seconds numeric(8, 3) not null default 0 check (position_seconds >= 0 and position_seconds <= 30),
  completed boolean not null default false,
  completed_at timestamptz,
  client_revision integer not null default 0 check (client_revision >= 0),
  server_revision bigint not null default 1 check (server_revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (learner_id, lesson_id, theme_key, attempt_id),
  foreign key (learner_id, household_id) references bnl.learner_profiles(id, household_id) on delete cascade
);
create index if not exists idx_progress_learner_lesson_time on bnl.learner_progress(learner_id, lesson_id, updated_at desc);
create index if not exists idx_progress_household on bnl.learner_progress(household_id);

-- Completion is monotonic within an attempt (ADR-0005 #4); identity columns are fixed; server_revision bumps.
create or replace function bnl.tg_learner_progress_guard() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    new.server_revision := 1;
    if new.completed then
      new.completed_at := coalesce(new.completed_at, now());
    else
      new.completed_at := null;
    end if;
    return new;
  end if;
  if old.completed and not new.completed then
    raise exception 'bnl: progress completion cannot be reverted within an attempt; start a new attempt'
      using errcode = '55000';
  end if;
  if new.household_id is distinct from old.household_id or new.learner_id is distinct from old.learner_id
     or new.lesson_id is distinct from old.lesson_id or new.theme_key is distinct from old.theme_key
     or new.attempt_id is distinct from old.attempt_id then
    raise exception 'bnl: progress identity (learner, lesson, theme, attempt) is immutable' using errcode = '55000';
  end if;
  new.server_revision := old.server_revision + 1;
  if old.completed then
    new.completed_at := old.completed_at;
  elsif new.completed then
    new.completed_at := coalesce(new.completed_at, now());
  end if;
  return new;
end
$$;
drop trigger if exists learner_progress_guard on bnl.learner_progress;
create trigger learner_progress_guard before insert or update on bnl.learner_progress
  for each row execute function bnl.tg_learner_progress_guard();

create table if not exists bnl.assessment_attempts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references bnl.households(id) on delete cascade,
  learner_id uuid not null,
  device_id uuid not null,
  lesson_id uuid not null references bnl.lessons(id),
  lesson_version_id uuid not null references bnl.lesson_versions(id),
  client_attempt_id uuid not null unique,
  stage text not null check (stage in ('baseline', 'immediate', 'delayed')),
  seed text not null check (char_length(seed) between 1 and 128),
  question_keys jsonb not null default '[]'::jsonb check (jsonb_typeof(question_keys) = 'array'),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  total_questions smallint not null default 0 check (total_questions >= 0),
  correct_questions smallint not null default 0 check (correct_questions >= 0 and correct_questions <= total_questions),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, household_id),
  foreign key (learner_id, household_id) references bnl.learner_profiles(id, household_id) on delete cascade,
  foreign key (device_id, household_id) references bnl.paired_devices(id, household_id)
);
create index if not exists idx_attempts_household_learner_time on bnl.assessment_attempts(household_id, learner_id, started_at desc);
create index if not exists idx_attempts_learner_lesson on bnl.assessment_attempts(learner_id, lesson_id, started_at desc);

-- Written only by bnl.score_answer (server-side correctness, TEL-005).
create table if not exists bnl.question_responses (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references bnl.households(id) on delete cascade,
  attempt_id uuid not null,
  learner_id uuid not null,
  question_version_key text not null,
  selected_option_id text not null check (char_length(selected_option_id) between 1 and 128),
  correct boolean not null,
  response_ms integer check (response_ms is null or response_ms between 0 and 600000),
  answered_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (attempt_id, question_version_key),
  foreign key (attempt_id, household_id) references bnl.assessment_attempts(id, household_id) on delete cascade,
  foreign key (learner_id, household_id) references bnl.learner_profiles(id, household_id) on delete cascade
);
create index if not exists idx_responses_learner on bnl.question_responses(household_id, learner_id, answered_at desc);

create table if not exists bnl.review_schedule (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references bnl.households(id) on delete cascade,
  learner_id uuid not null,
  topic_id uuid references bnl.curriculum_nodes(id),
  lesson_id uuid references bnl.lessons(id),
  source_attempt_id uuid,
  due_at timestamptz not null,
  status text not null default 'due' check (status in ('due', 'completed', 'dismissed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (learner_id, household_id) references bnl.learner_profiles(id, household_id) on delete cascade,
  foreign key (source_attempt_id, household_id) references bnl.assessment_attempts(id, household_id) on delete cascade
);
create index if not exists idx_review_due on bnl.review_schedule(due_at) where status = 'due';
create index if not exists idx_review_learner on bnl.review_schedule(household_id, learner_id, due_at);

-- ---------------------------------------------------------------------------
-- Intelligence (M10) and jobs (M13)
-- ---------------------------------------------------------------------------
create table if not exists bnl.metric_definitions (
  id uuid primary key default gen_random_uuid(),
  metric_key text not null,
  version text not null,
  description text not null,
  formula text not null,
  min_sample integer not null default 5 check (min_sample >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (metric_key, version)
);

create table if not exists bnl.score_runs (
  id uuid primary key default gen_random_uuid(),
  run_key text not null unique,
  weights_version text not null,
  as_of_date date not null,
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  rows_written integer not null default 0,
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists bnl.mastery_snapshots (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references bnl.households(id) on delete cascade,
  learner_id uuid not null,
  topic_id uuid references bnl.curriculum_nodes(id),
  score_run_id uuid references bnl.score_runs(id),
  score_date date not null,
  score numeric(5, 2) check (score is null or score between 0 and 100),
  status text not null check (status in ('provisional', 'evidence_sufficient', 'insufficient_evidence')),
  confidence text not null check (confidence in ('low', 'adequate')),
  components jsonb not null check (jsonb_typeof(components) = 'object'),
  coverage_pct numeric(5, 2) not null default 0 check (coverage_pct between 0 and 100),
  weights_version text not null,
  questions_count integer not null default 0 check (questions_count >= 0),
  confidence_note text not null default '',
  limitation text not null default '',
  computed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (learner_id, household_id) references bnl.learner_profiles(id, household_id) on delete cascade
);
create index if not exists idx_mastery_learner_topic_date on bnl.mastery_snapshots(learner_id, topic_id, score_date desc);
create unique index if not exists uq_mastery_run_learner_topic on bnl.mastery_snapshots(score_run_id, learner_id, topic_id) nulls not distinct;

create table if not exists bnl.recommendations (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references bnl.households(id) on delete cascade,
  learner_id uuid not null,
  topic_id uuid references bnl.curriculum_nodes(id),
  score_run_id uuid references bnl.score_runs(id),
  reason_code text not null check (reason_code in ('retention_low_spaced_recall', 'mastery_low_prerequisite_practice',
    'ready_for_next_topic', 'delayed_review_due', 'insufficient_evidence_take_quiz')),
  suggested_lesson_id uuid references bnl.lessons(id),
  computed_at timestamptz not null default now(),
  dismissed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (learner_id, household_id) references bnl.learner_profiles(id, household_id) on delete cascade
);
create index if not exists idx_recommendations_learner on bnl.recommendations(household_id, learner_id, computed_at desc);

create table if not exists bnl.aggregation_runs (
  id uuid primary key default gen_random_uuid(),
  job_key text not null unique,
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists bnl.job_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  run_key text not null,
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed', 'dead_letter')),
  attempts integer not null default 1 check (attempts >= 1),
  result jsonb not null default '{}'::jsonb,
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (job_name, run_key)
);

-- ---------------------------------------------------------------------------
-- Admin / ops
-- ---------------------------------------------------------------------------
-- Append-only. metadata must never contain names, answers or tokens (ADR-0005 #11).
create table if not exists bnl.audit_logs (
  id uuid primary key default gen_random_uuid(),
  -- Derived from the request role by trigger (bnl_device -> device, bnl_job -> job, adult/staff -> user).
  actor_type text not null default 'user' check (actor_type in ('user', 'device', 'system', 'job')),
  actor_auth_id uuid,  -- auth user id (user), device id (device); null for system/job
  household_id uuid references bnl.households(id) on delete set null,
  action text not null check (action ~ '^[a-z0-9_.:-]{1,64}$'),
  target_type text not null check (target_type ~ '^[a-z0-9_.:-]{1,64}$'),
  target_id uuid,
  request_id text check (request_id is null or char_length(request_id) <= 128),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_audit_household_time on bnl.audit_logs(household_id, created_at desc);
create index if not exists idx_audit_target on bnl.audit_logs(target_type, target_id);

create or replace function bnl.tg_audit_actor_type() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp
as $$
begin
  new.actor_type := case current_user
    when 'bnl_device' then 'device'
    when 'bnl_job' then 'job'
    when 'bnl_adult' then 'user'
    when 'bnl_staff' then 'user'
    when 'bnl_public' then 'user'
    else new.actor_type end;
  return new;
end
$$;
drop trigger if exists audit_actor_type on bnl.audit_logs;
create trigger audit_actor_type before insert on bnl.audit_logs
  for each row execute function bnl.tg_audit_actor_type();

create table if not exists bnl.idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  key text not null check (char_length(key) between 8 and 128 and key ~ '^[A-Za-z0-9._:-]+$'),
  scope text not null check (char_length(scope) between 1 and 64),
  actor_or_device uuid not null,
  household_id uuid references bnl.households(id) on delete cascade,
  request_sha256 text not null check (request_sha256 ~ '^[a-f0-9]{64}$'),
  response jsonb,
  status_code smallint check (status_code is null or status_code between 100 and 599),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (scope, actor_or_device, key)
);
create index if not exists idx_idempotency_expiry on bnl.idempotency_keys(expires_at);

-- Fixed-window counters (A2 contract): one row per (key, window_start). Keys must be hashed (no raw IPs/emails).
create table if not exists bnl.rate_limit_buckets (
  id uuid primary key default gen_random_uuid(),
  key text not null check (char_length(key) between 1 and 200),
  window_start timestamptz not null,
  window_seconds integer not null check (window_seconds > 0),
  count integer not null default 0 check (count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (key, window_start)
);

create table if not exists bnl.data_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references bnl.households(id) on delete cascade,
  requested_by uuid not null,
  scope text not null check (scope in ('learner', 'household', 'telemetry_only')),
  learner_id uuid,
  status text not null default 'requested' check (status in ('requested', 'processing', 'completed', 'rejected')),
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (scope <> 'learner' or learner_id is not null)
);

-- ---------------------------------------------------------------------------
-- updated_at trigger on every table that has the column
-- ---------------------------------------------------------------------------
do $upd$
declare
  t record;
begin
  for t in
    select c.table_name from information_schema.columns c
    join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name
    where c.table_schema = 'bnl' and c.column_name = 'updated_at' and tb.table_type = 'BASE TABLE'
  loop
    execute format('drop trigger if exists set_updated_at on bnl.%I', t.table_name);
    execute format('create trigger set_updated_at before update on bnl.%I for each row execute function bnl.tg_set_updated_at()', t.table_name);
  end loop;
end
$upd$;
