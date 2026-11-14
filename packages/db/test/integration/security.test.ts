import { afterAll, describe, expect, it } from "vitest";
import {
  ANALYST, CONSENT_B, DEVICE_A, DEVICE_B, DRAFT_LESSON, DRAFT_VERSION, EDITOR, EDITOR_REVIEWER, HH_A, HH_B, LEARNER_A1,
  LEARNER_B1, MULT_TABLE_7, PROGRESS_B1, PUBLISHER, REVIEWER, SYSTEM_ACTOR, UPLOAD_A, adultA, adultB, deviceA,
  deviceARevoked, deviceB, staff,
} from "../fixtures";
import { admin, closeAll, db, expectSqlState, rolledBack } from "./helpers";
import { withDbContext } from "../../src/index";

afterAll(closeAll);

const CHILD_TABLES = [
  "households", "household_memberships", "learner_profiles", "paired_devices", "device_pairing_codes", "consent_records",
  "learner_progress", "learning_sessions", "learning_events", "assessment_attempts", "question_responses",
  "review_schedule", "mastery_snapshots", "recommendations", "migration_runs", "migration_aliases",
  "school_plans", "syllabus_uploads", "syllabus_chapters", "chapter_topic_mappings", "import_jobs", "data_deletion_requests",
];

// Spec §5 + ADR-0005 tables (A2 and later agents rely on these names).
const REQUIRED_TABLES = [
  ...CHILD_TABLES, "staff_roles", "grade_subjects", "source_documents", "curriculum_frameworks", "curriculum_nodes",
  "learning_outcomes", "lessons", "lesson_versions", "lesson_outcomes", "quiz_items", "media_assets",
  "publication_records", "published_manifests", "score_runs", "metric_definitions", "audit_logs", "idempotency_keys",
  "rate_limit_buckets", "aggregation_runs", "job_runs",
];

const newProgress = (household: string, learner: string, attempt: string) => ({
  household_id: household, learner_id: learner, lesson_id: MULT_TABLE_7, theme_key: "farm", attempt_id: attempt,
  slide_id: "step-1", position_seconds: 0, completed: false, client_revision: 1,
});

const newEvent = (eventId: string, household: string, learner: string, device: string) => ({
  event_id: eventId, household_id: household, learner_id: learner, device_id: device,
  client_session_id: "7a000000-0000-4000-8000-000000000001", client_sequence: 1, event_type: "lesson_started",
  schema_version: 1, lesson_id: MULT_TABLE_7, occurred_at: new Date("2026-11-14T10:00:00Z"), payload: { theme_key: "farm" },
});

describe("SEC-005 schema-wide grants and RLS", () => {
  it("every bnl table has RLS enabled and forced", async () => {
    const rows = await admin<{ relname: string; on: boolean; forced: boolean }[]>`
      select c.relname, c.relrowsecurity as on, c.relforcerowsecurity as forced
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'bnl' and c.relkind in ('r', 'p') order by 1`;
    expect(rows.map((r) => r.relname)).toEqual(expect.arrayContaining(REQUIRED_TABLES));
    expect(rows.filter((r) => !r.on || !r.forced)).toEqual([]);
  });

  it("anon, authenticated and PUBLIC hold zero privileges on schema bnl and everything in it", async () => {
    for (const role of ["anon", "authenticated"]) {
      const [schema] = await admin<{ usage: boolean }[]>`select has_schema_privilege(${role}, 'bnl', 'USAGE') as usage`;
      expect(schema?.usage).toBe(false);
      const tables = await admin<{ relname: string }[]>`
        select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'bnl' and c.relkind in ('r', 'p', 'v', 'm')
          and has_table_privilege(${role}, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')`;
      expect(tables).toEqual([]);
      const columns = await admin<{ n: number }[]>`
        select count(*)::int as n from information_schema.column_privileges
        where table_schema = 'bnl' and grantee = ${role}`;
      expect(columns[0]?.n).toBe(0);
      const seqs = await admin<{ relname: string }[]>`
        select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'bnl'
          and case when c.relkind = 'S' then has_sequence_privilege(${role}, c.oid, 'USAGE,SELECT,UPDATE') else false end`;
      expect(seqs).toEqual([]);
      const fns = await admin<{ proname: string }[]>`
        select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'bnl' and has_function_privilege(${role}, p.oid, 'EXECUTE')`;
      // has_function_privilege is true for PUBLIC-executable functions; none may be.
      expect(fns).toEqual([]);
    }
    const publicAcl = await admin<{ relname: string }[]>`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace,
        lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      where n.nspname = 'bnl' and a.grantee = 0`;
    expect(publicAcl).toEqual([]);
  });

  it("every SECURITY DEFINER function is owned by bnl_owner and pins its search_path", async () => {
    const rows = await admin<{ proname: string; owner: string; config: string[] | null }[]>`
      select p.proname, pg_get_userbyid(p.proowner) as owner, p.proconfig as config
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'bnl' and p.prosecdef`;
    expect(rows.length).toBeGreaterThan(20);
    for (const r of rows) {
      expect(r.owner, r.proname).toBe("bnl_owner");
      expect(r.config?.some((c) => c.startsWith("search_path=")), r.proname).toBe(true);
    }
  });

  it("the bnl_app login holds no privileges until it sets a request role", async () => {
    await expect(db`select count(*) from bnl.learner_profiles`).rejects.toMatchObject({ code: "42501" });
    await expect(db`select count(*) from bnl.lessons`).rejects.toMatchObject({ code: "42501" });
  });
});

describe("SEC-003 cross-household access with guessed UUIDs", () => {
  it("device A reads only its own household", async () => {
    await withDbContext(db, deviceA, async (sql) => {
      const learners = await sql<{ household_id: string }[]>`select household_id from bnl.learner_profiles`;
      expect(learners.length).toBe(2);
      expect(new Set(learners.map((l) => l.household_id))).toEqual(new Set([HH_A]));
      expect(await sql`select id from bnl.learner_profiles where id = ${LEARNER_B1}`).toHaveLength(0);
      expect(await sql`select id from bnl.learner_progress where id = ${PROGRESS_B1}`).toHaveLength(0);
      expect(await sql`select id from bnl.households where id = ${HH_B}`).toHaveLength(0);
    });
  });

  it("device A cannot write into household B", async () => {
    await rolledBack(deviceA, async (sql) => {
      // Forged household on the row: RLS WITH CHECK.
      await expectSqlState(sql, "42501", (sp) =>
        sp`insert into bnl.learner_progress ${sp(newProgress(HH_B, LEARNER_B1, "92000000-0000-4000-8000-000000000001"))}`);
      // Own household, foreign learner: composite FK pins learners to their household.
      await expectSqlState(sql, "23503", (sp) =>
        sp`insert into bnl.learner_progress ${sp(newProgress(HH_A, LEARNER_B1, "92000000-0000-4000-8000-000000000002"))}`);
      // Event claiming another device.
      await expectSqlState(sql, "42501", (sp) =>
        sp`insert into bnl.learning_events ${sp(newEvent("93000000-0000-4000-8000-000000000001", HH_A, LEARNER_A1, DEVICE_B))}`);
      const upd = await sql`update bnl.learner_progress set slide_id = 'step-9' where id = ${PROGRESS_B1}`;
      expect(upd.count).toBe(0);
      const updLearner = await sql`update bnl.learner_profiles set display_name = 'x' where id = ${LEARNER_B1}`;
      expect(updLearner.count).toBe(0);
      // Unpublished (draft) lessons cannot be referenced by device writes.
      await expectSqlState(sql, "42501", (sp) =>
        sp`insert into bnl.learner_progress ${sp({ ...newProgress(HH_A, LEARNER_A1, "92000000-0000-4000-8000-000000000004"), lesson_id: DRAFT_LESSON })}`);
      // And the legitimate write succeeds.
      await sql`insert into bnl.learner_progress ${sql(newProgress(HH_A, LEARNER_A1, "92000000-0000-4000-8000-000000000003"))}`;
      await sql`insert into bnl.learning_events ${sql(newEvent("93000000-0000-4000-8000-000000000002", HH_A, LEARNER_A1, DEVICE_A))}`;
    });
  });

  it("a device token claiming another household sees nothing", async () => {
    await withDbContext(db, { kind: "device", householdId: HH_B, deviceId: DEVICE_A }, async (sql) => {
      expect(await sql`select id from bnl.learner_profiles`).toHaveLength(0);
      expect(await sql`select id from bnl.learner_progress`).toHaveLength(0);
    });
  });

  it("adult A sees only household A and cannot write into B", async () => {
    await rolledBack(adultA, async (sql) => {
      const learners = await sql<{ household_id: string }[]>`select household_id from bnl.learner_profiles`;
      expect(new Set(learners.map((l) => l.household_id))).toEqual(new Set([HH_A]));
      expect(await sql`select id from bnl.consent_records where id = ${CONSENT_B}`).toHaveLength(0);
      expect(await sql`select id from bnl.learner_progress where id = ${PROGRESS_B1}`).toHaveLength(0);
      expect(await sql`select id from bnl.paired_devices where household_id = ${HH_B}`).toHaveLength(0);
      expect(await sql`select id from bnl.syllabus_uploads where id = ${UPLOAD_A}`).toHaveLength(1);
      await expectSqlState(sql, "42501", (sp) =>
        sp`insert into bnl.consent_records (household_id, guardian_auth_user_id, consent_version)
           values (${HH_B}, ${adultA.userId}, 'v1')`);
      await expectSqlState(sql, "42501", (sp) =>
        sp`insert into bnl.learner_profiles (household_id, slot, display_name, grade, avatar_id)
           values (${HH_B}, 1, 'Intruder', 2, 'fox')`);
      expect((await sql`update bnl.learner_profiles set grade = 6 where id = ${LEARNER_B1}`).count).toBe(0);
      expect((await sql`delete from bnl.learner_profiles where id = ${LEARNER_B1}`).count).toBe(0);
      await expectSqlState(sql, "42501", (sp) => sp`select * from bnl.approve_pairing(${"a".repeat(64)}, ${HH_B}, 'TV')`);
      // Tokens are never readable, even for own devices.
      await expectSqlState(sql, "42501", (sp) => sp`select refresh_token_hash from bnl.paired_devices`);
    });
    await withDbContext(db, adultB, async (sql) => {
      expect(await sql`select id from bnl.syllabus_uploads where id = ${UPLOAD_A}`).toHaveLength(0);
      expect(await sql`select id from bnl.school_plans where household_id = ${HH_A}`).toHaveLength(0);
    });
  });
});

describe("SEC-004 revoked devices", () => {
  it("a revoked device can neither read nor write learning data", async () => {
    await rolledBack(deviceARevoked, async (sql) => {
      expect(await sql`select id from bnl.learner_profiles`).toHaveLength(0);
      await expectSqlState(sql, "42501", (sp) =>
        sp`insert into bnl.learner_progress ${sp(newProgress(HH_A, LEARNER_A1, "92000000-0000-4000-8000-000000000010"))}`);
      await expectSqlState(sql, "42501", (sp) =>
        sp`insert into bnl.learning_events ${sp(newEvent("93000000-0000-4000-8000-000000000010", HH_A, LEARNER_A1, deviceARevoked.deviceId))}`);
      const [touch] = await sql<{ v: number | null }[]>`select bnl.touch_device() as v`;
      expect(touch?.v).toBeNull();
    });
  });

  it("revoking a device takes effect immediately for its writes", async () => {
    await rolledBack(adultA, async (sql) => {
      const [r] = await sql<{ ok: boolean }[]>`select bnl.revoke_device(${DEVICE_A}) as ok`;
      expect(r?.ok).toBe(true);
      await sql.unsafe("set local role bnl_device");
      await sql`select set_config('bnl.household_id', ${HH_A}, true), set_config('bnl.device_id', ${DEVICE_A}, true),
                       set_config('bnl.actor_id', '', true)`;
      await expectSqlState(sql, "42501", (sp) =>
        sp`insert into bnl.learner_progress ${sp(newProgress(HH_A, LEARNER_A1, "92000000-0000-4000-8000-000000000011"))}`);
    });
  });
});

describe("SEC-006 public catalog", () => {
  it("public sees exactly the ten live lessons and nothing private", async () => {
    await withDbContext(db, { kind: "public" }, async (sql) => {
      const lessons = await sql<{ id: string }[]>`select id from bnl.lessons`;
      expect(lessons).toHaveLength(10);
      expect(lessons.map((l) => l.id)).not.toContain(DRAFT_LESSON);
      const versions = await sql<{ status: string }[]>`select status from bnl.lesson_versions`;
      expect(versions).toHaveLength(10);
      expect(new Set(versions.map((v) => v.status))).toEqual(new Set(["published"]));
      expect(await sql`select id from bnl.lesson_versions where id = ${DRAFT_VERSION}`).toHaveLength(0);
      const manifests = await sql`select revision from bnl.published_manifests`;
      expect(manifests.length).toBeGreaterThan(0);
    });
    for (const q of [
      "select * from bnl.quiz_items",
      "select correct_option_id from bnl.quiz_items",
      "select * from bnl.syllabus_uploads",
      "select * from bnl.school_plans",
      "select * from bnl.learner_profiles",
      "select * from bnl.publication_records",
      "select * from bnl.curriculum_nodes",
      "select created_by from bnl.lesson_versions",
      "select * from bnl.score_answer('00000000-0000-4000-8000-000000000000', 'k', 'a')",
    ]) {
      await expect(withDbContext(db, { kind: "public" }, (sql) => sql.unsafe(q)), q).rejects.toMatchObject({ code: "42501" });
    }
  });
});

describe("SEC-010 staff never see child-level rows", () => {
  it.each([EDITOR, REVIEWER, PUBLISHER, ANALYST])("staff %s is denied every household table", async (userId) => {
    for (const t of CHILD_TABLES) {
      await expect(withDbContext(db, staff(userId), (sql) => sql.unsafe(`select 1 from bnl.${t} limit 1`)), t)
        .rejects.toMatchObject({ code: "42501" });
    }
    await withDbContext(db, staff(userId), async (sql) => {
      expect(await sql`select id from bnl.audit_logs where household_id is not null`).toHaveLength(0);
    });
  });

  it("analysts cannot read the item bank or author content", async () => {
    await rolledBack(staff(ANALYST), async (sql) => {
      expect(await sql`select id from bnl.quiz_items`).toHaveLength(0);
      await expectSqlState(sql, "42501", (sp) =>
        sp`insert into bnl.lessons (stable_key, grade, subject_key, title, template_key, created_by)
           values ('grade2.math.analyst-try', 2, 'math', 'x', 'slides_v1', ${ANALYST})`);
    });
  });

  it("an editor cannot approve or publish; a reviewer cannot approve their own version", async () => {
    await rolledBack(staff(EDITOR), async (sql) => {
      await expectSqlState(sql, "42501", (sp) =>
        sp`select * from bnl.publish_lesson_version(${MULT_TABLE_7}, ${DRAFT_VERSION}, 'try', ${EDITOR})`);
      await expectSqlState(sql, "42501", (sp) =>
        sp`select * from bnl.transition_lesson_version(${DRAFT_VERSION}, 'approve', ${EDITOR}, null)`);
      // Impersonating another staff user or the system actor is refused.
      await expectSqlState(sql, "42501", (sp) =>
        sp`select * from bnl.transition_lesson_version(${DRAFT_VERSION}, 'approve', ${REVIEWER}, null)`);
      await expectSqlState(sql, "42501", (sp) =>
        sp`select * from bnl.transition_lesson_version(${DRAFT_VERSION}, 'approve', ${SYSTEM_ACTOR}, null)`);
      // Editors cannot change status directly.
      await expectSqlState(sql, "42501", (sp) =>
        sp`update bnl.lesson_versions set status = 'approved' where id = ${DRAFT_VERSION}`);
    });

    await rolledBack(staff(EDITOR_REVIEWER), async (sql) => {
      const content = {
        contract_version: 1, stable_key: "grade6.math.synthetic-draft", grade: 6, subject_key: "math",
        topic_key: "grade6.math.number_system", title: "SYNTHETIC v2", template: "slides_v1", config: {},
        learning_outcome_keys: ["grade6.math.number_system"], rights: { type: "original_generated_content", reviewed: true },
      };
      const [v] = await sql<{ id: string }[]>`
        insert into bnl.lesson_versions (lesson_id, version_no, content, created_by)
        values (${DRAFT_LESSON}, 2, ${sql.json(content)}, ${EDITOR_REVIEWER}) returning id`;
      await sql`select * from bnl.transition_lesson_version(${v!.id}, 'submit', ${EDITOR_REVIEWER}, null)`;
      await expectSqlState(sql, "42501", (sp) =>
        sp`select * from bnl.transition_lesson_version(${v!.id}, 'approve', ${EDITOR_REVIEWER}, null)`);
      // A different reviewer can approve.
      await sql.unsafe("set local role bnl_staff");
      await sql`select set_config('bnl.actor_id', ${REVIEWER}, true)`;
      const [ok] = await sql<{ status: string }[]>`
        select status from bnl.transition_lesson_version(${v!.id}, 'approve', ${REVIEWER}, 'looks right')`;
      expect(ok?.status).toBe("approved");
    });
  });

  it("adults and devices cannot call content workflow functions", async () => {
    for (const ctx of [adultA, deviceA, deviceB]) {
      await expect(withDbContext(db, ctx, (sql) =>
        sql`select * from bnl.publish_lesson_version(${DRAFT_LESSON}, ${DRAFT_VERSION}, 'x', ${EDITOR})`))
        .rejects.toMatchObject({ code: "42501" });
    }
  });
});
