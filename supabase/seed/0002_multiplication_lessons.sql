-- Core seed (all environments): the ten live Grade 2 multiplication lessons (ADR-0004), their item bank,
-- and the initial manifests. Lessons are approved and published through the audited workflow functions
-- by the non-login 'system' actor (allowed only from an operations session, never via bnl_app).
-- Re-runnable: rows use fixed ids and every step is skipped when already done.
-- Result: exactly ten live lessons (CAT-005); manifests for grade 2 and grade 6 (grade 6: all stubs).

do $seed$
declare
  ns constant uuid := '6f1d2a0e-6b1e-4a35-9a4e-2f6c3b8d9e10';     -- UUID_NAMESPACE
  sys constant uuid := bnl.system_actor_id();
  topic_key constant text := 'grade2.math.multiplication';         -- MULTIPLICATION_TOPIC_KEY
  topic_id constant uuid := '58be84d6-b23e-5332-80a7-f7460dd3933f'; -- MULTIPLICATION_TOPIC_ID
  expected constant uuid[] := array[                                 -- MULTIPLICATION_LESSON_IDS[1..10]
    '02402664-c8e7-5408-ab92-292f6e20a308', '6a7999d7-caba-5778-87b0-34529b85fdb4',
    'f95143b0-7b4c-5452-8a3f-71096a538dff', '6dcc8a5d-23c4-5a87-8871-17db135101c5',
    'e13f93ea-9d02-5a12-bf91-b4fc6554f5a9', '34ed2bc4-a121-5847-998d-d5d7c227252a',
    '2b0028d9-dd24-5020-84f7-c75af77b7b39', 'e2e6e8a9-7da3-540b-a802-346b53f12270',
    'a43a1ef5-01d2-5b95-bb56-868c672e70a0', 'c888722d-7b0f-5dc2-b371-41b47d542367']::uuid[];
  n int;
  m int;
  a int;
  lesson_key text;
  lesson_id uuid;
  version_id uuid;
  cand int;
  distractors int[];
  opts jsonb;
  values_in_order int[];
  correct_pos int;
  i int;
  ids constant text[] := array['a', 'b', 'c', 'd'];
  v_status text;
begin
  if bnl.uuid_v5(ns, topic_key) <> topic_id then
    raise exception 'seed: uuid_v5 does not reproduce MULTIPLICATION_TOPIC_ID';
  end if;

  for n in 1..10 loop
    lesson_key := topic_key || '.table-' || n;
    lesson_id := bnl.uuid_v5(ns, lesson_key);
    if lesson_id <> expected[n] then
      raise exception 'seed: lesson id for % does not match @bnl/contracts', lesson_key;
    end if;
    version_id := bnl.uuid_v5(ns, lesson_key || '@v1');

    insert into bnl.lessons (id, stable_key, grade, subject_key, topic_id, title, template_key, sort_order)
    values (lesson_id, lesson_key, 2, 'math', topic_id, n || ' Times Table', 'picture_groups_v1', n)
    on conflict (id) do nothing;

    insert into bnl.lesson_versions (id, lesson_id, version_no, content, status)
    values (version_id, lesson_id, 1, jsonb_build_object(
      'contract_version', 1,
      'stable_key', lesson_key,
      'grade', 2,
      'subject_key', 'math',
      'topic_key', topic_key,
      'title', n || ' Times Table',
      'template', 'picture_groups_v1',
      'config', jsonb_build_object(
        'factor', n, 'count_from', 1, 'count_to', 10,
        'themes', jsonb_build_array('puppy', 'candy', 'unicorn', 'school', 'treat', 'farm'),
        'seconds_per_slide', 7, 'quiz_question_count', 3),
      'learning_outcome_keys', jsonb_build_array(topic_key),
      'rights', jsonb_build_object('type', 'original_generated_content', 'reviewed', true)), 'draft')
    on conflict (id) do nothing;

    insert into bnl.lesson_outcomes (lesson_id, outcome_id)
    select lesson_id, o.id from bnl.learning_outcomes o where o.stable_key = topic_key
    on conflict do nothing;

    select status into v_status from bnl.lesson_versions where id = version_id;
    if v_status = 'draft' then
      -- Item bank: every fact n x m (m = 1..10), 4 distinct positive options, exactly one correct.
      for m in 1..10 loop
        a := n * m;
        distractors := array[]::int[];
        foreach cand in array array[a + n, a - n, a + 1, a - 1, a + 2, a - 2, a + n + 1, a + 3, a + 4, a + 5] loop
          if cand > 0 and cand <> a and not (cand = any(distractors)) and cardinality(distractors) < 3 then
            distractors := distractors || cand;
          end if;
        end loop;
        correct_pos := ((n + m) % 4) + 1;
        values_in_order := distractors[1:correct_pos - 1] || a || distractors[correct_pos:3];
        opts := '[]'::jsonb;
        for i in 1..4 loop
          opts := opts || jsonb_build_array(jsonb_build_object('id', ids[i], 'label', values_in_order[i]::text));
        end loop;
        insert into bnl.quiz_items (lesson_version_id, question_version_key, outcome_key, stage_eligibility, prompt,
          options, correct_option_id, sort_order)
        values (version_id, lesson_key || '.fact-' || m || '.v1', topic_key,
          array['baseline', 'immediate', 'delayed'], n || ' × ' || m || ' = ?', opts, ids[correct_pos], m)
        on conflict (question_version_key) do nothing;
      end loop;

      perform bnl.transition_lesson_version(version_id, 'submit', sys, 'Seed: legacy live lesson');
      perform bnl.transition_lesson_version(version_id, 'approve', sys, 'Seed: matches live app behaviour');
      v_status := 'approved';
    end if;
    if v_status = 'approved' then
      perform bnl.publish_lesson_version(lesson_id, version_id, 'Initial launch: existing live multiplication table', sys);
    end if;
  end loop;

  if not exists (select 1 from bnl.published_manifests where grade = 6) then
    perform bnl.refresh_manifest(6, 'Initial grade 6 catalog: every subject is coming soon', sys);
  end if;

  if (select count(*) from bnl.publication_records where unpublished_at is null) <> 10 then
    raise exception 'seed: expected exactly ten live lessons';
  end if;
end
$seed$;
