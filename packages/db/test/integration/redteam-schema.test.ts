/**
 * A9 schema-wide red-team checks (SEC-005). These are deliberately strict SNAPSHOTS: any new table, grant, policy
 * or EXECUTE privilege makes them fail until a reviewer updates the expected lists here, so a permission can never
 * be widened silently by a later migration.
 */
import { afterAll, describe, expect, it } from "vitest";
import { admin, closeAll } from "./helpers";

afterAll(closeAll);

const REQUEST_ROLES = ["bnl_public", "bnl_device", "bnl_adult", "bnl_staff", "bnl_job"] as const;
const NOBODY = ["public", "anon", "authenticated"] as const;

describe("SEC-005 schema-wide: RLS, policies, PUBLIC/anon", () => {
  it("every relation in bnl is a table with RLS enabled AND forced, and has at least one policy", async () => {
    const rows = await admin<{ relname: string; relkind: string; on: boolean; forced: boolean; policies: number }[]>`
      select c.relname, c.relkind::text as relkind, c.relrowsecurity as on, c.relforcerowsecurity as forced,
             (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'bnl' and c.relkind in ('r', 'p', 'v', 'm', 'f') order by 1`;
    expect(rows.length).toBeGreaterThanOrEqual(42);
    // No views/materialized views/foreign tables: they would bypass RLS (views run as their owner).
    expect(rows.filter((r) => r.relkind !== "r" && r.relkind !== "p").map((r) => r.relname)).toEqual([]);
    expect(rows.filter((r) => !r.on || !r.forced).map((r) => r.relname)).toEqual([]);
    expect(rows.filter((r) => r.policies === 0).map((r) => r.relname)).toEqual([]);
  });

  it("no policy applies to PUBLIC (every policy names explicit bnl_* roles)", async () => {
    const rows = await admin<{ t: string; p: string; roles: string[] }[]>`
      select tablename as t, policyname as p, roles::text[] as roles from pg_policies where schemaname = 'bnl'`;
    expect(rows.length).toBeGreaterThan(50);
    const bad = rows.filter((r) => r.roles.some((role) => !role.startsWith("bnl_")));
    expect(bad).toEqual([]);
  });

  it("PUBLIC, anon and authenticated have no privilege on the schema, any table, column, sequence, function or type", async () => {
    for (const role of NOBODY) {
      const who = role === "public" ? 0 : (await admin<{ oid: number }[]>`select oid::int from pg_roles where rolname = ${role}`)[0]!.oid;
      const acl = await admin<{ kind: string; name: string }[]>`
        select 'schema' as kind, n.nspname as name from pg_namespace n, lateral aclexplode(coalesce(n.nspacl, acldefault('n'::"char", n.nspowner))) a
          where n.nspname = 'bnl' and a.grantee = ${who}
        union all
        select 'relation', c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace,
          lateral aclexplode(coalesce(c.relacl, acldefault((case when c.relkind = 'S' then 's' else 'r' end)::"char", c.relowner))) a
          where n.nspname = 'bnl' and a.grantee = ${who}
        union all
        select 'column', c.relname || '.' || at.attname from pg_attribute at join pg_class c on c.oid = at.attrelid
          join pg_namespace n on n.oid = c.relnamespace, lateral aclexplode(at.attacl) a
          where n.nspname = 'bnl' and at.attacl is not null and a.grantee = ${who}
        union all
        select 'function', p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
          lateral aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
          where n.nspname = 'bnl' and a.grantee = ${who}
        union all
        select 'type', t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace,
          lateral aclexplode(coalesce(t.typacl, acldefault('T'::"char", t.typowner))) a
          where n.nspname = 'bnl' and t.typtype in ('d', 'e', 'r', 'm') and a.grantee = ${who}`;
      expect(acl, role).toEqual([]);
    }
    const defaults = await admin<{ n: number }[]>`
      select count(*)::int as n from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace,
        lateral aclexplode(d.defaclacl) a
      where n.nspname = 'bnl' and (a.grantee = 0 or a.grantee in (select oid from pg_roles where rolname in ('anon', 'authenticated')))`;
    expect(defaults[0]!.n).toBe(0);
  });

  it("migrations create nothing outside schema bnl (no public-schema tables an API could expose)", async () => {
    const rows = await admin<{ nspname: string; relname: string }[]>`
      select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast', 'bnl') and c.relkind in ('r', 'p', 'v', 'm', 'f')`;
    expect(rows).toEqual([]);
  });

  it("bnl_app (the only login) holds no direct table/function privilege: it must SET ROLE first", async () => {
    const [t] = await admin<{ n: number }[]>`
      select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'bnl' and c.relkind = 'r'
        and has_table_privilege('bnl_app', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')`;
    expect(t!.n).toBe(0);
    const [f] = await admin<{ n: number }[]>`
      select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'bnl' and has_function_privilege('bnl_app', p.oid, 'EXECUTE')`;
    expect(f!.n).toBe(0);
  });
});

describe("household-scoped policies (no broad authenticated read)", () => {
  it("every request-role policy on a household table scopes by household, device or actor", async () => {
    const rows = await admin<{ t: string; p: string; roles: string[]; qual: string | null; check: string | null }[]>`
      select pol.tablename as t, pol.policyname as p, pol.roles::text[] as roles, pol.qual, pol.with_check as check
      from pg_policies pol
      -- RESTRICTIVE policies only narrow access further, so they need no scoping of their own.
      where pol.schemaname = 'bnl' and pol.permissive = 'PERMISSIVE'
        and exists (select 1 from information_schema.columns c where c.table_schema = 'bnl' and c.table_name = pol.tablename
                    and c.column_name = 'household_id')`;
    const scoped = /current_household_id|adult_household_ids|adult_owner_household_ids|current_device_id|current_actor_id|household_id IS NULL/;
    const offenders = rows
      .filter((r) => r.roles.some((role) => role !== "bnl_owner" && role !== "bnl_job"))
      .filter((r) => !(scoped.test(r.qual ?? "") || (r.qual === null && scoped.test(r.check ?? ""))))
      .map((r) => `${r.t}.${r.p}`);
    expect(offenders).toEqual([]);
  });

  it("bnl_job has unrestricted (using true) policies only where it is the intended server-side reader", async () => {
    // Documented: jobs run with a server-only login and see every household (aggregation, scoring, retention).
    const [n] = await admin<{ n: number }[]>`select count(*)::int as n from pg_policies where schemaname = 'bnl' and 'bnl_job' = any(roles::text[])`;
    expect(n!.n).toBeGreaterThan(0);
  });
});

/** Expected table privileges per request role (SELECT/INSERT/UPDATE/DELETE incl. column-level grants). */
const EXPECTED_TABLE_PRIVILEGES: Record<(typeof REQUEST_ROLES)[number], Record<string, string>> = {
  bnl_public: {
    grade_subjects: "SELECT", lesson_versions: "SELECT", lessons: "SELECT", published_manifests: "SELECT",
  },
  bnl_device: {
    assessment_attempts: "INSERT,SELECT,UPDATE", audit_logs: "INSERT", grade_subjects: "SELECT", households: "SELECT",
    idempotency_keys: "INSERT,SELECT,UPDATE", learner_profiles: "INSERT,SELECT,UPDATE", learner_progress: "INSERT,SELECT,UPDATE",
    learning_events: "INSERT,SELECT", learning_sessions: "INSERT,SELECT,UPDATE", lesson_versions: "SELECT", lessons: "SELECT",
    migration_aliases: "INSERT,SELECT", migration_runs: "INSERT,SELECT,UPDATE", paired_devices: "SELECT,UPDATE",
    published_manifests: "SELECT", question_responses: "SELECT", recommendations: "SELECT", review_schedule: "INSERT,SELECT,UPDATE",
  },
  bnl_adult: {
    assessment_attempts: "SELECT", audit_logs: "INSERT,SELECT", chapter_topic_mappings: "DELETE,INSERT,SELECT,UPDATE",
    consent_records: "INSERT,SELECT,UPDATE", curriculum_frameworks: "SELECT", curriculum_nodes: "SELECT",
    data_deletion_requests: "INSERT,SELECT", device_pairing_codes: "SELECT,UPDATE", grade_subjects: "SELECT",
    household_memberships: "INSERT,SELECT,UPDATE", households: "SELECT,UPDATE", idempotency_keys: "INSERT,SELECT,UPDATE",
    import_jobs: "DELETE,INSERT,SELECT,UPDATE", learner_profiles: "DELETE,INSERT,SELECT,UPDATE", learner_progress: "SELECT",
    learning_events: "SELECT", learning_outcomes: "SELECT", learning_sessions: "SELECT", lesson_versions: "SELECT", lessons: "SELECT",
    mastery_snapshots: "SELECT", metric_definitions: "SELECT", migration_aliases: "SELECT", migration_runs: "SELECT",
    paired_devices: "INSERT,SELECT,UPDATE", published_manifests: "SELECT", question_responses: "SELECT",
    recommendations: "SELECT,UPDATE", review_schedule: "SELECT", school_plans: "DELETE,INSERT,SELECT,UPDATE", staff_roles: "SELECT",
    syllabus_chapters: "DELETE,INSERT,SELECT,UPDATE", syllabus_uploads: "DELETE,INSERT,SELECT,UPDATE",
  },
  bnl_staff: {
    aggregation_runs: "SELECT", audit_logs: "INSERT,SELECT", curriculum_frameworks: "INSERT,SELECT,UPDATE",
    curriculum_nodes: "INSERT,SELECT,UPDATE", grade_subjects: "SELECT", idempotency_keys: "INSERT,SELECT,UPDATE",
    learning_outcomes: "INSERT,SELECT,UPDATE", lesson_outcomes: "DELETE,INSERT,SELECT", lesson_versions: "DELETE,INSERT,SELECT,UPDATE",
    lessons: "INSERT,SELECT,UPDATE", media_assets: "INSERT,SELECT,UPDATE", metric_definitions: "SELECT", publication_records: "SELECT",
    published_manifests: "SELECT", quiz_items: "DELETE,INSERT,SELECT,UPDATE", score_runs: "SELECT",
    source_documents: "INSERT,SELECT,UPDATE", staff_roles: "SELECT",
  },
  bnl_job: {
    aggregation_runs: "DELETE,INSERT,SELECT,UPDATE", assessment_attempts: "SELECT", audit_logs: "INSERT,SELECT",
    chapter_topic_mappings: "INSERT,SELECT,UPDATE", consent_records: "SELECT", curriculum_nodes: "SELECT",
    data_deletion_requests: "SELECT,UPDATE", device_pairing_codes: "DELETE,INSERT,SELECT,UPDATE", households: "SELECT",
    idempotency_keys: "DELETE,SELECT", import_jobs: "SELECT,UPDATE", job_runs: "DELETE,INSERT,SELECT,UPDATE",
    learner_profiles: "SELECT", learner_progress: "SELECT", learning_events: "DELETE,SELECT,UPDATE", learning_outcomes: "SELECT",
    learning_sessions: "SELECT,UPDATE", lesson_outcomes: "SELECT", lesson_versions: "SELECT", lessons: "SELECT",
    mastery_snapshots: "DELETE,INSERT,SELECT,UPDATE", metric_definitions: "DELETE,INSERT,SELECT,UPDATE", paired_devices: "SELECT,UPDATE",
    publication_records: "SELECT", question_responses: "SELECT", rate_limit_buckets: "DELETE,INSERT,SELECT,UPDATE",
    recommendations: "DELETE,INSERT,SELECT,UPDATE", review_schedule: "DELETE,INSERT,SELECT,UPDATE", school_plans: "SELECT",
    score_runs: "DELETE,INSERT,SELECT,UPDATE", syllabus_chapters: "INSERT,SELECT,UPDATE", syllabus_uploads: "SELECT,UPDATE",
  },
};

/** Expected EXECUTE grants on SECURITY DEFINER functions (helpers that only evaluate policies are listed once). */
const POLICY_HELPERS = ["adult_household_ids", "adult_owner_household_ids", "device_ok", "has_staff_role", "is_staff",
  "lesson_is_live", "lesson_was_published", "version_is_draft", "version_is_live", "version_was_published"];
const EXPECTED_DEFINER_EXECUTE: Record<string, string> = {
  ...Object.fromEntries(POLICY_HELPERS.map((f) => [f, "bnl_adult,bnl_device,bnl_job,bnl_public,bnl_staff"])),
  _audit: "", _build_manifest_subjects: "", _close_live: "", _is_ops_session: "", _open_live: "", _require_staff_actor: "",
  _write_manifest: "", generate_picture_groups_items: "", tg_assessment_attempts_guard: "", tg_lesson_versions_item_bank: "",
  tg_question_responses_guard: "",
  approve_pairing: "bnl_adult", create_household: "bnl_adult", revoke_device: "bnl_adult",
  create_pairing_code: "bnl_public", redeem_pairing: "bnl_public", rotate_device_refresh: "bnl_public",
  quiz_questions_for_version: "bnl_device", score_answer: "bnl_device", touch_device: "bnl_device",
  lesson_content_errors: "bnl_staff", pin_manifest: "bnl_staff", publish_lesson_version: "bnl_staff", refresh_manifest: "bnl_staff",
  transition_lesson_version: "bnl_staff", unpublish_lesson: "bnl_staff",
  purge_expired: "bnl_job", purge_expired_analytics: "bnl_job",
  rate_limit_hit: "bnl_adult,bnl_device,bnl_public,bnl_staff",
};

describe("privilege snapshots (a new grant must be reviewed)", () => {
  it.each(REQUEST_ROLES)("table privileges of %s match the reviewed list", async (role) => {
    const rows = await admin<{ relname: string; privs: string }[]>`
      select c.relname, string_agg(distinct pr, ',' order by pr) as privs
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) pr
      where n.nspname = 'bnl' and c.relkind in ('r', 'p')
        and (has_table_privilege(${role}, c.oid, pr)
             or (pr in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') and has_any_column_privilege(${role}, c.oid, pr)))
      group by c.relname order by c.relname`;
    expect(Object.fromEntries(rows.map((r) => [r.relname, r.privs]))).toEqual(EXPECTED_TABLE_PRIVILEGES[role]);
  });

  it("no request role may TRUNCATE, REFERENCES or TRIGGER anything", async () => {
    for (const role of REQUEST_ROLES) {
      const [r] = await admin<{ n: number }[]>`
        select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'bnl' and c.relkind = 'r' and has_table_privilege(${role}, c.oid, 'TRUNCATE,REFERENCES,TRIGGER')`;
      expect(r!.n, role).toBe(0);
    }
  });

  it("token and secret columns are never readable by adults (column grants)", async () => {
    for (const [table, column] of [["paired_devices", "refresh_token_hash"], ["households", "created_by"]] as const) {
      const [r] = await admin<{ ok: boolean }[]>`select has_column_privilege('bnl_adult', ${`bnl.${table}`}, ${column}, 'SELECT') as ok`;
      expect(r!.ok, `${table}.${column}`).toBe(false);
    }
    for (const role of ["bnl_public", "bnl_device", "bnl_adult"]) {
      const [r] = await admin<{ ok: boolean }[]>`select has_table_privilege(${role}, 'bnl.quiz_items', 'SELECT') as ok`;
      expect(r!.ok, `${role} quiz_items (answer keys)`).toBe(false);
    }
  });

  it("EXECUTE on every SECURITY DEFINER function matches the reviewed matrix", async () => {
    const rows = await admin<{ fn: string; roles: string | null }[]>`
      select p.proname as fn,
        string_agg(r.rolname, ',' order by r.rolname) filter (where has_function_privilege(r.oid, p.oid, 'EXECUTE')) as roles
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      cross join (select oid, rolname from pg_roles where rolname in ('bnl_public', 'bnl_device', 'bnl_adult', 'bnl_staff', 'bnl_job', 'bnl_app', 'anon', 'authenticated')) r
      where n.nspname = 'bnl' and p.prosecdef group by p.oid, p.proname order by 1`;
    expect(Object.fromEntries(rows.map((r) => [r.fn, r.roles ?? ""]))).toEqual(EXPECTED_DEFINER_EXECUTE);
  });
});
