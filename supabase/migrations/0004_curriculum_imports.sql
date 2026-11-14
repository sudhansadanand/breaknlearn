-- BreakNLearn 0004 (A3, P2): additive guards for curriculum review and school-syllabus imports.
-- No new tables, no widened grants. Re-runnable (create or replace / if not exists / drop trigger if exists).
--
-- 1. CAT-010: one upload per (school plan, file checksum), so concurrent duplicate imports cannot
--    stage a second copy of the same chapters.
-- 2. M03: approved chapter→topic mappings are immutable for request roles; a decision made by an adult
--    must carry that adult as reviewer (no forged reviewer ids).
-- 3. CAT-006: on top of 0002's verify guard, only a reviewer may change a node's authority, and
--    cisce_verified requires review_status = 'verified' (the table check already requires a source + ref).

create unique index if not exists uq_syllabus_uploads_plan_sha on bnl.syllabus_uploads(school_plan_id, sha256);

create or replace function bnl.tg_mapping_decision_guard() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp
as $$
begin
  -- Owner/ops/job sessions (migrations, retention, household deletion cascades) are not restricted here.
  if current_user not in ('bnl_adult', 'bnl_staff', 'bnl_device', 'bnl_public') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op in ('UPDATE', 'DELETE') and old.state = 'approved' then
    raise exception 'bnl: approved mappings are immutable' using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if tg_op = 'UPDATE' and (new.chapter_id is distinct from old.chapter_id
      or new.curriculum_node_id is distinct from old.curriculum_node_id
      or new.household_id is distinct from old.household_id) then
    raise exception 'bnl: a mapping''s chapter, topic and household cannot change' using errcode = '55000';
  end if;
  if new.state <> 'suggested' and new.reviewer_auth_id is distinct from bnl.current_actor_id() then
    raise exception 'bnl: the reviewer of a mapping decision must be the caller' using errcode = '42501';
  end if;
  return new;
end
$$;
drop trigger if exists mapping_decision_guard on bnl.chapter_topic_mappings;
create trigger mapping_decision_guard before insert or update or delete on bnl.chapter_topic_mappings
  for each row execute function bnl.tg_mapping_decision_guard();

create or replace function bnl.tg_curriculum_authority_guard() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp
as $$
begin
  if current_user = 'bnl_staff'
     and ((tg_op = 'UPDATE' and new.authority is distinct from old.authority)
          or (tg_op = 'INSERT' and new.authority = 'cisce_verified'))
     and not bnl.has_staff_role('reviewer') then
    raise exception 'bnl: only a reviewer can change curriculum authority' using errcode = '42501';
  end if;
  if new.authority = 'cisce_verified' and new.review_status not in ('verified', 'archived') then
    raise exception 'bnl: cisce_verified requires review_status verified' using errcode = '22023';
  end if;
  return new;
end
$$;
drop trigger if exists curriculum_authority_guard on bnl.curriculum_nodes;
create trigger curriculum_authority_guard before insert or update on bnl.curriculum_nodes
  for each row execute function bnl.tg_curriculum_authority_guard();

-- Final sweep (every migration ends with this).
revoke all on all tables in schema bnl from public, anon, authenticated;
revoke all on all sequences in schema bnl from public, anon, authenticated;
revoke all on all functions in schema bnl from public, anon, authenticated;
