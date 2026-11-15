-- BreakNLearn starting relational schema blueprint, PostgreSQL/Supabase.
-- REVIEW by security/DB agent before production. Purposefully DENY all client access.
-- API BFF uses server-side credentials and must enforce authorization itself;
-- add audited RLS policies and test them before considering any direct browser access.
create extension if not exists pgcrypto;
create schema if not exists bnl;
revoke all on schema bnl from public, anon, authenticated;
grant usage on schema bnl to service_role;

create table if not exists bnl.households (
  id uuid primary key default gen_random_uuid(), label text, created_at timestamptz not null default now());
create table if not exists bnl.household_memberships (
  id uuid primary key default gen_random_uuid(), household_id uuid not null references bnl.households(id),
  auth_user_id uuid not null, role text not null check(role in ('owner','guardian','editor','reviewer','publisher','analyst')),
  active boolean not null default true, created_at timestamptz not null default now(),
  unique(household_id,auth_user_id,role));
create table if not exists bnl.learner_profiles (
  id uuid primary key default gen_random_uuid(), household_id uuid not null references bnl.households(id),
  profile_slot smallint not null check(profile_slot in (1,2)), display_name text not null check(char_length(display_name)<=30),
  grade smallint not null check(grade in (2,6)), avatar_id text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(household_id,profile_slot));
create table if not exists bnl.paired_devices (
  id uuid primary key default gen_random_uuid(), household_id uuid not null references bnl.households(id),
  label text, public_key text, token_version integer not null default 1, revoked_at timestamptz,
  created_at timestamptz not null default now());
create table if not exists bnl.device_pairing_codes (
  id uuid primary key default gen_random_uuid(), code_hash bytea not null unique, household_id uuid references bnl.households(id),
  expires_at timestamptz not null, consumed_at timestamptz, created_at timestamptz not null default now());
create table if not exists bnl.consent_records (
  id uuid primary key default gen_random_uuid(), household_id uuid not null references bnl.households(id),
  guardian_auth_user_id uuid not null, consent_version text not null, granted_at timestamptz not null default now(), revoked_at timestamptz);

create table if not exists bnl.source_documents (
 id uuid primary key default gen_random_uuid(), source_type text not null, url text, title text not null,
 version_label text, document_checksum text, verified_by uuid, verified_at timestamptz,
 created_at timestamptz not null default now());
create table if not exists bnl.curriculum_frameworks (
 id uuid primary key default gen_random_uuid(), board text not null, level text not null, version_label text not null,
 source_document_id uuid references bnl.source_documents(id), created_at timestamptz not null default now());
create table if not exists bnl.curriculum_nodes (
 id uuid primary key default gen_random_uuid(), framework_id uuid references bnl.curriculum_frameworks(id),
 stable_key text not null unique, parent_id uuid references bnl.curriculum_nodes(id), grade smallint not null,
 node_type text not null check(node_type in ('subject','strand','topic','subtopic')),
 title text not null, source_ref text, authority text not null default 'editorial_unverified'
 check(authority in ('editorial_unverified','cisce_verified','school_specific','local_enrichment')),
 review_status text not null default 'draft' check(review_status in ('draft','in_review','verified','archived')),
 sort_order integer not null default 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists bnl.learning_outcomes (
 id uuid primary key default gen_random_uuid(), curriculum_node_id uuid not null references bnl.curriculum_nodes(id),
 stable_key text unique not null, statement text not null, source_ref text, verified_at timestamptz, created_at timestamptz not null default now());

create table if not exists bnl.school_plans (
 id uuid primary key default gen_random_uuid(), household_id uuid not null references bnl.households(id),
 grade smallint not null, subject_key text not null, academic_year text not null,
 school_label text, textbook_title text, textbook_edition text, created_at timestamptz not null default now());
create table if not exists bnl.syllabus_uploads (
 id uuid primary key default gen_random_uuid(), school_plan_id uuid not null references bnl.school_plans(id),
 object_key text not null, sha256 text not null, filename text not null, mime_type text not null,
 status text not null default 'uploaded' check(status in ('uploaded','extracting','review','failed','approved')),
 created_at timestamptz not null default now());
create table if not exists bnl.syllabus_chapters (
 id uuid primary key default gen_random_uuid(), upload_id uuid not null references bnl.syllabus_uploads(id),
 chapter_number text, title text not null, page_start integer, sort_order integer not null,
 extraction_confidence numeric(4,3), source_page integer, created_at timestamptz not null default now());
create table if not exists bnl.chapter_topic_mappings (
 id uuid primary key default gen_random_uuid(), chapter_id uuid not null references bnl.syllabus_chapters(id),
 curriculum_node_id uuid not null references bnl.curriculum_nodes(id),
 state text not null default 'suggested' check(state in ('suggested','approved','rejected')),
 confidence numeric(4,3), reviewer_auth_id uuid, reviewed_at timestamptz,
 unique(chapter_id,curriculum_node_id));

create table if not exists bnl.lessons (
 id uuid primary key default gen_random_uuid(), stable_key text unique not null,
 grade smallint not null, subject_key text not null, topic_node_id uuid references bnl.curriculum_nodes(id),
 title text not null, template_key text not null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists bnl.lesson_versions (
 id uuid primary key default gen_random_uuid(), lesson_id uuid not null references bnl.lessons(id),
 version_no integer not null check(version_no>0), content jsonb not null,
 checksum text not null, status text not null default 'draft'
 check(status in ('draft','in_review','approved','published','archived')),
 created_by uuid, reviewed_by uuid, approved_at timestamptz, created_at timestamptz not null default now(),
 unique(lesson_id,version_no));
create table if not exists bnl.lesson_outcomes (
 lesson_id uuid not null references bnl.lessons(id), outcome_id uuid not null references bnl.learning_outcomes(id),
 primary key(lesson_id,outcome_id));
create table if not exists bnl.media_assets (
 id uuid primary key default gen_random_uuid(), storage_key text unique not null, mime_type text not null,
 sha256 text not null, rights_status text not null, attribution text, uploaded_by uuid,
 created_at timestamptz not null default now());
create table if not exists bnl.publication_records (
 id uuid primary key default gen_random_uuid(), lesson_id uuid not null references bnl.lessons(id),
 lesson_version_id uuid not null references bnl.lesson_versions(id),
 published_by uuid, published_at timestamptz not null default now(), unpublished_at timestamptz,
 unique(lesson_id,lesson_version_id,published_at));
create unique index if not exists bnl_one_live_lesson on bnl.publication_records(lesson_id) where unpublished_at is null;
create table if not exists bnl.published_manifests (
 revision bigint generated always as identity primary key, checksum text not null,
 manifest jsonb not null, created_at timestamptz not null default now());

create table if not exists bnl.learning_sessions (
 id uuid primary key, household_id uuid not null references bnl.households(id),
 learner_id uuid not null references bnl.learner_profiles(id), device_id uuid not null references bnl.paired_devices(id),
 started_at timestamptz not null, ended_at timestamptz,
 foreground_estimated_ms bigint not null default 0, playback_ms bigint not null default 0,
 created_at timestamptz not null default now());
create table if not exists bnl.learning_events (
 event_id uuid primary key, household_id uuid not null references bnl.households(id),
 learner_id uuid not null references bnl.learner_profiles(id), device_id uuid not null references bnl.paired_devices(id),
 session_id uuid references bnl.learning_sessions(id), event_type text not null,
 schema_version smallint not null, client_sequence bigint not null,
 lesson_id uuid references bnl.lessons(id), lesson_version_id uuid references bnl.lesson_versions(id),
 slide_id text, occurred_at timestamptz not null, received_at timestamptz not null default now(),
 payload jsonb not null default '{}'::jsonb, quality_flag text);
create table if not exists bnl.learner_progress (
 id uuid primary key default gen_random_uuid(), household_id uuid not null references bnl.households(id),
 learner_id uuid not null references bnl.learner_profiles(id), lesson_id uuid not null references bnl.lessons(id),
 attempt_id uuid not null, lesson_version_id uuid references bnl.lesson_versions(id), slide_id text,
 position_seconds numeric(8,3) not null default 0, completed boolean not null default false,
 server_revision bigint not null default 1, updated_at timestamptz not null default now(),
 unique(learner_id,lesson_id,attempt_id));
create table if not exists bnl.assessment_attempts (
 id uuid primary key default gen_random_uuid(), household_id uuid not null references bnl.households(id),
 learner_id uuid not null references bnl.learner_profiles(id), lesson_id uuid not null references bnl.lessons(id),
 lesson_version_id uuid references bnl.lesson_versions(id),
 stage text not null check(stage in ('baseline','immediate','delayed')),
 started_at timestamptz not null default now(), finished_at timestamptz,
 total_questions smallint not null default 0, correct_questions smallint not null default 0,
 unique(learner_id,lesson_id,stage,started_at));
create table if not exists bnl.question_responses (
 id uuid primary key default gen_random_uuid(), attempt_id uuid not null references bnl.assessment_attempts(id),
 question_version_key text not null, selected_option_id text not null,
 correct boolean not null, answered_at timestamptz not null default now(), response_ms integer,
 unique(attempt_id,question_version_key));
create table if not exists bnl.review_schedule (
 id uuid primary key default gen_random_uuid(), household_id uuid not null references bnl.households(id),
 learner_id uuid not null references bnl.learner_profiles(id), topic_node_id uuid references bnl.curriculum_nodes(id),
 lesson_id uuid references bnl.lessons(id), due_at timestamptz not null,
 status text not null default 'due' check(status in ('due','completed','dismissed')));
create table if not exists bnl.mastery_snapshots (
 id uuid primary key default gen_random_uuid(), household_id uuid not null references bnl.households(id),
 learner_id uuid not null references bnl.learner_profiles(id), topic_node_id uuid references bnl.curriculum_nodes(id),
 score numeric(5,2), status text not null check(status in ('provisional','evidence_sufficient','insufficient_evidence')),
 components jsonb not null, coverage_pct numeric(5,2) not null default 0,
 weights_version text not null, question_count integer not null default 0,
 computed_at timestamptz not null default now());
create table if not exists bnl.recommendations (
 id uuid primary key default gen_random_uuid(), learner_id uuid not null references bnl.learner_profiles(id),
 topic_node_id uuid references bnl.curriculum_nodes(id), reason_code text not null,
 suggested_lesson_id uuid references bnl.lessons(id), computed_at timestamptz not null default now(), dismissed_at timestamptz);
create table if not exists bnl.audit_logs (
 id uuid primary key default gen_random_uuid(), actor_auth_id uuid, household_id uuid references bnl.households(id),
 action text not null, target_type text not null, target_id uuid, metadata jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now());
create table if not exists bnl.import_jobs (
 id uuid primary key default gen_random_uuid(), household_id uuid references bnl.households(id),
 job_type text not null, input_sha256 text, status text not null, errors jsonb,
 created_at timestamptz not null default now(), finished_at timestamptz);
create table if not exists bnl.aggregation_runs (
 id uuid primary key default gen_random_uuid(), job_key text not null unique,
 status text not null, started_at timestamptz not null default now(), finished_at timestamptz, error_message text);

create index if not exists idx_event_learner_time on bnl.learning_events(learner_id,occurred_at desc);
create index if not exists idx_event_household_time on bnl.learning_events(household_id,received_at desc);
create index if not exists idx_sessions_learner_time on bnl.learning_sessions(learner_id,started_at desc);
create index if not exists idx_progress_learner_update on bnl.learner_progress(learner_id,updated_at desc);
create index if not exists idx_mastery_learner_time on bnl.mastery_snapshots(learner_id,computed_at desc);
create index if not exists idx_recall_due on bnl.review_schedule(due_at) where status='due';

-- Default-deny RLS; SQL agent must add explicit least-privilege policies AFTER
-- defining audited authenticated access patterns, plus GRANT/REVOKE tests.
-- Service-role has privileged table access; it may bypass RLS. SERVER ONLY.
DO $$ DECLARE t record; BEGIN
 FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='bnl' LOOP
   EXECUTE format('ALTER TABLE bnl.%I ENABLE ROW LEVEL SECURITY',t.tablename);
   EXECUTE format('REVOKE ALL ON bnl.%I FROM public, anon, authenticated',t.tablename);
   EXECUTE format('GRANT ALL ON bnl.%I TO service_role',t.tablename);
 END LOOP;
END $$;
grant usage on all sequences in schema bnl to service_role;
revoke all on all sequences in schema bnl from public,anon,authenticated;
