import {
  GRADE_SUBJECTS, INITIAL_PUBLISHED_LESSON_KEYS, LessonContent, MULTIPLICATION_LESSON_IDS, MULTIPLICATION_TOPIC_ID,
  PictureGroupsConfig, PublishedManifest, QuizItem, WORLDS,
} from "@bnl/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { withDbContext } from "../../src/index";
import { HH_A, LEARNER_A1, MULT_TABLE_7, deviceA, deviceB } from "../fixtures";
import { admin, closeAll, db, expectSqlState, rolledBack } from "./helpers";

afterAll(closeAll);

const LESSON_IDS = Object.values(MULTIPLICATION_LESSON_IDS);

async function latestManifest(grade: 2 | 6) {
  const [row] = await admin<{ revision: string; checksum: string; manifest: unknown; ok: boolean }[]>`
    select revision, checksum, manifest, bnl.sha256_hex((manifest - 'checksum')::text) = checksum as ok
    from bnl.published_manifests where grade = ${grade} order by revision desc limit 1`;
  if (!row) throw new Error(`no manifest for grade ${grade}`);
  return { ...row, parsed: PublishedManifest.parse(row.manifest) };
}

describe("CAT-005 initial catalog", () => {
  it("exactly the ten multiplication lessons are live, with the contract ids", async () => {
    const live = await admin<{ id: string; stable_key: string; status: string }[]>`
      select l.id, l.stable_key, v.status from bnl.publication_records p
      join bnl.lessons l on l.id = p.lesson_id join bnl.lesson_versions v on v.id = p.lesson_version_id
      where p.unpublished_at is null order by l.sort_order`;
    expect(live.map((l) => l.id)).toEqual(LESSON_IDS);
    expect(live.map((l) => l.stable_key)).toEqual(INITIAL_PUBLISHED_LESSON_KEYS);
    expect(new Set(live.map((l) => l.status))).toEqual(new Set(["published"]));
  });

  it("grade 6 manifest is all non-playable stubs in GRADE_SUBJECTS order", async () => {
    const m = await latestManifest(6);
    expect(m.ok).toBe(true);
    expect(m.parsed.grade).toBe(6);
    expect(m.parsed.subjects.map((s) => s.key)).toEqual(GRADE_SUBJECTS[6].map((s) => s.key));
    expect(m.parsed.subjects.map((s) => s.label)).toEqual(GRADE_SUBJECTS[6].map((s) => s.label));
    expect(m.parsed.subjects.every((s) => !s.playable && s.topics.length === 0)).toBe(true);
  });

  it("grade 2 manifest has only Math playable with the ten tables in order", async () => {
    const m = await latestManifest(2);
    expect(m.ok).toBe(true);
    expect(m.parsed.checksum).toBe(m.checksum);
    expect(String(m.parsed.revision)).toBe(String(m.revision));
    expect(m.parsed.subjects.map((s) => s.key)).toEqual(GRADE_SUBJECTS[2].map((s) => s.key));
    expect(m.parsed.subjects.filter((s) => s.playable).map((s) => s.key)).toEqual(["math"]);
    const math = m.parsed.subjects.find((s) => s.key === "math");
    expect(math?.topics).toHaveLength(1);
    expect(math?.topics[0]?.id).toBe(MULTIPLICATION_TOPIC_ID);
    expect(math?.topics[0]?.key).toBe("grade2.math.multiplication");
    const lessons = math?.topics[0]?.lessons ?? [];
    expect(lessons.map((l) => l.id)).toEqual(LESSON_IDS);
    expect(lessons.map((l) => l.title)).toEqual(LESSON_IDS.map((_, i) => `${i + 1} Times Table`));
    expect(lessons.every((l) => l.template_key === "picture_groups_v1" && l.version_no === 1)).toBe(true);
  });

  it("published content validates against LessonContent and ADR-0004", async () => {
    await withDbContext(db, { kind: "public" }, async (sql) => {
      const rows = await sql<{ lesson_id: string; content: unknown }[]>`select lesson_id, content from bnl.lesson_versions`;
      expect(rows).toHaveLength(10);
      for (const r of rows) {
        const c = LessonContent.parse(r.content);
        const cfg = PictureGroupsConfig.parse(c.config);
        expect(cfg.factor).toBe(LESSON_IDS.indexOf(r.lesson_id) + 1);
        expect(cfg.themes).toEqual(WORLDS.map((w) => w.key));
        expect(cfg.seconds_per_slide).toBe(7);
        expect(cfg.quiz_question_count).toBe(3);
        expect(c.learning_outcome_keys).toEqual(["grade2.math.multiplication"]);
        expect(c.rights).toEqual({ type: "original_generated_content", reviewed: true });
        expect(JSON.stringify(r.content)).not.toContain("correct_option_id");
      }
    });
  });

  it("curriculum: grade subjects match the contract; 80 editorial topics stay draft", async () => {
    const subjects = await admin<{ grade: number; subject_key: string; label: string; icon: string; authority: string }[]>`
      select grade, subject_key, label, icon, authority from bnl.grade_subjects order by grade, sort_order`;
    const expected = ([2, 6] as const).flatMap((g) =>
      GRADE_SUBJECTS[g].map((s) => ({ grade: g, subject_key: s.key, label: s.label, icon: s.icon, authority: s.authority })));
    expect(subjects).toEqual(expected);

    const topics = await admin<{ authority: string; review_status: string; n: number }[]>`
      select authority, review_status, count(*)::int as n from bnl.curriculum_nodes where node_type = 'topic'
      group by 1, 2`;
    expect(topics).toEqual([{ authority: "editorial_unverified", review_status: "draft", n: 80 }]);
    const subjectNodes = await admin<{ subject_key: string; grade: number; authority: string }[]>`
      select subject_key, grade, authority from bnl.curriculum_nodes where node_type = 'subject'`;
    expect(subjectNodes).toHaveLength(19);
    for (const n of subjectNodes) {
      const def = GRADE_SUBJECTS[n.grade as 2 | 6].find((s) => s.key === n.subject_key);
      expect(n.authority).toBe(def?.authority === "local_enrichment" ? "local_enrichment" : "editorial_unverified");
    }
  });

  it("publication was done by the audited system actor", async () => {
    const rows = await admin<{ n: number }[]>`
      select count(*)::int as n from bnl.audit_logs
      where action = 'lesson.publish' and actor_type = 'system' and actor_auth_id is null`;
    expect(rows[0]?.n).toBe(10);
  });
});

describe("item bank and server-side scoring", () => {
  it("each lesson has all ten facts with four unique positive options and one correct answer", async () => {
    const items = await admin<{ lesson_id: string; question_version_key: string; outcome_key: string;
      stage_eligibility: string[]; prompt: string; options: { id: string; label: string }[]; correct_option_id: string }[]>`
      select v.lesson_id, q.question_version_key, q.outcome_key, q.stage_eligibility, q.prompt, q.options, q.correct_option_id
      from bnl.quiz_items q join bnl.lesson_versions v on v.id = q.lesson_version_id
      where v.status = 'published' order by v.lesson_id, q.sort_order`;
    expect(items).toHaveLength(100);
    for (const item of items) {
      QuizItem.parse(item);
      const n = LESSON_IDS.indexOf(item.lesson_id) + 1;
      const m = Number(/fact-(\d+)\.v1$/.exec(item.question_version_key)?.[1]);
      expect(item.prompt).toBe(`${n} × ${m} = ?`);
      expect(item.options).toHaveLength(4);
      const labels = item.options.map((o) => Number(o.label));
      expect(new Set(labels).size).toBe(4);
      expect(labels.every((x) => Number.isInteger(x) && x > 0)).toBe(true);
      const correct = item.options.filter((o) => Number(o.label) === n * m);
      expect(correct).toHaveLength(1);
      expect(correct[0]?.id).toBe(item.correct_option_id);
      expect([...item.stage_eligibility].sort()).toEqual(["baseline", "delayed", "immediate"]);
    }
  });

  it("score_answer scores against the server key; devices cannot read quiz_items", async () => {
    const [v] = await admin<{ id: string }[]>`
      select lesson_version_id as id from bnl.publication_records where lesson_id = ${MULT_TABLE_7} and unpublished_at is null`;
    const [key] = await admin<{ correct_option_id: string }[]>`
      select correct_option_id from bnl.quiz_items where question_version_key = 'grade2.math.multiplication.table-7.fact-3.v1'`;
    const wrong = ["a", "b", "c", "d"].find((x) => x !== key?.correct_option_id) ?? "a";

    await rolledBack(deviceA, async (sql) => {
      await expectSqlState(sql, "42501", (sp) => sp`select correct_option_id from bnl.quiz_items limit 1`);
      await expectSqlState(sql, "42501", (sp) =>
        sp`insert into bnl.question_responses (household_id, attempt_id, learner_id, question_version_key, selected_option_id, correct)
           values (${HH_A}, gen_random_uuid(), ${LEARNER_A1}, 'k', 'a', true)`);

      const questions = await sql<Record<string, unknown>[]>`select * from bnl.quiz_questions_for_version(${v!.id})`;
      expect(questions).toHaveLength(10);
      expect(Object.keys(questions[0] ?? {})).not.toContain("correct_option_id");

      const [attempt] = await sql<{ id: string }[]>`
        insert into bnl.assessment_attempts (household_id, learner_id, device_id, lesson_id, lesson_version_id,
          client_attempt_id, stage, seed, question_keys)
        values (${HH_A}, ${LEARNER_A1}, ${deviceA.deviceId}, ${MULT_TABLE_7}, ${v!.id}, gen_random_uuid(), 'immediate',
          'seed-1', ${sql.json(["grade2.math.multiplication.table-7.fact-3.v1", "grade2.math.multiplication.table-7.fact-4.v1"])})
        returning id`;
      const [right] = await sql<{ correct: boolean; correct_option_id: string; already_answered: boolean }[]>`
        select * from bnl.score_answer(${attempt!.id}, 'grade2.math.multiplication.table-7.fact-3.v1', ${key!.correct_option_id}, 1200)`;
      expect(right).toEqual({ correct: true, correct_option_id: key!.correct_option_id, already_answered: false });
      const [again] = await sql<{ correct: boolean; already_answered: boolean }[]>`
        select * from bnl.score_answer(${attempt!.id}, 'grade2.math.multiplication.table-7.fact-3.v1', ${wrong})`;
      expect(again).toMatchObject({ correct: true, already_answered: true });
      const [miss] = await sql<{ correct: boolean }[]>`
        select * from bnl.score_answer(${attempt!.id}, 'grade2.math.multiplication.table-7.fact-4.v1',
          (select o->>'id' from bnl.quiz_questions_for_version(${v!.id}) q, jsonb_array_elements(q.options) o
           where q.question_version_key = 'grade2.math.multiplication.table-7.fact-4.v1' and o->>'label' <> '28' limit 1))`;
      expect(miss?.correct).toBe(false);
      // Questions outside the attempt and unknown options are refused.
      await expectSqlState(sql, "22023", (sp) =>
        sp`select * from bnl.score_answer(${attempt!.id}, 'grade2.math.multiplication.table-7.fact-5.v1', 'a')`);
      const responses = await sql<{ correct: boolean }[]>`select correct from bnl.question_responses where attempt_id = ${attempt!.id}`;
      expect(responses.map((r) => r.correct).sort()).toEqual([false, true]);
      return attempt!.id;
    });
  });

  it("another household's device cannot score or see an attempt", async () => {
    const [v] = await admin<{ id: string }[]>`
      select lesson_version_id as id from bnl.publication_records where lesson_id = ${MULT_TABLE_7} and unpublished_at is null`;
    const attemptId = "a7000000-0000-4000-8000-000000000001";
    await admin`
      insert into bnl.assessment_attempts (id, household_id, learner_id, device_id, lesson_id, lesson_version_id,
        client_attempt_id, stage, seed)
      values (${attemptId}, ${HH_A}, ${LEARNER_A1}, ${deviceA.deviceId}, ${MULT_TABLE_7}, ${v!.id}, gen_random_uuid(), 'baseline', 's')
      on conflict (id) do nothing`;
    await rolledBack(deviceB, async (sql) => {
      expect(await sql`select id from bnl.assessment_attempts where id = ${attemptId}`).toHaveLength(0);
      await expectSqlState(sql, "P0002", (sp) =>
        sp`select * from bnl.score_answer(${attemptId}, 'grade2.math.multiplication.table-7.fact-1.v1', 'a')`);
    });
  });
});
