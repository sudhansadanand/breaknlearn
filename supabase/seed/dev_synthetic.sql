-- ============================================================================
-- SYNTHETIC DEV/TEST DATA ONLY. NEVER APPLY TO STAGING OR PRODUCTION.
-- Fictional households, users, devices and learners for local development and the RLS test suite.
-- No real names, emails, credentials or tokens. Ids are fixed so tests can reference them
-- (see packages/db/test/fixtures.ts).
-- ============================================================================

do $guard$
begin
  if exists (select 1 from bnl.households where label not like 'SYNTHETIC %') then
    raise exception 'dev_synthetic.sql refuses to run on a database with non-synthetic households';
  end if;
end
$guard$;

insert into bnl.households (id, label, timezone) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'SYNTHETIC Household A', 'Asia/Kolkata'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'SYNTHETIC Household B', 'Asia/Kolkata')
on conflict (id) do nothing;

-- Adult auth user ids (stand-ins for Supabase auth.users ids; shared with A2's synthetic auth users):
--   owner@bnl.test    11111111-1111-4111-8111-111111111111  owner of household A
--   guardian@bnl.test 22222222-2222-4222-8222-222222222222  guardian of household A
--   outsider@bnl.test 33333333-3333-4333-8333-333333333333  no household (deliberately no rows)
--   household B owner/guardian: b0000000-...-b1 / b0000000-...-b2; staff users: e0000000-...-e1..e5
insert into bnl.household_memberships (household_id, auth_user_id, role) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', '11111111-1111-4111-8111-111111111111', 'owner'),
  ('aaaaaaaa-0000-4000-8000-00000000000a', '22222222-2222-4222-8222-222222222222', 'guardian'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'b0000000-0000-4000-8000-0000000000b1', 'owner'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'b0000000-0000-4000-8000-0000000000b2', 'guardian')
on conflict (household_id, auth_user_id) do nothing;

-- Staff users (global content roles; no household membership).
insert into bnl.staff_roles (auth_user_id, role)
select v.uid::uuid, v.role from (values
  ('e0000000-0000-4000-8000-0000000000e1', 'editor'),
  ('e0000000-0000-4000-8000-0000000000e2', 'reviewer'),
  ('e0000000-0000-4000-8000-0000000000e3', 'publisher'),
  ('e0000000-0000-4000-8000-0000000000e4', 'analyst'),
  ('e0000000-0000-4000-8000-0000000000e5', 'editor'),     -- editor + reviewer: may not approve own version
  ('e0000000-0000-4000-8000-0000000000e5', 'reviewer')
) as v(uid, role)
where not exists (select 1 from bnl.staff_roles s where s.auth_user_id = v.uid::uuid and s.role = v.role and s.revoked_at is null);

insert into bnl.paired_devices (id, household_id, label, token_version, paired_at, revoked_at) values
  ('d0000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-00000000000a', 'SYNTHETIC Living room TV', 1, now(), null),
  ('d0000000-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-00000000000a', 'SYNTHETIC Old TV (revoked)', 2, now(), now()),
  ('d0000000-0000-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-00000000000b', 'SYNTHETIC Bedroom TV', 1, now(), null)
on conflict (id) do nothing;

insert into bnl.learner_profiles (id, household_id, slot, display_name, grade, avatar_id) values
  ('c0000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-00000000000a', 1, 'Synthetic A1', 2, 'fox'),
  ('c0000000-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-00000000000a', 2, 'Synthetic A2', 6, 'rocket'),
  ('c0000000-0000-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-00000000000b', 1, 'Synthetic B1', 2, 'panda'),
  ('c0000000-0000-4000-8000-0000000000b2', 'bbbbbbbb-0000-4000-8000-00000000000b', 2, 'Synthetic B2', 6, 'tiger')
on conflict (id) do nothing;

insert into bnl.consent_records (id, household_id, guardian_auth_user_id, consent_version) values
  ('f0000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-00000000000a', '11111111-1111-4111-8111-111111111111', 'synthetic-v1'),
  ('f0000000-0000-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-00000000000b', 'b0000000-0000-4000-8000-0000000000b1', 'synthetic-v1')
on conflict (id) do nothing;

-- One progress row per household (×3 in Puppy Park), for cross-household read tests.
insert into bnl.learner_progress (id, household_id, learner_id, lesson_id, lesson_version_id, theme_key, attempt_id,
  slide_id, position_seconds, completed, client_revision) values
  ('90000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-00000000000a', 'c0000000-0000-4000-8000-0000000000a1',
   'f95143b0-7b4c-5452-8a3f-71096a538dff', null, 'puppy', '91000000-0000-4000-8000-0000000000a1', 'step-4', 2.5, false, 3),
  ('90000000-0000-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-00000000000b', 'c0000000-0000-4000-8000-0000000000b1',
   'f95143b0-7b4c-5452-8a3f-71096a538dff', null, 'candy', '91000000-0000-4000-8000-0000000000b1', 'step-2', 0, false, 1)
on conflict (id) do nothing;

-- A private school plan + upload for household A (SEC-006/SEC-007 negative tests).
insert into bnl.school_plans (id, household_id, grade, subject_key, academic_year, school_label) values
  ('5c000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-00000000000a', 2, 'math', '2026-27', 'SYNTHETIC School')
on conflict (id) do nothing;
insert into bnl.syllabus_uploads (id, household_id, school_plan_id, object_key, sha256, original_filename, mime_type, size_bytes)
values ('5d000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-00000000000a', '5c000000-0000-4000-8000-0000000000a1',
        'aaaaaaaa-0000-4000-8000-00000000000a/synthetic-toc.csv', repeat('ab', 32), 'synthetic-toc.csv', 'text/csv', 120)
on conflict (id) do nothing;

-- An unpublished draft lesson (must never reach the public catalog).
insert into bnl.lessons (id, stable_key, grade, subject_key, topic_id, title, template_key, sort_order, created_by) values
  ('1e000000-0000-4000-8000-000000000001', 'grade6.math.synthetic-draft', 6, 'math',
   bnl.uuid_v5('6f1d2a0e-6b1e-4a35-9a4e-2f6c3b8d9e10', 'grade6.math.number_system'),
   'SYNTHETIC draft lesson', 'slides_v1', 1, 'e0000000-0000-4000-8000-0000000000e1')
on conflict (id) do nothing;
insert into bnl.lesson_versions (id, lesson_id, version_no, content, status, created_by) values
  ('1f000000-0000-4000-8000-000000000001', '1e000000-0000-4000-8000-000000000001', 1, jsonb_build_object(
    'contract_version', 1, 'stable_key', 'grade6.math.synthetic-draft', 'grade', 6, 'subject_key', 'math',
    'topic_key', 'grade6.math.number_system', 'title', 'SYNTHETIC draft lesson', 'template', 'slides_v1',
    'config', jsonb_build_object('slides', jsonb_build_array()), 'learning_outcome_keys', jsonb_build_array('grade6.math.number_system'),
    'rights', jsonb_build_object('type', 'original_generated_content', 'reviewed', true)),
   'draft', 'e0000000-0000-4000-8000-0000000000e1')
on conflict (id) do nothing;
insert into bnl.quiz_items (lesson_version_id, question_version_key, outcome_key, stage_eligibility, prompt, options, correct_option_id)
values ('1f000000-0000-4000-8000-000000000001', 'grade6.math.synthetic-draft.q1.v1', 'grade6.math.number_system',
        array['immediate'], 'SYNTHETIC: 2 + 2 = ?',
        '[{"id":"a","label":"3"},{"id":"b","label":"4"},{"id":"c","label":"5"},{"id":"d","label":"6"}]'::jsonb, 'b')
on conflict (question_version_key) do nothing;
