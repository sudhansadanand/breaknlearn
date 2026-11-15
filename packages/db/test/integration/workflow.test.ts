import { MULTIPLICATION_LESSON_IDS, PublishedManifest } from "@bnl/contracts";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { withDbContext } from "../../src/index";
import { EDITOR, HH_A, LEARNER_A1, MULT_TABLE_10, MULT_TABLE_7, PUBLISHER, REVIEWER, deviceA, staff } from "../fixtures";
import { admin, closeAll, db, expectSqlState, freshUrls, rolledBack } from "./helpers";

afterAll(closeAll);

const liveVersion = async (lessonId: string) => {
  const [row] = await admin<{ id: string; version_no: number }[]>`
    select v.id, v.version_no from bnl.publication_records p join bnl.lesson_versions v on v.id = p.lesson_version_id
    where p.lesson_id = ${lessonId} and p.unpublished_at is null`;
  return row;
};
const latestRevision = async (grade: number) => {
  const [row] = await admin<{ revision: string; checksum: string }[]>`
    select revision, checksum from bnl.published_manifests where grade = ${grade} order by revision desc limit 1`;
  return row;
};
const publicLessonCount = () =>
  withDbContext(db, { kind: "public" }, async (sql) => (await sql`select id from bnl.lessons`).length);

describe("CAT-007 published versions are immutable", () => {
  it("content of a published version cannot change, even for the schema owner", async () => {
    const v1 = await liveVersion(MULT_TABLE_7);
    await rolledBack(staff(EDITOR), async (sql) => {
      const res = await sql`update bnl.lesson_versions set content = content || '{"title":"hacked"}' where id = ${v1!.id}`;
      expect(res.count).toBe(0);
      expect((await sql`delete from bnl.lesson_versions where id = ${v1!.id}`).count).toBe(0);
    });
    await expect(admin`update bnl.lesson_versions set content = content || '{"title":"hacked"}' where id = ${v1!.id}`)
      .rejects.toMatchObject({ code: "55000" });
    await expect(admin`delete from bnl.lesson_versions where id = ${v1!.id}`).rejects.toMatchObject({ code: "55000" });
  });
});

describe("publish workflow, rollback pin and OPS-003", () => {
  it("draft -> review -> approve -> publish replaces the live version; pin restores the previous manifest", async () => {
    const v1 = await liveVersion(MULT_TABLE_7);
    const before = await latestRevision(2);
    const v2content = {
      contract_version: 1, stable_key: "grade2.math.multiplication.table-7", grade: 2, subject_key: "math",
      topic_key: "grade2.math.multiplication", title: "7 Times Table", template: "picture_groups_v1",
      config: { factor: 7, count_from: 1, count_to: 10, themes: ["puppy", "candy", "unicorn", "school", "treat", "farm"],
        seconds_per_slide: 8, quiz_question_count: 3 },
      learning_outcome_keys: ["grade2.math.multiplication"], rights: { type: "original_generated_content", reviewed: true },
    };
    const v2 = await withDbContext(db, staff(EDITOR), async (sql) => {
      const [row] = await sql<{ id: string }[]>`
        insert into bnl.lesson_versions (lesson_id, version_no, content, created_by)
        values (${MULT_TABLE_7}, 2, ${sql.json(v2content)}, ${EDITOR}) returning id`;
      await sql`select * from bnl.transition_lesson_version(${row!.id}, 'submit', ${EDITOR}, null)`;
      return row!.id;
    });
    // Public never sees an unpublished version.
    await withDbContext(db, { kind: "public" }, async (sql) => {
      expect(await sql`select id from bnl.lesson_versions where id = ${v2}`).toHaveLength(0);
    });
    await withDbContext(db, staff(REVIEWER), (sql) =>
      sql`select * from bnl.transition_lesson_version(${v2}, 'approve', ${REVIEWER}, 'ok')`);
    const published = await withDbContext(db, staff(PUBLISHER), async (sql) => {
      const [r] = await sql<{ manifest_revision: string }[]>`
        select * from bnl.publish_lesson_version(${MULT_TABLE_7}, ${v2}, 'slower slides', ${PUBLISHER})`;
      return r!;
    });
    expect(BigInt(published.manifest_revision)).toBeGreaterThan(BigInt(before!.revision));
    expect((await liveVersion(MULT_TABLE_7))?.id).toBe(v2);
    expect(await publicLessonCount()).toBe(10);
    const [{ status: v1Status } = { status: "" }] = await admin<{ status: string }[]>`
      select status from bnl.lesson_versions where id = ${v1!.id}`;
    expect(v1Status).toBe("archived");

    // Devices keep reading the archived v1 (attempts stay pinned) but public only sees live versions.
    await withDbContext(db, deviceA, async (sql) => {
      expect(await sql`select id from bnl.lesson_versions where id = ${v1!.id}`).toHaveLength(1);
    });
    await withDbContext(db, { kind: "public" }, async (sql) => {
      expect(await sql`select id from bnl.lesson_versions where id = ${v1!.id}`).toHaveLength(0);
    });

    // Roll back by pinning the previous grade-2 manifest.
    const pinned = await withDbContext(db, staff(PUBLISHER), async (sql) => {
      const [r] = await sql<{ manifest_revision: string; pinned_from_revision: string }[]>`
        select * from bnl.pin_manifest(${before!.revision}, ${PUBLISHER})`;
      return r!;
    });
    expect(String(pinned.pinned_from_revision)).toBe(String(before!.revision));
    expect((await liveVersion(MULT_TABLE_7))?.id).toBe(v1!.id);
    expect(await publicLessonCount()).toBe(10);
    const [m] = await admin<{ manifest: unknown; pinned_from_revision: string }[]>`
      select manifest, pinned_from_revision from bnl.published_manifests where revision = ${pinned.manifest_revision}`;
    const parsed = PublishedManifest.parse(m!.manifest);
    const lessons = parsed.subjects.flatMap((s) => s.topics.flatMap((t) => t.lessons));
    expect(lessons.map((l) => l.id)).toEqual(Object.values(MULTIPLICATION_LESSON_IDS));
    expect(lessons.find((l) => l.id === MULT_TABLE_7)?.version_id).toBe(v1!.id);
    const audit = await admin<{ action: string }[]>`
      select action from bnl.audit_logs where actor_auth_id = ${PUBLISHER} order by created_at`;
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["lesson.publish", "manifest.pin"]));
  });

  it("OPS-003: a publish whose manifest cannot be built leaves everything unchanged", async () => {
    // A lesson whose subject is not offered in its grade makes the manifest build fail.
    const lessonId = "0b000000-0000-4000-8000-000000000003";
    const versionId = "0c000000-0000-4000-8000-000000000003";
    await admin`
      insert into bnl.lessons (id, stable_key, grade, subject_key, topic_id, title, template_key)
      values (${lessonId}, 'grade6.music.ops003', 6, 'music',
              (select id from bnl.curriculum_nodes where stable_key = 'grade6.aadritha'), 'OPS-003', 'slides_v1')`;
    await admin`
      insert into bnl.lesson_versions (id, lesson_id, version_no, content, created_by)
      values (${versionId}, ${lessonId}, 1, ${admin.json({
        contract_version: 1, stable_key: "grade6.music.ops003", grade: 6, subject_key: "music", topic_key: "x",
        title: "OPS-003", template: "slides_v1", config: {}, learning_outcome_keys: ["x"],
        rights: { type: "original_generated_content", reviewed: true },
      })}, ${EDITOR})`;
    await admin`update bnl.lesson_versions set status = 'approved', reviewed_by = ${REVIEWER}, approved_at = now() where id = ${versionId}`;

    const snapshot = async () => {
      const [s] = await admin<{ manifests: number; records: number; audits: number; latest6: string; status: string }[]>`
        select (select count(*)::int from bnl.published_manifests) as manifests,
               (select count(*)::int from bnl.publication_records) as records,
               (select count(*)::int from bnl.audit_logs) as audits,
               (select checksum from bnl.published_manifests where grade = 6 order by revision desc limit 1) as latest6,
               (select status from bnl.lesson_versions where id = ${versionId}) as status`;
      return s;
    };
    const before = await snapshot();
    await expect(withDbContext(db, staff(PUBLISHER), (sql) =>
      sql`select * from bnl.publish_lesson_version(${lessonId}, ${versionId}, 'should fail', ${PUBLISHER})`))
      .rejects.toMatchObject({ code: "22023" });
    expect(await snapshot()).toEqual(before);
    expect(before?.status).toBe("approved");
    await withDbContext(db, { kind: "public" }, async (sql) => {
      expect(await sql`select id from bnl.lessons where id = ${lessonId}`).toHaveLength(0);
    });
  });

  it("unpublish removes a lesson from the public catalog and the manifest (rolled back)", async () => {
    await rolledBack(staff(PUBLISHER), async (sql) => {
      await sql`select * from bnl.unpublish_lesson(${MULT_TABLE_10}, 'test', ${PUBLISHER})`;
      const [m] = await sql<{ manifest: unknown }[]>`
        select manifest from bnl.published_manifests where grade = 2 order by revision desc limit 1`;
      const lessons = PublishedManifest.parse(m!.manifest).subjects.flatMap((s) => s.topics.flatMap((t) => t.lessons));
      expect(lessons).toHaveLength(9);
      await sql.unsafe("set local role bnl_public");
      expect(await sql`select id from bnl.lessons`).toHaveLength(9);
    });
    expect(await publicLessonCount()).toBe(10);
  });
});

describe("progress", () => {
  it("completion is monotonic within an attempt and server_revision increments", async () => {
    await rolledBack(deviceA, async (sql) => {
      const [p] = await sql<{ id: string; server_revision: string; completed_at: Date | null }[]>`
        insert into bnl.learner_progress (household_id, learner_id, lesson_id, theme_key, attempt_id, slide_id,
          position_seconds, completed, client_revision)
        values (${HH_A}, ${LEARNER_A1}, ${MULT_TABLE_7}, 'unicorn', gen_random_uuid(), 'step-10', 6, true, 1)
        returning id, server_revision, completed_at`;
      expect(String(p!.server_revision)).toBe("1");
      expect(p!.completed_at).not.toBeNull();
      await expectSqlState(sql, "55000", (sp) =>
        sp`update bnl.learner_progress set completed = false where id = ${p!.id}`);
      await expectSqlState(sql, "55000", (sp) =>
        sp`update bnl.learner_progress set theme_key = 'farm' where id = ${p!.id}`);
      const [u] = await sql<{ server_revision: string; completed_at: Date }[]>`
        update bnl.learner_progress set slide_id = 'step-10', client_revision = 2 where id = ${p!.id}
        returning server_revision, completed_at`;
      expect(String(u!.server_revision)).toBe("2");
      expect(u!.completed_at.getTime()).toBe(p!.completed_at!.getTime());
      // Same (learner, lesson, theme, attempt) cannot be inserted twice.
      await expectSqlState(sql, "23505", (sp) =>
        sp`insert into bnl.learner_progress (household_id, learner_id, lesson_id, theme_key, attempt_id)
           select household_id, learner_id, lesson_id, theme_key, attempt_id from bnl.learner_progress where id = ${p!.id}`);
    });
  });
});

describe("migrations", () => {
  const fingerprint = async (sql: postgres.Sql) => {
    const [row] = await sql<{ tables: number; columns: string; policies: string; functions: string; live: number }[]>`
      select (select count(*)::int from pg_tables where schemaname = 'bnl') as tables,
             (select md5(string_agg(table_name || '.' || column_name || ':' || data_type, ',' order by table_name, column_name))
                from information_schema.columns where table_schema = 'bnl') as columns,
             (select md5(string_agg(tablename || '.' || policyname || ':' || cmd || ':' || roles::text, ',' order by tablename, policyname))
                from pg_policies where schemaname = 'bnl') as policies,
             -- Owner is bnl_owner (SECURITY DEFINER) or whichever login ran the migrations (superuser or, on
             -- bnl_fresh_a, a Supabase-like non-superuser), so the login's name is normalised.
             (select md5(string_agg(p.oid::regprocedure::text || ':' || case when pg_get_userbyid(p.proowner) = 'bnl_owner'
                       then 'bnl_owner' else 'migration_login' end, ',' order by p.oid::regprocedure::text))
                from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'bnl') as functions,
             (select count(*)::int from bnl.publication_records where unpublished_at is null) as live`;
    return row;
  };

  it("apply cleanly to two fresh databases in one cluster (and re-apply) with identical results", async () => {
    const main = await fingerprint(admin);
    expect(freshUrls).toHaveLength(2);
    for (const url of freshUrls) {
      const fresh = postgres(url, { max: 1, onnotice: () => undefined });
      const fp = await fingerprint(fresh);
      await fresh.end({ timeout: 5 });
      expect(fp).toEqual({ ...main, live: 10 });
    }
  });
});
