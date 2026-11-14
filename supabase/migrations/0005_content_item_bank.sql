-- BreakNLearn 0005 (A4, CMS): item-bank backstop for picture_groups_v1 versions.
--
-- The BFF generates bnl.quiz_items with @bnl/lesson-engine (`bankItemsForContent`) while a version is
-- still a draft (editors may write items only for drafts). This trigger guarantees that EVERY version
-- that reaches approved/published also has items (P4 assessments depend on it), including versions
-- created outside the BFF. It only fills a version that has no items, using the same scheme as
-- supabase/seed/0002_multiplication_lessons.sql and lesson-engine (asserted by integration tests):
--   key `<stable_key>.fact-<m>.v<version_no>`, prompt `n × m = ?`, options a..d, one correct.
-- Additive and re-runnable; does not change any 0001-0003 object.

create or replace function bnl.generate_picture_groups_items(p_version_id uuid) returns integer
language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
declare
  v bnl.lesson_versions;
  l bnl.lessons;
  c jsonb;
  n int;
  m int;
  a int;
  v_from int;
  v_to int;
  cand int;
  distractors int[];
  vals int[];
  opts jsonb;
  correct_pos int;
  i int;
  ids constant text[] := array['a', 'b', 'c', 'd'];
  v_outcome text;
  v_count int := 0;
begin
  select * into v from bnl.lesson_versions where id = p_version_id;
  if not found then
    raise exception 'bnl: lesson version not found' using errcode = 'P0002';
  end if;
  select * into l from bnl.lessons where id = v.lesson_id;
  if l.template_key <> 'picture_groups_v1' then
    return 0;
  end if;
  if exists (select 1 from bnl.quiz_items q where q.lesson_version_id = p_version_id) then
    return 0;
  end if;
  c := v.content->'config';
  if jsonb_typeof(c->'factor') is distinct from 'number' then
    raise exception 'bnl: picture_groups_v1 version % has no factor; cannot build its item bank', p_version_id
      using errcode = '22023';
  end if;
  n := (c->>'factor')::int;
  v_from := coalesce((c->>'count_from')::int, 1);
  v_to := coalesce((c->>'count_to')::int, 10);
  if n not between 1 and 10 or v_from not between 1 and 10 or v_to not between v_from and 10 then
    raise exception 'bnl: picture_groups_v1 version % has an invalid config; cannot build its item bank', p_version_id
      using errcode = '22023';
  end if;
  v_outcome := coalesce(v.content->'learning_outcome_keys'->>0, v.content->>'topic_key', l.stable_key);

  for m in v_from..v_to loop
    a := n * m;
    distractors := array[]::int[];
    foreach cand in array array[a + n, a - n, a + 1, a - 1, a + 2, a - 2, a + n + 1, a + 3, a + 4, a + 5] loop
      if cand > 0 and cand <> a and not (cand = any(distractors)) and cardinality(distractors) < 3 then
        distractors := distractors || cand;
      end if;
    end loop;
    correct_pos := ((n + m) % 4) + 1;
    vals := distractors[1:correct_pos - 1] || a || distractors[correct_pos:3];
    opts := '[]'::jsonb;
    for i in 1..4 loop
      opts := opts || jsonb_build_array(jsonb_build_object('id', ids[i], 'label', vals[i]::text));
    end loop;
    insert into bnl.quiz_items (lesson_version_id, question_version_key, outcome_key, stage_eligibility, prompt,
      options, correct_option_id, sort_order)
    values (p_version_id, l.stable_key || '.fact-' || m || '.v' || v.version_no, v_outcome,
      array['baseline', 'immediate', 'delayed'], n || ' × ' || m || ' = ?', opts, ids[correct_pos], m);
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;

create or replace function bnl.tg_lesson_versions_item_bank() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
begin
  perform bnl.generate_picture_groups_items(new.id);
  return null;
end
$$;

drop trigger if exists lesson_versions_item_bank on bnl.lesson_versions;
create trigger lesson_versions_item_bank after update of status on bnl.lesson_versions
  for each row when (new.status in ('approved', 'published') and old.status is distinct from new.status)
  execute function bnl.tg_lesson_versions_item_bank();

alter function bnl.generate_picture_groups_items(uuid) owner to bnl_owner;
alter function bnl.tg_lesson_versions_item_bank() owner to bnl_owner;
revoke all on function bnl.generate_picture_groups_items(uuid) from public;
revoke all on function bnl.tg_lesson_versions_item_bank() from public;

-- Final sweep (every migration ends with this): nothing in bnl is reachable by PUBLIC/anon/authenticated.
revoke all on all tables in schema bnl from public, anon, authenticated;
revoke all on all sequences in schema bnl from public, anon, authenticated;
revoke all on all functions in schema bnl from public, anon, authenticated;
