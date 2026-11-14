/**
 * A9 cross-tenant red-team (P6 gate `cross_tenant_redteam_pass`) against the real schema, roles and RLS.
 *
 * Two fresh SYNTHETIC households X and Y are seeded (superuser, setup only) with a row in EVERY household-scoped
 * table. Every attack then runs through the `bnl_app` login with the request role that the BFF would use
 * (`withDbContext`), inside a transaction that is always rolled back:
 *   - household Y's owner, Y's device, X's revoked device, an outsider adult, every staff role, the public role;
 *   - forged claims: a device context naming household X with Y's device id, an adult acting as a staff user;
 *   - SQL-level role switches from inside a request context;
 *   - SECURITY DEFINER functions called with household X's ids.
 * Positive controls prove the fixtures are visible to the legitimate actor, so a "0 rows" result is meaningful.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withDbContext, type DbContext, type TransactionSql } from "../../src/index";
import { EDITOR, MULT_TABLE_7, PUBLISHER, REVIEWER, ANALYST, EDITOR_REVIEWER, OUTSIDER } from "../fixtures";
import { admin, closeAll, db, rolledBack } from "./helpers";
import { dropHousehold, publishedVersionOf, seedHousehold, sha, type Household } from "./redteam-fixtures";


/** Every table whose rows belong to one household (column `household_id`, or `id` for households). */
const HOUSEHOLD_TABLES = [
  "households", "household_memberships", "learner_profiles", "paired_devices", "device_pairing_codes", "consent_records",
  "migration_runs", "migration_aliases", "school_plans", "syllabus_uploads", "import_jobs", "syllabus_chapters",
  "chapter_topic_mappings", "learning_sessions", "learning_events", "learner_progress", "assessment_attempts",
  "question_responses", "review_schedule", "mastery_snapshots", "recommendations", "audit_logs", "idempotency_keys",
  "data_deletion_requests",
] as const;
type HouseholdTable = (typeof HOUSEHOLD_TABLES)[number];
const hhCol = (t: HouseholdTable) => (t === "households" ? "id" : "household_id");

let X: Household;
let Y: Household;
let versionId: string;

beforeAll(async () => {
  versionId = await publishedVersionOf(MULT_TABLE_7);
  X = await seedHousehold("X", versionId);
  Y = await seedHousehold("Y", versionId);
});

afterAll(async () => {
  for (const h of [X, Y]) if (h) await dropHousehold(h.id);
  await closeAll();
});

const device = (h: Household, deviceId = h.device): DbContext => ({ kind: "device", householdId: h.id, deviceId });
const adult = (userId: string): DbContext => ({ kind: "adult", userId });
const staffCtx = (userId: string): DbContext => ({ kind: "staff", userId });

type Probe = { ok: true; count: number } | { ok: false; code: string };

/** Runs one statement in a savepoint; returns row count or SQLSTATE (the outer transaction survives). */
async function probe(sql: TransactionSql, run: (sp: TransactionSql) => Promise<{ count: number }>): Promise<Probe> {
  try {
    const r = await sql.savepoint((sp) => run(sp));
    return { ok: true, count: r.count };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (!code) throw err;
    return { ok: false, code };
  }
}

/** Zero rows or a privilege/RLS error — anything else is a cross-tenant leak or write. */
function expectDenied(p: Probe, label: string): void {
  if (p.ok) expect(p.count, `${label} touched ${p.count} row(s)`).toBe(0);
  else expect(["42501", "23503", "P0002"], `${label} failed with unexpected ${p.code}`).toContain(p.code);
}

/** Attackers are built lazily (fixtures exist only after beforeAll). */
const ATTACKER_NAMES = [
  "owner of Y", "guardian of Y", "outsider adult (no household)", "device of Y", "revoked device of X",
  "forged claim: Y's device naming household X", "forged claim: random device id in household X",
  ...[EDITOR, REVIEWER, PUBLISHER, ANALYST, EDITOR_REVIEWER].map((u) => `staff ${u}`),
  "owner of X in a staff context", "public",
];
function attackers(): { name: string; ctx: DbContext }[] {
  return [
    { name: "owner of Y", ctx: adult(Y.owner) },
    { name: "guardian of Y", ctx: adult(Y.guardian) },
    { name: "outsider adult (no household)", ctx: adult(OUTSIDER) },
    { name: "device of Y", ctx: device(Y) },
    { name: "revoked device of X", ctx: device(X, X.revokedDevice) },
    { name: "forged claim: Y's device naming household X", ctx: { kind: "device", householdId: X.id, deviceId: Y.device } },
    { name: "forged claim: random device id in household X", ctx: { kind: "device", householdId: X.id, deviceId: randomUUID() } },
    ...[EDITOR, REVIEWER, PUBLISHER, ANALYST, EDITOR_REVIEWER].map((u) => ({ name: `staff ${u}`, ctx: staffCtx(u) })),
    // A household owner's user id presented in a staff context (role confusion).
    { name: "owner of X in a staff context", ctx: staffCtx(X.owner) },
    { name: "public", ctx: { kind: "public" } as DbContext },
  ];
}

describe("fixtures are real (positive controls)", () => {
  it("household X has a row in every household table, visible to its owner or device where granted", async () => {
    for (const t of HOUSEHOLD_TABLES) {
      const [r] = await admin.unsafe<{ n: number }[]>(`select count(*)::int as n from bnl.${t} where ${hhCol(t)} = $1`, [X.id]);
      expect(r!.n, t).toBeGreaterThan(0);
    }
    await rolledBack(adult(X.owner), async (sql) => {
      for (const t of ["learner_profiles", "learner_progress", "learning_events", "assessment_attempts", "question_responses",
        "mastery_snapshots", "recommendations", "syllabus_uploads", "consent_records", "paired_devices"]) {
        const [r] = await sql.unsafe<{ n: number }[]>(`select count(*)::int as n from bnl.${t} where household_id = $1`, [X.id]);
        expect(r!.n, `owner X reads ${t}`).toBeGreaterThan(0);
      }
    });
    await rolledBack(device(X), async (sql) => {
      const [r] = await sql<{ n: number }[]>`select count(*)::int as n from bnl.learner_progress where household_id = ${X.id}`;
      expect(r!.n).toBeGreaterThan(0);
    });
  });
});

describe("every attacker × every household table: read, update and delete of household X", () => {
  for (const name of ATTACKER_NAMES) {
    it(name, async () => {
      const a = attackers().find((x) => x.name === name)!;
      await rolledBack(a.ctx, async (sql) => {
        for (const t of HOUSEHOLD_TABLES) {
          const col = hhCol(t);
          // A device (even a revoked one) may read its OWN paired_devices row by design (token_version check).
          const own = t === "paired_devices" ? " and id is distinct from bnl.current_device_id()" : "";
          expectDenied(await probe(sql, async (sp) => {
            const rows = await sp.unsafe<{ n: number }[]>(`select count(*)::int as n from bnl.${t} where ${col} = $1${own}`, [X.id]);
            return { count: rows[0]!.n };
          }), `${a.name} SELECT ${t}`);
          // Without a WHERE on household too: nothing of X may come back in an unfiltered scan.
          expectDenied(await probe(sql, async (sp) => {
            const rows = await sp.unsafe<{ v: string }[]>(`select ${col}::text as v from bnl.${t} where true${own}`);
            return { count: rows.filter((r) => r.v === X.id).length };
          }), `${a.name} unfiltered SELECT ${t}`);
          expectDenied(await probe(sql, (sp) => sp.unsafe(`update bnl.${t} set updated_at = now() where ${col} = $1`, [X.id])), `${a.name} UPDATE ${t}`);
          expectDenied(await probe(sql, (sp) => sp.unsafe(`delete from bnl.${t} where ${col} = $1`, [X.id])), `${a.name} DELETE ${t}`);
        }
      });
    });
  }
});

describe("forged writes into household X", () => {
  it("household Y's device cannot insert any learning row claiming household X or X's learners", async () => {
    await rolledBack(device(Y), async (sql) => {
      const attempts: [string, (sp: TransactionSql) => Promise<{ count: number }>][] = [
        ["learner_profiles", (sp) => sp`insert into bnl.learner_profiles (household_id, slot, display_name, grade, avatar_id) values (${X.id}, 1, 'Intruder', 2, 'fox')`],
        ["learner_progress (X household)", (sp) => sp`insert into bnl.learner_progress (household_id, learner_id, lesson_id, theme_key, attempt_id) values (${X.id}, ${X.learners[0]}, ${MULT_TABLE_7}, 'farm', ${randomUUID()})`],
        ["learner_progress (own household, X learner)", (sp) => sp`insert into bnl.learner_progress (household_id, learner_id, lesson_id, theme_key, attempt_id) values (${Y.id}, ${X.learners[0]}, ${MULT_TABLE_7}, 'farm', ${randomUUID()})`],
        ["learning_sessions", (sp) => sp`insert into bnl.learning_sessions (household_id, learner_id, device_id, client_session_id, started_at) values (${X.id}, ${X.learners[0]}, ${Y.device}, ${randomUUID()}, now())`],
        ["learning_events (X learner, own household)", (sp) => sp`insert into bnl.learning_events (event_id, household_id, learner_id, device_id, client_session_id, client_sequence, event_type, schema_version, occurred_at) values (${randomUUID()}, ${Y.id}, ${X.learners[0]}, ${Y.device}, ${randomUUID()}, 1, 'app_opened', 1, now())`],
        ["learning_events (X device)", (sp) => sp`insert into bnl.learning_events (event_id, household_id, learner_id, device_id, client_session_id, client_sequence, event_type, schema_version, occurred_at) values (${randomUUID()}, ${X.id}, ${X.learners[0]}, ${X.device}, ${randomUUID()}, 1, 'app_opened', 1, now())`],
        ["assessment_attempts", (sp) => sp`insert into bnl.assessment_attempts (household_id, learner_id, device_id, lesson_id, lesson_version_id, client_attempt_id, stage, seed) values (${Y.id}, ${X.learners[0]}, ${Y.device}, ${MULT_TABLE_7}, ${versionId}, ${randomUUID()}, 'baseline', 's')`],
        ["review_schedule", (sp) => sp`insert into bnl.review_schedule (household_id, learner_id, lesson_id, due_at) values (${X.id}, ${X.learners[0]}, ${MULT_TABLE_7}, now())`],
        ["migration_runs", (sp) => sp`insert into bnl.migration_runs (household_id, device_id, migration_run_id, legacy_fingerprint) values (${X.id}, ${X.device}, ${randomUUID()}, ${sha("x")})`],
        ["audit_logs", (sp) => sp`insert into bnl.audit_logs (household_id, action, target_type) values (${X.id}, 'forged', 'household')`],
        ["idempotency_keys", (sp) => sp`insert into bnl.idempotency_keys (key, scope, actor_or_device, household_id, request_sha256) values ('forged-key-1', 's', ${X.device}, ${X.id}, ${sha("r")})`],
        ["move own progress row into X", (sp) => sp`update bnl.learner_progress set household_id = ${X.id} where household_id = ${Y.id}`],
      ];
      for (const [label, run] of attempts) {
        const p = await probe(sql, run);
        expect(p.ok, `${label} must fail, got ${JSON.stringify(p)}`).toBe(false);
        if (!p.ok) expect(["42501", "23503", "55000"], label).toContain(p.code);
      }
    });
  });

  it("household Y's owner cannot join, invite into, consent for, pair into, request deletion for, or plan for household X", async () => {
    await rolledBack(adult(Y.owner), async (sql) => {
      const attempts: [string, (sp: TransactionSql) => Promise<{ count: number }>][] = [
        ["self-invite into X", (sp) => sp`insert into bnl.household_memberships (household_id, auth_user_id, role, invited_by) values (${X.id}, ${Y.owner}, 'owner', ${Y.owner})`],
        ["move own membership to X", (sp) => sp`update bnl.household_memberships set household_id = ${X.id} where auth_user_id = ${Y.owner}`],
        ["consent for X", (sp) => sp`insert into bnl.consent_records (household_id, guardian_auth_user_id, consent_version) values (${X.id}, ${Y.owner}, 'v1')`],
        ["device row in X", (sp) => sp`insert into bnl.paired_devices (household_id, label) values (${X.id}, 'Intruder TV')`],
        ["deletion request for X", (sp) => sp`insert into bnl.data_deletion_requests (household_id, requested_by, scope) values (${X.id}, ${Y.owner}, 'household')`],
        ["school plan in X", (sp) => sp`insert into bnl.school_plans (household_id, grade, subject_key, academic_year) values (${X.id}, 2, 'math', '2026-27')`],
        ["learner in X", (sp) => sp`insert into bnl.learner_profiles (household_id, slot, display_name, grade, avatar_id) values (${X.id}, 1, 'Intruder', 2, 'fox')`],
        ["move own learner to X", (sp) => sp`update bnl.learner_profiles set household_id = ${X.id} where household_id = ${Y.id}`],
        ["read device refresh hashes", (sp) => sp`select refresh_token_hash from bnl.paired_devices`],
        ["read pairing poll secrets of claimed codes", (sp) => sp`select poll_secret_hash from bnl.device_pairing_codes where household_id = ${X.id}`],
      ];
      for (const [label, run] of attempts) {
        const p = await probe(sql, run);
        if (p.ok) expect(p.count, label).toBe(0);
        else expect(["42501", "23503", "23505"], label).toContain(p.code);
      }
    });
  });

  it("a guardian (not owner) cannot escalate inside their own household", async () => {
    await rolledBack(adult(X.guardian), async (sql) => {
      expect((await probe(sql, (sp) => sp`update bnl.household_memberships set role = 'owner' where auth_user_id = ${X.guardian}`))).toEqual({ ok: true, count: 0 });
      expect((await probe(sql, (sp) => sp`update bnl.household_memberships set revoked_at = now() where auth_user_id = ${X.owner}`))).toEqual({ ok: true, count: 0 });
      const invite = await probe(sql, (sp) => sp`insert into bnl.household_memberships (household_id, auth_user_id, role, invited_by) values (${X.id}, ${randomUUID()}, 'guardian', ${X.guardian})`);
      expect(invite).toEqual({ ok: false, code: "42501" });
      const deletion = await probe(sql, (sp) => sp`insert into bnl.data_deletion_requests (household_id, requested_by, scope) values (${X.id}, ${X.guardian}, 'household')`);
      expect(deletion).toEqual({ ok: false, code: "42501" });
      expect((await probe(sql, (sp) => sp`update bnl.households set label = 'renamed' where id = ${X.id}`))).toEqual({ ok: true, count: 0 });
    });
  });

  it("an owner cannot demote or revoke themselves (lock-out) and can only invite on their own behalf", async () => {
    await rolledBack(adult(X.owner), async (sql) => {
      expect(await probe(sql, (sp) => sp`update bnl.household_memberships set revoked_at = now() where auth_user_id = ${X.owner}`)).toEqual({ ok: true, count: 0 });
      const forgedInviter = await probe(sql, (sp) => sp`insert into bnl.household_memberships (household_id, auth_user_id, role, invited_by) values (${X.id}, ${randomUUID()}, 'guardian', ${Y.owner})`);
      expect(forgedInviter).toEqual({ ok: false, code: "42501" });
    });
  });
});

describe("adults and devices reading staff/ops tables", () => {
  const STAFF_OR_OPS = ["quiz_items", "publication_records", "media_assets", "lesson_outcomes", "source_documents", "score_runs",
    "aggregation_runs", "job_runs", "rate_limit_buckets"];
  it.each([
    ["owner of X", () => adult(X.owner)],
    ["device of X", () => device(X)],
  ])("%s gets no rows or a privilege error from staff/ops tables", async (_name, ctx) => {
    await rolledBack(ctx(), async (sql) => {
      for (const t of STAFF_OR_OPS) {
        expectDenied(await probe(sql, async (sp) => ({ count: (await sp.unsafe(`select 1 from bnl.${t} limit 5`)).length })), `${t}`);
      }
      // Draft lesson versions and staff-only audit rows stay invisible.
      expectDenied(await probe(sql, async (sp) => ({ count: (await sp`select 1 from bnl.lesson_versions where not bnl.version_was_published(id)`).length })), "draft versions");
      expectDenied(await probe(sql, async (sp) => ({ count: (await sp`select 1 from bnl.audit_logs where household_id is null`).length })), "staff audit rows");
      expectDenied(await probe(sql, async (sp) => ({ count: (await sp`select 1 from bnl.staff_roles`).length })), "staff_roles of others");
    });
  });

  it("an adult cannot see another user's staff roles; a staff user sees only their own", async () => {
    await rolledBack(staffCtx(EDITOR), async (sql) => {
      const rows = await sql<{ auth_user_id: string }[]>`select auth_user_id from bnl.staff_roles`;
      expect(new Set(rows.map((r) => r.auth_user_id))).toEqual(new Set([EDITOR]));
    });
  });
});

describe("SECURITY DEFINER functions called with household X's ids", () => {
  it("score_answer: Y's device cannot score (or read the key of) X's attempt; X's revoked device is refused", async () => {
    await rolledBack(device(Y), async (sql) => {
      const p = await probe(sql, async (sp) => ({ count: (await sp`select * from bnl.score_answer(${X.attempt}, ${X.questionKey}, 'a')`).length }));
      expect(p).toEqual({ ok: false, code: "P0002" });
    });
    await rolledBack(device(X, X.revokedDevice), async (sql) => {
      const p = await probe(sql, async (sp) => ({ count: (await sp`select * from bnl.score_answer(${X.attempt}, ${X.questionKey}, 'a')`).length }));
      expect(p).toEqual({ ok: false, code: "42501" });
      const q = await probe(sql, async (sp) => ({ count: (await sp`select * from bnl.quiz_questions_for_version(${versionId})`).length }));
      expect(q).toEqual({ ok: false, code: "42501" });
    });
    // Forged context (household X, Y's device): device_ok() is false.
    await rolledBack({ kind: "device", householdId: X.id, deviceId: Y.device }, async (sql) => {
      const p = await probe(sql, async (sp) => ({ count: (await sp`select * from bnl.score_answer(${X.attempt}, ${X.questionKey}, 'a')`).length }));
      expect(p).toEqual({ ok: false, code: "42501" });
      const [t] = await sql<{ v: number | null }[]>`select bnl.touch_device() as v`;
      expect(t!.v).toBeNull();
    });
  });

  it("quiz_questions_for_version never returns answer keys, and refuses a draft version", async () => {
    await rolledBack(device(X), async (sql) => {
      const rows = await sql`select * from bnl.quiz_questions_for_version(${versionId})`;
      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(rows)).not.toMatch(/correct/i);
      const [draft] = await admin<{ id: string }[]>`select id from bnl.lesson_versions where status = 'draft' limit 1`;
      if (draft) {
        expect(await probe(sql, async (sp) => ({ count: (await sp`select * from bnl.quiz_questions_for_version(${draft.id})`).length })))
          .toEqual({ ok: false, code: "P0002" });
      }
    });
  });

  it("revoke_device / approve_pairing: Y's owner cannot revoke X's TV or pair a TV into X", async () => {
    await rolledBack(adult(Y.owner), async (sql) => {
      const [r] = await sql<{ ok: boolean }[]>`select bnl.revoke_device(${X.device}) as ok`;
      expect(r!.ok).toBe(false);
      expect(await probe(sql, async (sp) => ({ count: (await sp`select * from bnl.approve_pairing(${sha("whatever")}, ${X.id}, 'TV')`).length })))
        .toEqual({ ok: false, code: "42501" });
    });
    const [d] = await admin`select revoked_at from bnl.paired_devices where id = ${X.device}`;
    expect(d!.revoked_at).toBeNull();
  });

  it("rotate_device_refresh: a guessed or foreign hash rotates nothing; revoked devices cannot rotate", async () => {
    await rolledBack({ kind: "public" }, async (sql) => {
      expect(await sql`select * from bnl.rotate_device_refresh(${sha("guess")}, ${sha("new")})`).toHaveLength(0);
    });
    const [rev] = await admin`select refresh_token_hash from bnl.paired_devices where id = ${X.revokedDevice}`;
    expect(rev!.refresh_token_hash).toBeNull();
  });

  it("redeem_pairing: an already-claimed code of X cannot be redeemed with a guessed poll secret", async () => {
    const [code] = await admin<{ pairing_id: string }[]>`select pairing_id from bnl.device_pairing_codes where household_id = ${X.id}`;
    await rolledBack({ kind: "public" }, async (sql) => {
      const [r] = await sql<{ status: string; device_id: string | null }[]>`select * from bnl.redeem_pairing(${code!.pairing_id}, ${sha("guess")}, ${sha("refresh")})`;
      expect(r).toMatchObject({ status: "invalid_secret", device_id: null });
    });
  });

  it("job/staff/adult-only functions are not callable from other request roles", async () => {
    const calls: [DbContext, string][] = [
      [adult(X.owner), "select bnl.purge_expired(90, 395)"],
      [adult(X.owner), "select bnl.purge_expired_analytics(395)"],
      [adult(X.owner), `select * from bnl.publish_lesson_version('${MULT_TABLE_7}', '${versionId}', 'x', '${X.owner}')`],
      [device(X), "select bnl.create_household('x')"],
      [device(X), `select bnl.revoke_device('${Y.device}')`],
      [device(X), "select bnl.purge_expired(90, 395)"],
      [staffCtx(PUBLISHER), "select bnl.purge_expired(90, 395)"],
      [staffCtx(PUBLISHER), `select bnl.revoke_device('${X.device}')`],
      [{ kind: "public" }, "select bnl.touch_device()"],
      [{ kind: "public" }, `select * from bnl.score_answer('${X.attempt}', 'k', 'a')`],
      [{ kind: "public" }, `select * from bnl.quiz_questions_for_version('${versionId}')`],
      [{ kind: "job" }, `select * from bnl.score_answer('${X.attempt}', 'k', 'a')`],
      [{ kind: "job" }, `select bnl.revoke_device('${X.device}')`],
    ];
    for (const [ctx, q] of calls) {
      await expect(withDbContext(db, ctx, (sql) => sql.unsafe(q)), `${ctx.kind}: ${q}`).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("staff workflow functions refuse an actor id that is not the session user (publisher impersonating another publisher)", async () => {
    await rolledBack(staffCtx(EDITOR), async (sql) => {
      expect(await probe(sql, async (sp) => ({ count: (await sp`select * from bnl.publish_lesson_version(${MULT_TABLE_7}, ${versionId}, 'x', ${PUBLISHER})`).length })))
        .toEqual({ ok: false, code: "42501" });
      expect(await probe(sql, async (sp) => ({ count: (await sp`select * from bnl.unpublish_lesson(${MULT_TABLE_7}, 'x', ${PUBLISHER})`).length })))
        .toEqual({ ok: false, code: "42501" });
    });
  });
});

describe("SQL-level role switches from inside a request context", () => {
  it("bnl_app is a plain NOINHERIT login: no superuser, BYPASSRLS, CREATEROLE or CREATEDB anywhere in the bnl role set", async () => {
    const rows = await admin<{ rolname: string; rolsuper: boolean; rolinherit: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolcanlogin: boolean }[]>`
      select rolname, rolsuper, rolinherit, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin from pg_roles where rolname like 'bnl%' order by 1`;
    for (const r of rows) {
      expect(r, r.rolname).toMatchObject({ rolsuper: false, rolinherit: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
      expect(r.rolcanlogin, r.rolname).toBe(r.rolname === "bnl_app");
    }
    const members = await admin<{ grp: string }[]>`
      select g.rolname as grp from pg_auth_members m join pg_roles g on g.oid = m.roleid join pg_roles u on u.oid = m.member
      where u.rolname = 'bnl_app' order by 1`;
    expect(members.map((m) => m.grp)).toEqual(["bnl_adult", "bnl_device", "bnl_job", "bnl_public", "bnl_staff"]);
  });

  it("a request context can never become bnl_owner, postgres, anon or another login", async () => {
    for (const target of ["bnl_owner", "postgres", "anon", "authenticated"]) {
      await expect(withDbContext(db, device(Y), (sql) => sql.unsafe(`set local role ${target}`)), target).rejects.toMatchObject({ code: "42501" });
      await expect(withDbContext(db, adult(Y.owner), (sql) => sql.unsafe(`set session authorization ${target}`)), target).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("bnl_device trying another household by rewriting its own settings sees nothing (device_ok binds device to household)", async () => {
    await rolledBack(device(Y), async (sql) => {
      await sql`select set_config('bnl.household_id', ${X.id}, true)`;
      expect(await sql`select id from bnl.learner_profiles`).toHaveLength(0);
      expect(await sql`select id from bnl.learner_progress`).toHaveLength(0);
      await sql`select set_config('bnl.device_id', ${X.revokedDevice}, true)`;
      expect(await sql`select id from bnl.learner_profiles`).toHaveLength(0);
    });
  });

  it("bnl_device switching to bnl_adult carries no adult identity: zero household rows", async () => {
    await rolledBack(device(Y), async (sql) => {
      await sql.unsafe("set local role bnl_adult");
      expect(await sql`select id from bnl.learner_profiles`).toHaveLength(0);
      expect(await sql`select id from bnl.households`).toHaveLength(0);
    });
  });

  it("bnl_adult switching to bnl_staff without a staff role sees no item bank, drafts or staff audit", async () => {
    await rolledBack(adult(X.owner), async (sql) => {
      await sql.unsafe("set local role bnl_staff");
      expect(await sql`select id from bnl.quiz_items`).toHaveLength(0);
      expect(await sql`select id from bnl.lesson_versions`).toHaveLength(0);
      expect(await sql`select id from bnl.audit_logs`).toHaveLength(0);
      expect(await probe(sql, (sp) => sp`select 1 from bnl.learner_profiles`)).toEqual({ ok: false, code: "42501" });
    });
  });

  /**
   * TRUST BOUNDARY (documented residual risk R1 in docs/security/SECURITY_REVIEW.md): the request roles are a
   * defence against handler bugs that pick the wrong context, not against arbitrary SQL. Any code that can run
   * arbitrary SQL on the bnl_app login can SET ROLE bnl_job (or forge bnl.actor_id). The mitigation is that no
   * request path builds SQL from input (see `no interpolated sql.unsafe` in apps/admin/test/redteam). If this test
   * starts failing, the boundary changed: update the review.
   */
  it("RESIDUAL R1: arbitrary SQL on the bnl_app login can switch to bnl_job (documents the trust boundary)", async () => {
    const n = await rolledBack(device(Y), async (sql) => {
      await sql.unsafe("set local role bnl_job");
      return (await sql<{ n: number }[]>`select count(*)::int as n from bnl.learner_profiles where household_id = ${X.id}`)[0]!.n;
    });
    expect(n).toBe(2);
  });
});

describe("storage keys and private uploads", () => {
  it("object keys are household-prefixed (DB check) and invisible across households and to the public", async () => {
    await expect(admin`insert into bnl.syllabus_uploads (household_id, school_plan_id, object_key, sha256, mime_type, size_bytes)
      select ${X.id}, school_plan_id, ${`${Y.id}/smuggled`}, ${sha("s")}, 'text/csv', 1 from bnl.syllabus_uploads where id = ${X.upload}`)
      .rejects.toMatchObject({ code: "23514" });
    for (const ctx of [adult(Y.owner), device(X), device(Y), { kind: "public" } as DbContext, staffCtx(EDITOR)]) {
      await rolledBack(ctx, async (sql) => {
        expectDenied(await probe(sql, async (sp) => ({ count: (await sp`select object_key from bnl.syllabus_uploads where object_key = ${X.objectKey}`).length })), `${ctx.kind} object key`);
      });
    }
  });
});

describe("pairing-code claims (defence in depth below the BFF)", () => {
  /**
   * FINDING A9-SEC-01 (docs/security/SECURITY_REVIEW.md): device_pairing_codes.device_id references
   * paired_devices(id) only, and the adult_claim policy checks household_id but not that device_id belongs to it.
   * A bnl_adult statement can therefore claim a pending code for its own household while pointing device_id at
   * ANOTHER household's TV; bnl.redeem_pairing (bnl_public) would then install a refresh-token hash on that foreign
   * device, and bnl.rotate_device_refresh would mint credentials for the foreign household. The HTTP redeem handler
   * blocks this (it re-checks device.household_id === code.household_id; see
   * apps/admin/test/integration/redteam-routes.test.ts), so it is not reachable through the API today.
   * Fix: migration 0008 in docs/adr/proposals/A9-qa-ops.md (composite FK + redeem check). Remove `.fails` then.
   */
  it.fails("A9-SEC-01: an adult cannot claim a pending code for a device of another household", async () => {
    const pairingId = randomUUID();
    const codeHash = sha(`pending-${pairingId}`);
    await rolledBack({ kind: "public" }, async (sql) => {
      await sql`select bnl.create_pairing_code(${pairingId}, ${codeHash}, ${sha("poll")}, ${new Date(Date.now() + 300_000)})`;
      await sql.unsafe("set local role bnl_adult");
      await sql`select set_config('bnl.actor_id', ${Y.owner}, true)`;
      const claim = await probe(sql, (sp) => sp`
        update bnl.device_pairing_codes set household_id = ${Y.id}, approved_by = ${Y.owner}, approved_at = now(), device_id = ${X.device}
         where code_hash = ${codeHash}`);
      // Secure behaviour: the claim is refused (FK or policy), so redeem can never touch X's device.
      expect(claim.ok ? `claimed ${claim.count} row(s)` : claim.code).toMatch(/^(42501|23503)$/);
    });
  });

  it("A9-SEC-01 impact check: redeem_pairing installs the hash on the foreign device when such a claim exists", async () => {
    // Documents the impact so the fix can be verified: after 0008 the setup below must fail at the claim.
    const pairingId = randomUUID();
    const codeHash = sha(`pending-${pairingId}`);
    const result = await rolledBack({ kind: "public" }, async (sql) => {
      await sql`select bnl.create_pairing_code(${pairingId}, ${codeHash}, ${sha("poll")}, ${new Date(Date.now() + 300_000)})`;
      await sql.unsafe("set local role bnl_adult");
      await sql`select set_config('bnl.actor_id', ${Y.owner}, true)`;
      const claim = await probe(sql, (sp) => sp`
        update bnl.device_pairing_codes set household_id = ${Y.id}, approved_by = ${Y.owner}, approved_at = now(), device_id = ${X.device}
         where code_hash = ${codeHash}`);
      if (!claim.ok) return { blocked: true as const };
      await sql.unsafe("set local role bnl_public");
      const [r] = await sql<{ status: string; device_id: string; household_id: string }[]>`
        select * from bnl.redeem_pairing(${pairingId}, ${sha("poll")}, ${sha("attacker-refresh")})`;
      const [rot] = await sql<{ household_id: string }[]>`select * from bnl.rotate_device_refresh(${sha("attacker-refresh")}, ${sha("attacker-2")})`;
      return { blocked: false as const, redeem: r, rotatedHousehold: rot?.household_id ?? null };
    });
    if (result.blocked) return; // fixed
    expect(result.redeem).toMatchObject({ status: "redeemed", device_id: X.device });
    expect(result.rotatedHousehold).toBe(X.id);
  });
});
