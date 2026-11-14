-- BreakNLearn 0003: SECURITY DEFINER workflow functions (all owned by bnl_owner, fixed search_path,
-- explicit role checks, audit rows). Each function is one transaction: if any step fails (including
-- building the manifest) nothing commits (OPS-003).
--
-- Error codes (map in the BFF): 42501 forbidden, P0002 not_found, 22023 validation_failed,
-- 55000 conflict (wrong state), 23xxx conflict.

-- True for an operations connection (migrations/seeds/owner tooling): the login role is not an app login.
create or replace function bnl._is_ops_session() returns boolean
language sql stable security definer set search_path = pg_catalog, pg_temp
as $$
  select not exists (
    select 1 from pg_auth_members m
    join pg_roles g on g.oid = m.roleid
    join pg_roles u on u.oid = m.member
    where u.rolname = session_user and g.rolname in ('bnl_public', 'bnl_device', 'bnl_adult', 'bnl_staff', 'bnl_job'))
$$;

-- Validates the acting staff user and returns the audit actor_type ('user' | 'system').
create or replace function bnl._require_staff_actor(p_actor uuid, p_role text) returns text
language plpgsql stable security definer set search_path = pg_catalog, pg_temp
as $$
begin
  if p_actor is null then
    raise exception 'bnl: actor is required' using errcode = '42501';
  end if;
  if p_actor = bnl.system_actor_id() then
    if bnl._is_ops_session() then
      return 'system';
    end if;
    raise exception 'bnl: the system actor is not available to application sessions' using errcode = '42501';
  end if;
  if not bnl._is_ops_session() and p_actor is distinct from bnl.current_actor_id() then
    raise exception 'bnl: actor does not match the session' using errcode = '42501';
  end if;
  if not exists (select 1 from bnl.staff_roles s where s.auth_user_id = p_actor and s.role = p_role and s.revoked_at is null) then
    raise exception 'bnl: % role required', p_role using errcode = '42501';
  end if;
  return 'user';
end
$$;

-- Structural validation of LessonContent (contracts lesson.ts). Returns [{path,message}].
create or replace function bnl.lesson_content_errors(p_lesson_id uuid, p_content jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp
as $$
declare
  l bnl.lessons;
  e jsonb := '[]'::jsonb;
  c jsonb;
  theme text;
begin
  select * into l from bnl.lessons where id = p_lesson_id;
  if not found then
    return jsonb_build_array(jsonb_build_object('path', 'lesson_id', 'message', 'unknown lesson'));
  end if;
  if (p_content->'contract_version') is distinct from '1'::jsonb then
    e := e || jsonb_build_object('path', 'contract_version', 'message', 'must be 1');
  end if;
  if (p_content->>'stable_key') is distinct from l.stable_key then
    e := e || jsonb_build_object('path', 'stable_key', 'message', 'must equal the lesson stable_key');
  end if;
  if (p_content->'grade') is distinct from to_jsonb(l.grade::int) then
    e := e || jsonb_build_object('path', 'grade', 'message', 'must equal the lesson grade');
  end if;
  if (p_content->>'subject_key') is distinct from l.subject_key then
    e := e || jsonb_build_object('path', 'subject_key', 'message', 'must equal the lesson subject_key');
  end if;
  if (p_content->>'template') is distinct from l.template_key then
    e := e || jsonb_build_object('path', 'template', 'message', 'must equal the lesson template_key');
  end if;
  if jsonb_typeof(p_content->'title') is distinct from 'string'
     or char_length(p_content->>'title') not between 1 and 120 then
    e := e || jsonb_build_object('path', 'title', 'message', 'must be 1..120 characters');
  end if;
  if jsonb_typeof(p_content->'topic_key') is distinct from 'string' then
    e := e || jsonb_build_object('path', 'topic_key', 'message', 'required');
  end if;
  if jsonb_typeof(p_content->'learning_outcome_keys') is distinct from 'array'
     or jsonb_array_length(p_content->'learning_outcome_keys') = 0 then
    e := e || jsonb_build_object('path', 'learning_outcome_keys', 'message', 'at least one outcome required');
  end if;
  if (p_content#>>'{rights,type}') is null
     or (p_content#>>'{rights,type}') not in ('original_generated_content', 'licensed', 'public_domain', 'owner_supplied') then
    e := e || jsonb_build_object('path', 'rights.type', 'message', 'invalid rights type');
  end if;
  if jsonb_typeof(p_content#>'{rights,reviewed}') is distinct from 'boolean' then
    e := e || jsonb_build_object('path', 'rights.reviewed', 'message', 'must be boolean');
  end if;
  c := p_content->'config';
  if jsonb_typeof(c) is distinct from 'object' then
    e := e || jsonb_build_object('path', 'config', 'message', 'must be an object');
  elsif l.template_key = 'picture_groups_v1' then
    if jsonb_typeof(c->'factor') is distinct from 'number' or (c->>'factor')::numeric not between 1 and 10
       or (c->>'factor')::numeric <> trunc((c->>'factor')::numeric) then
      e := e || jsonb_build_object('path', 'config.factor', 'message', 'integer 1..10');
    end if;
    if jsonb_typeof(c->'themes') is distinct from 'array' or jsonb_array_length(c->'themes') not between 1 and 6 then
      e := e || jsonb_build_object('path', 'config.themes', 'message', '1..6 themes');
    else
      for theme in select jsonb_array_elements_text(c->'themes') loop
        if theme not in ('puppy', 'candy', 'unicorn', 'school', 'treat', 'farm') then
          e := e || jsonb_build_object('path', 'config.themes', 'message', 'unknown theme');
        end if;
      end loop;
    end if;
    if jsonb_typeof(c->'seconds_per_slide') is distinct from 'number' or (c->>'seconds_per_slide')::numeric not between 3 and 30 then
      e := e || jsonb_build_object('path', 'config.seconds_per_slide', 'message', 'integer 3..30');
    end if;
    if jsonb_typeof(c->'quiz_question_count') is distinct from 'number' or (c->>'quiz_question_count')::numeric not between 1 and 10 then
      e := e || jsonb_build_object('path', 'config.quiz_question_count', 'message', 'integer 1..10');
    end if;
  end if;
  return e;
end
$$;

create or replace function bnl._audit(p_actor_type text, p_actor uuid, p_household uuid, p_action text,
  p_target_type text, p_target uuid, p_metadata jsonb) returns void
language sql security definer set search_path = pg_catalog, pg_temp
as $$
  insert into bnl.audit_logs (actor_type, actor_auth_id, household_id, action, target_type, target_id, metadata)
  values (p_actor_type, case when p_actor_type = 'system' then null else p_actor end, p_household, p_action,
          p_target_type, p_target, coalesce(p_metadata, '{}'::jsonb))
$$;

-- ---------------------------------------------------------------------------
-- Lesson version state machine: draft -> in_review -> approved (-> published via publish) ; reject -> draft
-- ---------------------------------------------------------------------------
create or replace function bnl.transition_lesson_version(p_version_id uuid, p_action text, p_actor uuid, p_comment text default null)
returns table (version_id uuid, status text)
language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  v bnl.lesson_versions;
  v_actor_type text;
  v_errors jsonb;
  v_new_status text;
begin
  if p_action not in ('submit', 'approve', 'reject') then
    raise exception 'bnl: unknown action %', p_action using errcode = '22023';
  end if;
  if p_comment is not null and char_length(p_comment) > 1000 then
    raise exception 'bnl: comment too long' using errcode = '22023';
  end if;
  v_actor_type := bnl._require_staff_actor(p_actor, case when p_action = 'submit' then 'editor' else 'reviewer' end);

  select * into v from bnl.lesson_versions lv where lv.id = p_version_id for update;
  if not found then
    raise exception 'bnl: lesson version not found' using errcode = 'P0002';
  end if;

  if p_action = 'submit' then
    if v.status <> 'draft' then
      raise exception 'bnl: only a draft can be submitted (status %)', v.status using errcode = '55000';
    end if;
    v_errors := bnl.lesson_content_errors(v.lesson_id, v.content);
    if jsonb_array_length(v_errors) > 0 then
      raise exception 'bnl: lesson content is invalid' using errcode = '22023', detail = v_errors::text;
    end if;
    update bnl.lesson_versions lv set status = 'in_review', submitted_by = p_actor, submitted_at = now(),
      validation_errors = '[]'::jsonb, review_comment = coalesce(p_comment, lv.review_comment)
      where lv.id = p_version_id;
    v_new_status := 'in_review';
  elsif p_action = 'approve' then
    if v.status <> 'in_review' then
      raise exception 'bnl: only a version in review can be approved (status %)', v.status using errcode = '55000';
    end if;
    if v.created_by is not null and v.created_by = p_actor then
      raise exception 'bnl: a reviewer may not approve their own version' using errcode = '42501';
    end if;
    update bnl.lesson_versions lv set status = 'approved', reviewed_by = p_actor, approved_at = now(),
      review_comment = coalesce(p_comment, lv.review_comment)
      where lv.id = p_version_id;
    v_new_status := 'approved';
  else
    if v.status <> 'in_review' then
      raise exception 'bnl: only a version in review can be rejected (status %)', v.status using errcode = '55000';
    end if;
    update bnl.lesson_versions lv set status = 'draft', rejected_by = p_actor, rejected_at = now(),
      submitted_by = null, submitted_at = null, review_comment = p_comment
      where lv.id = p_version_id;
    v_new_status := 'draft';
  end if;

  perform bnl._audit(v_actor_type, p_actor, null, 'lesson_version.' || p_action, 'lesson_version', p_version_id,
    jsonb_build_object('lesson_id', v.lesson_id, 'version_no', v.version_no, 'from', v.status, 'to', v_new_status));
  return query select p_version_id, v_new_status;
end
$$;

-- ---------------------------------------------------------------------------
-- Manifest (contracts PublishedManifest). Built from live publication records; raises on any inconsistency.
-- ---------------------------------------------------------------------------
create or replace function bnl._build_manifest_subjects(p_grade smallint) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp
as $$
declare
  bad record;
  v_subjects jsonb;
begin
  for bad in
    select l.stable_key, l.subject_key, l.topic_id, v.status, v.content
    from bnl.publication_records pr
    join bnl.lessons l on l.id = pr.lesson_id
    join bnl.lesson_versions v on v.id = pr.lesson_version_id
    where pr.unpublished_at is null and l.grade = p_grade
      and (v.status <> 'published'
           or l.topic_id is null
           or not exists (select 1 from bnl.grade_subjects gs where gs.grade = l.grade and gs.subject_key = l.subject_key)
           or (v.content->>'stable_key') is distinct from l.stable_key
           or (v.content->>'subject_key') is distinct from l.subject_key
           or (v.content->'grade') is distinct from to_jsonb(l.grade::int))
    limit 1
  loop
    raise exception 'bnl: manifest build failed for grade %: lesson % is inconsistent (subject %, topic %, version status %)',
      p_grade, bad.stable_key, bad.subject_key, coalesce(bad.topic_id::text, 'none'), bad.status
      using errcode = '22023';
  end loop;

  with live as (
    select l.id, l.stable_key, l.grade, l.subject_key, l.topic_id, l.sort_order,
           v.id as version_id, v.version_no, v.content->>'title' as title, v.content->>'template' as template_key
    from bnl.publication_records pr
    join bnl.lessons l on l.id = pr.lesson_id
    join bnl.lesson_versions v on v.id = pr.lesson_version_id
    where pr.unpublished_at is null and l.grade = p_grade
  ), topics as (
    select live.subject_key, n.id, n.stable_key, n.title, n.sort_order,
           jsonb_agg(jsonb_build_object(
             'id', live.id, 'version_id', live.version_id, 'version_no', live.version_no,
             'stable_key', live.stable_key, 'grade', live.grade, 'subject_key', live.subject_key,
             'topic_id', live.topic_id, 'title', live.title, 'template_key', live.template_key,
             'sort_order', live.sort_order) order by live.sort_order, live.stable_key) as lessons
    from live join bnl.curriculum_nodes n on n.id = live.topic_id
    group by live.subject_key, n.id, n.stable_key, n.title, n.sort_order
  ), by_subject as (
    select subject_key,
           jsonb_agg(jsonb_build_object('id', id, 'key', stable_key, 'title', title, 'lessons', lessons)
                     order by sort_order, stable_key) as topics
    from topics group by subject_key
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'key', gs.subject_key, 'label', gs.label,
           'playable', bs.topics is not null,
           'topics', coalesce(bs.topics, '[]'::jsonb)) order by gs.sort_order), '[]'::jsonb)
    into v_subjects
  from bnl.grade_subjects gs left join by_subject bs on bs.subject_key = gs.subject_key
  where gs.grade = p_grade;

  if jsonb_array_length(v_subjects) = 0 then
    raise exception 'bnl: manifest build failed: grade % has no subjects', p_grade using errcode = '22023';
  end if;
  return v_subjects;
end
$$;

-- Writes a new manifest row. checksum = sha256 hex of (manifest without "checksum")::text; ETag = checksum.
create or replace function bnl._write_manifest(p_grade smallint, p_actor uuid, p_pinned_from bigint) returns bigint
language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
declare
  v_rev bigint;
  v_body jsonb;
  v_checksum text;
begin
  v_rev := nextval(pg_get_serial_sequence('bnl.published_manifests', 'revision'));
  v_body := jsonb_build_object(
    'revision', v_rev,
    'grade', p_grade::int,
    'generated_at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'subjects', bnl._build_manifest_subjects(p_grade));
  v_checksum := bnl.sha256_hex(v_body::text);
  insert into bnl.published_manifests (revision, grade, checksum, manifest, pinned_from_revision, created_by)
  values (v_rev, p_grade, v_checksum, v_body || jsonb_build_object('checksum', v_checksum), p_pinned_from, p_actor);
  return v_rev;
end
$$;

create or replace function bnl._close_live(p_lesson_id uuid, p_actor uuid, p_reason text) returns uuid
language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
declare
  v_version uuid;
begin
  update bnl.publication_records set unpublished_at = now(), unpublished_by = p_actor, unpublish_reason = p_reason
    where lesson_id = p_lesson_id and unpublished_at is null
    returning lesson_version_id into v_version;
  if v_version is not null then
    update bnl.lesson_versions set status = 'archived' where id = v_version;
  end if;
  return v_version;
end
$$;

create or replace function bnl._open_live(p_lesson_id uuid, p_version_id uuid, p_actor uuid, p_reason text) returns uuid
language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
declare
  v_id uuid;
begin
  update bnl.lesson_versions set status = 'published', published_at = coalesce(published_at, now()) where id = p_version_id;
  insert into bnl.publication_records (lesson_id, lesson_version_id, published_by, reason)
  values (p_lesson_id, p_version_id, p_actor, p_reason) returning id into v_id;
  return v_id;
end
$$;

create or replace function bnl.publish_lesson_version(p_lesson_id uuid, p_version_id uuid, p_reason text, p_actor uuid)
returns table (manifest_revision bigint, published_at timestamptz)
language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  l bnl.lessons;
  v bnl.lesson_versions;
  v_actor_type text;
  v_prev uuid;
  v_record uuid;
  v_rev bigint;
begin
  v_actor_type := bnl._require_staff_actor(p_actor, 'publisher');
  if p_reason is null or char_length(btrim(p_reason)) = 0 or char_length(p_reason) > 500 then
    raise exception 'bnl: a publish reason (1..500 chars) is required' using errcode = '22023';
  end if;
  select * into l from bnl.lessons where id = p_lesson_id for update;
  if not found then
    raise exception 'bnl: lesson not found' using errcode = 'P0002';
  end if;
  select * into v from bnl.lesson_versions lv where lv.id = p_version_id and lv.lesson_id = p_lesson_id for update;
  if not found then
    raise exception 'bnl: lesson version not found for lesson' using errcode = 'P0002';
  end if;
  if v.status <> 'approved' then
    raise exception 'bnl: only an approved version can be published (status %)', v.status using errcode = '55000';
  end if;
  if jsonb_array_length(bnl.lesson_content_errors(p_lesson_id, v.content)) > 0 then
    raise exception 'bnl: lesson content is invalid' using errcode = '22023';
  end if;
  if (v.content#>'{rights,reviewed}') is distinct from 'true'::jsonb then
    raise exception 'bnl: content rights must be reviewed before publishing' using errcode = '22023';
  end if;

  v_prev := bnl._close_live(p_lesson_id, p_actor, 'superseded');
  v_record := bnl._open_live(p_lesson_id, p_version_id, p_actor, p_reason);
  v_rev := bnl._write_manifest(l.grade, p_actor, null);
  update bnl.publication_records set manifest_revision = v_rev where id = v_record;

  perform bnl._audit(v_actor_type, p_actor, null, 'lesson.publish', 'lesson_version', p_version_id,
    jsonb_build_object('lesson_id', p_lesson_id, 'version_no', v.version_no, 'publication_record_id', v_record,
                       'superseded_version_id', v_prev, 'manifest_revision', v_rev, 'grade', l.grade));
  return query select v_rev, now();
end
$$;

create or replace function bnl.unpublish_lesson(p_lesson_id uuid, p_reason text, p_actor uuid)
returns table (manifest_revision bigint, unpublished_at timestamptz)
language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  l bnl.lessons;
  v_actor_type text;
  v_prev uuid;
  v_rev bigint;
begin
  v_actor_type := bnl._require_staff_actor(p_actor, 'publisher');
  if p_reason is null or char_length(btrim(p_reason)) = 0 or char_length(p_reason) > 500 then
    raise exception 'bnl: an unpublish reason (1..500 chars) is required' using errcode = '22023';
  end if;
  select * into l from bnl.lessons where id = p_lesson_id for update;
  if not found then
    raise exception 'bnl: lesson not found' using errcode = 'P0002';
  end if;
  v_prev := bnl._close_live(p_lesson_id, p_actor, p_reason);
  if v_prev is null then
    raise exception 'bnl: lesson is not published' using errcode = '55000';
  end if;
  v_rev := bnl._write_manifest(l.grade, p_actor, null);
  perform bnl._audit(v_actor_type, p_actor, null, 'lesson.unpublish', 'lesson', p_lesson_id,
    jsonb_build_object('version_id', v_prev, 'manifest_revision', v_rev, 'grade', l.grade));
  return query select v_rev, now();
end
$$;

-- Rollback: make the live set of the manifest's grade equal to an earlier revision, then write a new
-- manifest with pinned_from_revision. Publication records stay consistent with the manifest.
create or replace function bnl.pin_manifest(p_revision bigint, p_actor uuid)
returns table (manifest_revision bigint, pinned_from_revision bigint)
language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  m bnl.published_manifests;
  v_actor_type text;
  r record;
  v_rev bigint;
  v_reason text;
  v_targets jsonb;
begin
  v_actor_type := bnl._require_staff_actor(p_actor, 'publisher');
  select * into m from bnl.published_manifests pm where pm.revision = p_revision;
  if not found then
    raise exception 'bnl: manifest revision not found' using errcode = 'P0002';
  end if;
  v_reason := 'pinned manifest revision ' || p_revision;

  -- Target live set of the pinned revision: (lesson_id, version_id) pairs from its JSON.
  v_targets := coalesce((
    select jsonb_agg(jsonb_build_object('lesson_id', les->>'id', 'version_id', les->>'version_id'))
    from jsonb_array_elements(m.manifest->'subjects') s,
         jsonb_array_elements(s->'topics') t,
         jsonb_array_elements(t->'lessons') les), '[]'::jsonb);

  -- Lock the grade's lessons in a stable order.
  perform 1 from bnl.lessons l where l.grade = m.grade order by l.id for update;

  for r in
    select pr.lesson_id from bnl.publication_records pr join bnl.lessons l on l.id = pr.lesson_id
    where pr.unpublished_at is null and l.grade = m.grade
      and not (v_targets @> jsonb_build_array(jsonb_build_object(
                 'lesson_id', pr.lesson_id::text, 'version_id', pr.lesson_version_id::text)))
  loop
    perform bnl._close_live(r.lesson_id, p_actor, v_reason);
  end loop;

  for r in
    select (x->>'lesson_id')::uuid as lesson_id, (x->>'version_id')::uuid as version_id, v.status
    from jsonb_array_elements(v_targets) x
    left join bnl.lesson_versions v on v.id = (x->>'version_id')::uuid and v.lesson_id = (x->>'lesson_id')::uuid
    where not exists (select 1 from bnl.publication_records pr
                      where pr.lesson_id = (x->>'lesson_id')::uuid
                        and pr.lesson_version_id = (x->>'version_id')::uuid and pr.unpublished_at is null)
  loop
    if r.status is null or r.status not in ('published', 'archived', 'approved') then
      raise exception 'bnl: cannot pin: version % is not publishable', r.version_id using errcode = '55000';
    end if;
    perform bnl._open_live(r.lesson_id, r.version_id, p_actor, v_reason);
  end loop;

  v_rev := bnl._write_manifest(m.grade, p_actor, p_revision);
  update bnl.publication_records set manifest_revision = v_rev
    where unpublished_at is null and manifest_revision is null;
  perform bnl._audit(v_actor_type, p_actor, null, 'manifest.pin', 'published_manifest', null,
    jsonb_build_object('pinned_from_revision', p_revision, 'manifest_revision', v_rev, 'grade', m.grade));
  return query select v_rev, p_revision;
end
$$;

-- Writes a fresh manifest for a grade without changing what is live (bootstrap / cache bust).
create or replace function bnl.refresh_manifest(p_grade integer, p_reason text, p_actor uuid)
returns bigint
language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor_type text;
  v_rev bigint;
begin
  v_actor_type := bnl._require_staff_actor(p_actor, 'publisher');
  if p_grade not in (2, 6) then
    raise exception 'bnl: unknown grade' using errcode = '22023';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) = 0 or char_length(p_reason) > 500 then
    raise exception 'bnl: a reason (1..500 chars) is required' using errcode = '22023';
  end if;
  v_rev := bnl._write_manifest(p_grade::smallint, p_actor, null);
  perform bnl._audit(v_actor_type, p_actor, null, 'manifest.refresh', 'published_manifest', null,
    jsonb_build_object('manifest_revision', v_rev, 'grade', p_grade));
  return v_rev;
end
$$;

-- ---------------------------------------------------------------------------
-- Assessment helpers for the device role (answer keys never leave the server)
-- ---------------------------------------------------------------------------
create or replace function bnl.quiz_questions_for_version(p_lesson_version_id uuid)
returns table (question_version_key text, outcome_key text, stage_eligibility text[], prompt text, options jsonb, sort_order integer)
language plpgsql stable security definer set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
begin
  if not bnl.device_ok() then
    raise exception 'bnl: device not authorized' using errcode = '42501';
  end if;
  if not bnl.version_was_published(p_lesson_version_id) then
    raise exception 'bnl: lesson version not found' using errcode = 'P0002';
  end if;
  return query
    select q.question_version_key, q.outcome_key, q.stage_eligibility, q.prompt, q.options, q.sort_order
    from bnl.quiz_items q where q.lesson_version_id = p_lesson_version_id
    order by q.sort_order, q.question_version_key;
end
$$;

-- Scores one answer server-side and records it (idempotent per attempt+question). TEL-005.
create or replace function bnl.score_answer(p_attempt_id uuid, p_question_version_key text, p_selected_option_id text,
  p_response_ms integer default null)
returns table (correct boolean, correct_option_id text, already_answered boolean)
language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  a bnl.assessment_attempts;
  q bnl.quiz_items;
  prior bnl.question_responses;
  v_correct boolean;
begin
  if not bnl.device_ok() then
    raise exception 'bnl: device not authorized' using errcode = '42501';
  end if;
  select * into a from bnl.assessment_attempts aa
    where aa.id = p_attempt_id and aa.household_id = bnl.current_household_id();
  if not found then
    raise exception 'bnl: attempt not found' using errcode = 'P0002';
  end if;
  select * into q from bnl.quiz_items qi
    where qi.question_version_key = p_question_version_key and qi.lesson_version_id = a.lesson_version_id;
  if not found then
    raise exception 'bnl: question not found for attempt' using errcode = 'P0002';
  end if;
  if jsonb_array_length(a.question_keys) > 0 and not (a.question_keys ? p_question_version_key) then
    raise exception 'bnl: question is not part of this attempt' using errcode = '22023';
  end if;

  select * into prior from bnl.question_responses qr
    where qr.attempt_id = a.id and qr.question_version_key = p_question_version_key;
  if found then
    return query select prior.correct, q.correct_option_id, true;
    return;
  end if;
  if a.finished_at is not null then
    raise exception 'bnl: attempt already finished' using errcode = '55000';
  end if;
  if not (q.options @> jsonb_build_array(jsonb_build_object('id', p_selected_option_id))) then
    raise exception 'bnl: unknown option' using errcode = '22023';
  end if;

  v_correct := (p_selected_option_id = q.correct_option_id);
  insert into bnl.question_responses (household_id, attempt_id, learner_id, question_version_key, selected_option_id,
    correct, response_ms)
  values (a.household_id, a.id, a.learner_id, p_question_version_key, p_selected_option_id, v_correct, p_response_ms);
  return query select v_correct, q.correct_option_id, false;
end
$$;

-- ---------------------------------------------------------------------------
-- Households and devices (pairing per ADR-0002 P1/P2). Hashes are sha256 hex computed by the BFF.
-- ---------------------------------------------------------------------------
create or replace function bnl.create_household(p_label text, p_timezone text default 'Asia/Kolkata') returns uuid
language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid := bnl.current_actor_id();
  v_id uuid;
begin
  if v_actor is null then
    raise exception 'bnl: adult session required' using errcode = '42501';
  end if;
  insert into bnl.households (label, timezone, created_by) values (p_label, coalesce(p_timezone, 'Asia/Kolkata'), v_actor)
    returning id into v_id;
  insert into bnl.household_memberships (household_id, auth_user_id, role, invited_by) values (v_id, v_actor, 'owner', v_actor);
  perform bnl._audit('user', v_actor, v_id, 'household.create', 'household', v_id, '{}'::jsonb);
  return v_id;
end
$$;

-- TV: unauthenticated. Registers a pending pairing (TTL capped at 15 minutes).
create or replace function bnl.create_pairing_code(p_pairing_id uuid, p_code_hash text, p_poll_secret_hash text,
  p_expires_at timestamptz) returns void
language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
begin
  if p_expires_at <= now() or p_expires_at > now() + interval '15 minutes' then
    raise exception 'bnl: invalid pairing expiry' using errcode = '22023';
  end if;
  insert into bnl.device_pairing_codes (pairing_id, code_hash, poll_secret_hash, expires_at)
  values (p_pairing_id, p_code_hash, p_poll_secret_hash, p_expires_at);
end
$$;

-- Guardian/owner approves a code for one of their households. Zero rows = unknown/expired/used code.
create or replace function bnl.approve_pairing(p_code_hash text, p_household_id uuid, p_device_label text)
returns table (pairing_id uuid, device_id uuid)
language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := bnl.current_actor_id();
  c bnl.device_pairing_codes;
  v_device uuid;
begin
  if v_actor is null or p_household_id not in (select bnl.adult_household_ids()) then
    raise exception 'bnl: not a member of this household' using errcode = '42501';
  end if;
  select * into c from bnl.device_pairing_codes dpc
    where dpc.code_hash = p_code_hash and dpc.approved_at is null and dpc.redeemed_at is null
      and dpc.expires_at > now() and dpc.failed_attempts < 5
    for update;
  if not found then
    return;
  end if;
  insert into bnl.paired_devices (household_id, label, approved_by) values (p_household_id, p_device_label, v_actor)
    returning id into v_device;
  update bnl.device_pairing_codes set household_id = p_household_id, approved_by = v_actor, approved_at = now(),
    device_id = v_device where id = c.id;
  perform bnl._audit('user', v_actor, p_household_id, 'device.pair_approved', 'paired_device', v_device, '{}'::jsonb);
  return query select c.pairing_id, v_device;
end
$$;

-- TV polls with its secret. status: pending | redeemed (first success only) | invalid_secret | gone.
create or replace function bnl.redeem_pairing(p_pairing_id uuid, p_poll_secret_hash text, p_refresh_token_hash text)
returns table (status text, device_id uuid, household_id uuid, token_version integer)
language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  c bnl.device_pairing_codes;
  v_version integer;
begin
  select * into c from bnl.device_pairing_codes dpc where dpc.pairing_id = p_pairing_id for update;
  if not found or c.redeemed_at is not null or c.failed_attempts >= 5 then
    return query select 'gone'::text, null::uuid, null::uuid, null::integer;
    return;
  end if;
  if c.poll_secret_hash <> p_poll_secret_hash then
    update bnl.device_pairing_codes set failed_attempts = failed_attempts + 1 where id = c.id;
    return query select 'invalid_secret'::text, null::uuid, null::uuid, null::integer;
    return;
  end if;
  if c.approved_at is null then
    if c.expires_at <= now() then
      return query select 'gone'::text, null::uuid, null::uuid, null::integer;
    else
      return query select 'pending'::text, null::uuid, null::uuid, null::integer;
    end if;
    return;
  end if;
  if c.expires_at <= now() and c.approved_at <= now() - interval '10 minutes' then
    return query select 'gone'::text, null::uuid, null::uuid, null::integer;
    return;
  end if;
  update bnl.paired_devices pd set refresh_token_hash = p_refresh_token_hash, refresh_rotated_at = now()
    where pd.id = c.device_id and pd.revoked_at is null
    returning pd.token_version into v_version;
  if v_version is null then
    return query select 'gone'::text, null::uuid, null::uuid, null::integer;
    return;
  end if;
  update bnl.device_pairing_codes set redeemed_at = now() where id = c.id;
  perform bnl._audit('device', c.device_id, c.household_id, 'device.paired', 'paired_device', c.device_id, '{}'::jsonb);
  return query select 'redeemed'::text, c.device_id, c.household_id, v_version;
end
$$;

-- Refresh-token rotation (unauthenticated: the refresh token is the credential). Zero rows = invalid.
create or replace function bnl.rotate_device_refresh(p_old_hash text, p_new_hash text)
returns table (device_id uuid, household_id uuid, token_version integer)
language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
begin
  return query
    with u as (
      update bnl.paired_devices pd set refresh_token_hash = p_new_hash, refresh_rotated_at = now()
      where pd.refresh_token_hash = p_old_hash and pd.revoked_at is null
      returning pd.id, pd.household_id, pd.token_version)
    select u.id, u.household_id, u.token_version from u;
end
$$;

-- Device heartbeat: returns current token_version (null when revoked/unknown) for the `ver` claim check.
create or replace function bnl.touch_device() returns integer
language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
declare
  v_version integer;
begin
  update bnl.paired_devices set last_seen_at = now()
    where id = bnl.current_device_id() and household_id = bnl.current_household_id() and revoked_at is null
    returning token_version into v_version;
  return v_version;
end
$$;

create or replace function bnl.revoke_device(p_device_id uuid) returns boolean
language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid := bnl.current_actor_id();
  v_household uuid;
begin
  update bnl.paired_devices set revoked_at = now(), token_version = token_version + 1, refresh_token_hash = null
    where id = p_device_id and revoked_at is null and household_id in (select bnl.adult_household_ids())
    returning household_id into v_household;
  if v_household is null then
    return false;
  end if;
  perform bnl._audit('user', v_actor, v_household, 'device.revoke', 'paired_device', p_device_id, '{}'::jsonb);
  return true;
end
$$;

-- Fixed-window rate limiter over bnl.rate_limit_buckets(key, window_start, window_seconds, count).
-- Returns true when the call is allowed. Keys should be hashed (no raw IPs/emails).
create or replace function bnl.rate_limit_hit(p_key text, p_window_seconds integer, p_max_hits integer) returns boolean
language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
declare
  v_count integer;
  v_window timestamptz;
begin
  if p_window_seconds < 1 or p_max_hits < 1 then
    raise exception 'bnl: invalid rate limit' using errcode = '22023';
  end if;
  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into bnl.rate_limit_buckets as b (key, window_start, window_seconds, count)
  values (p_key, v_window, p_window_seconds, 1)
  on conflict (key, window_start) do update set count = b.count + 1
  returning b.count into v_count;
  return v_count <= p_max_hits;
end
$$;

-- Retention (defaults pending owner: raw events 90 d, aggregates 395 d). Audited; idempotent.
create or replace function bnl.purge_expired(p_raw_days integer default 90, p_aggregate_days integer default 395) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
declare
  v_events bigint;
  v_snapshots bigint;
  v_recs bigint;
  v_idem bigint;
  v_codes bigint;
  v_buckets bigint;
  v_result jsonb;
begin
  if p_raw_days < 1 or p_aggregate_days < p_raw_days then
    raise exception 'bnl: invalid retention window' using errcode = '22023';
  end if;
  delete from bnl.learning_events where received_at < now() - make_interval(days => p_raw_days);
  get diagnostics v_events = row_count;
  delete from bnl.mastery_snapshots where computed_at < now() - make_interval(days => p_aggregate_days);
  get diagnostics v_snapshots = row_count;
  delete from bnl.recommendations where computed_at < now() - make_interval(days => p_aggregate_days);
  get diagnostics v_recs = row_count;
  delete from bnl.idempotency_keys where expires_at < now();
  get diagnostics v_idem = row_count;
  delete from bnl.device_pairing_codes where expires_at < now() - interval '1 day';
  get diagnostics v_codes = row_count;
  delete from bnl.rate_limit_buckets where window_start + make_interval(secs => window_seconds) < now() - interval '1 day';
  get diagnostics v_buckets = row_count;
  v_result := jsonb_build_object('learning_events', v_events, 'mastery_snapshots', v_snapshots,
    'recommendations', v_recs, 'idempotency_keys', v_idem, 'device_pairing_codes', v_codes,
    'rate_limit_buckets', v_buckets, 'raw_days', p_raw_days, 'aggregate_days', p_aggregate_days);
  insert into bnl.job_runs (job_name, run_key, status, result, finished_at)
  values ('retention_purge', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), 'succeeded', v_result, now())
  on conflict (job_name, run_key) do nothing;
  perform bnl._audit('job', null, null, 'retention.purge', 'job_run', null, v_result);
  return v_result;
end
$$;

-- ---------------------------------------------------------------------------
-- Ownership and EXECUTE grants (default: nobody)
-- ---------------------------------------------------------------------------
do $own$
declare
  f text;
begin
  foreach f in array array[
    'bnl._is_ops_session()', 'bnl._require_staff_actor(uuid,text)', 'bnl.lesson_content_errors(uuid,jsonb)',
    'bnl._audit(text,uuid,uuid,text,text,uuid,jsonb)', 'bnl.transition_lesson_version(uuid,text,uuid,text)',
    'bnl._build_manifest_subjects(smallint)', 'bnl._write_manifest(smallint,uuid,bigint)',
    'bnl._close_live(uuid,uuid,text)', 'bnl._open_live(uuid,uuid,uuid,text)',
    'bnl.publish_lesson_version(uuid,uuid,text,uuid)', 'bnl.unpublish_lesson(uuid,text,uuid)',
    'bnl.pin_manifest(bigint,uuid)', 'bnl.refresh_manifest(integer,text,uuid)',
    'bnl.quiz_questions_for_version(uuid)', 'bnl.score_answer(uuid,text,text,integer)',
    'bnl.create_household(text,text)', 'bnl.create_pairing_code(uuid,text,text,timestamptz)',
    'bnl.approve_pairing(text,uuid,text)', 'bnl.redeem_pairing(uuid,text,text)',
    'bnl.rotate_device_refresh(text,text)', 'bnl.touch_device()', 'bnl.revoke_device(uuid)',
    'bnl.rate_limit_hit(text,integer,integer)', 'bnl.purge_expired(integer,integer)'
  ] loop
    execute format('alter function %s owner to bnl_owner', f);
    execute format('revoke all on function %s from public', f);
  end loop;
end
$own$;

grant execute on function bnl.transition_lesson_version(uuid, text, uuid, text), bnl.publish_lesson_version(uuid, uuid, text, uuid),
  bnl.unpublish_lesson(uuid, text, uuid), bnl.pin_manifest(bigint, uuid), bnl.refresh_manifest(integer, text, uuid),
  bnl.lesson_content_errors(uuid, jsonb)
  to bnl_staff;
grant execute on function bnl.quiz_questions_for_version(uuid), bnl.score_answer(uuid, text, text, integer), bnl.touch_device()
  to bnl_device;
grant execute on function bnl.create_household(text, text), bnl.approve_pairing(text, uuid, text), bnl.revoke_device(uuid)
  to bnl_adult;
grant execute on function bnl.create_pairing_code(uuid, text, text, timestamptz), bnl.redeem_pairing(uuid, text, text),
  bnl.rotate_device_refresh(text, text)
  to bnl_public;
grant execute on function bnl.rate_limit_hit(text, integer, integer) to bnl_public, bnl_device, bnl_adult, bnl_staff;
grant execute on function bnl.purge_expired(integer, integer) to bnl_job;

-- Final sweep (every migration ends with this): nothing in bnl is reachable by PUBLIC/anon/authenticated.
revoke all on all tables in schema bnl from public, anon, authenticated;
revoke all on all sequences in schema bnl from public, anon, authenticated;
revoke all on all functions in schema bnl from public, anon, authenticated;
