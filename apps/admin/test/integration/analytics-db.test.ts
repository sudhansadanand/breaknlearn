/**
 * A8 analytics on the real schema (RLS enforced through the bnl_app login): scoring job idempotency and
 * determinism, missing retention stays null (never 0), cross-tenant denial, dismiss grants, retention purge.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { MULTIPLICATION_LESSON_IDS } from "@bnl/contracts";
import * as summary from "../../src/app/api/v1/admin/analytics/summary/route";
import * as dismiss from "../../src/app/api/v1/admin/recommendations/[id]/dismiss/route";
import { runRetentionPurge, scoreLearners, setAnalyticsRepoForTesting } from "../../src/server/analytics";
import { setDepsForTesting } from "../../src/server/deps";
import { req } from "../fakes";
import { freshHousehold, openDbEnv, type DbEnv, type Household } from "../learning/db-env";

const T7 = MULTIPLICATION_LESSON_IDS[7]!;
const T8 = MULTIPLICATION_LESSON_IDS[8]!;
const DAY = 86_400_000;
let env: DbEnv;
let hh: Household;
let other: Household;
let version: string;
let items: { question_version_key: string; correct_option_id: string; options: { id: string }[] }[];

beforeAll(async () => {
  env = openDbEnv();
  setAnalyticsRepoForTesting(null);
  const [pub] = await env.admin<{ lesson_version_id: string }[]>`
    select lesson_version_id from bnl.publication_records where lesson_id = ${T7} and unpublished_at is null order by published_at desc limit 1`;
  version = pub!.lesson_version_id;
  items = await env.admin`select question_version_key, correct_option_id, options from bnl.quiz_items where lesson_version_id = ${version} order by sort_order`;
});
afterAll(async () => env.close());
beforeEach(async () => {
  setDepsForTesting(env.deps);
  hh = await freshHousehold(env);
  other = await freshHousehold(env);
});

/** Inserts a finished, server-scored attempt (as the A7 endpoints would leave it). */
async function attempt(h: Household, learner: string, stage: string, startedAt: Date, idx: number[], correct: number): Promise<string> {
  const keys = idx.map((i) => items[i]!.question_version_key);
  const [a] = await env.admin<{ id: string }[]>`
    insert into bnl.assessment_attempts (household_id, learner_id, device_id, lesson_id, lesson_version_id, client_attempt_id, stage, seed, question_keys, started_at)
    values (${h.householdId}, ${learner}, ${h.deviceId}, ${T7}, ${version}, ${randomUUID()}, ${stage}, 'synthetic-seed', ${env.admin.json(keys)}, ${startedAt}) returning id`;
  for (const [n, i] of idx.entries()) {
    const it = items[i]!;
    const opt = n < correct ? it.correct_option_id : it.options.find((o) => o.id !== it.correct_option_id)!.id;
    await env.admin`insert into bnl.question_responses (household_id, attempt_id, learner_id, question_version_key, selected_option_id, correct, answered_at)
      values (${h.householdId}, ${a!.id}, ${learner}, ${it.question_version_key}, ${opt}, ${n < correct}, ${new Date(startedAt.getTime() + (n + 1) * 5000)})`;
  }
  await env.admin`update bnl.assessment_attempts set finished_at = ${new Date(startedAt.getTime() + 60_000)} where id = ${a!.id}`;
  return a!.id;
}
async function watched(h: Household, learner: string, at: Date, lessonId = T7) {
  await env.admin`insert into bnl.learner_progress (household_id, learner_id, lesson_id, lesson_version_id, theme_key, attempt_id, slide_id, completed, completed_at, created_at, updated_at)
    values (${h.householdId}, ${learner}, ${lessonId}, ${lessonId === T7 ? version : null}, 'puppy', ${randomUUID()}, 'step-10', true, ${at}, ${at}, ${at})`;
}
const snapshots = (learner: string) =>
  env.admin<{ id: string; lesson_id: string | null; score: string | null; status: string; components: Record<string, number | null>; evidence: { flags: string[]; stages: { retention: { reason: string | null } } }; computed_at: Date }[]>`
    select id, lesson_id, score, status, components, evidence, computed_at from bnl.mastery_snapshots where learner_id = ${learner} order by lesson_id nulls first, score_date`;
const score = (asOf: string, learners: string[]) => scoreLearners(env.runner, { asOf, learnerIds: learners });

describe("scoring job (real DB)", () => {
  it("writes per-lesson and topic snapshots with evidence flags; missing retention is null, not 0", async () => {
    const kid = hh.learners[0];
    await watched(hh, kid, new Date("2026-10-01T09:00:00Z"));
    await attempt(hh, kid, "immediate", new Date("2026-10-01T09:10:00Z"), [0, 1, 2], 2);
    const r = await score("2026-10-02", [kid]);
    expect(r.snapshots_written).toBe(2);
    const rows = await snapshots(kid);
    expect(rows.map((x) => x.lesson_id)).toEqual([null, T7]);
    const lesson = rows[1]!;
    expect(lesson.status).toBe("provisional");
    expect(lesson.components.R).toBeNull();
    expect(lesson.components.M).toBeCloseTo(66.67, 1);
    expect(lesson.evidence.flags).toEqual(expect.arrayContaining(["provisional", "retention_not_measured"]));
    expect(lesson.evidence.stages.retention.reason).toBe("no_attempt");
    expect(new Date(lesson.computed_at).toISOString()).toBe("2026-10-02T23:59:59.999Z");
    // Job role writes go through RLS/grants; the run is recorded.
    const [run] = await env.admin<{ status: string }[]>`select status from bnl.score_runs where run_key = 'els:els-v1:2026-10-02'`;
    expect(run!.status).toBe("succeeded");
    const [job] = await env.admin<{ status: string }[]>`select status from bnl.job_runs where job_name = 'score_learners' and run_key = 'els:els-v1:2026-10-02'`;
    expect(job!.status).toBe("succeeded");
  });

  it("is idempotent per (learner, lesson, as_of) and deterministic; evidence after as-of is ignored", async () => {
    const kid = hh.learners[0];
    await watched(hh, kid, new Date("2026-10-01T09:00:00Z"));
    await attempt(hh, kid, "immediate", new Date("2026-10-01T09:10:00Z"), [0, 1, 2], 3);
    await score("2026-10-03", [kid]);
    const first = await snapshots(kid);
    const recs1 = await env.admin`select id, reason_code from bnl.recommendations where learner_id = ${kid} and superseded_at is null order by id`;
    // New evidence AFTER the as-of day must not change a re-run of that day.
    await attempt(hh, kid, "delayed", new Date("2026-10-06T09:00:00Z"), [6, 7, 8], 0);
    await score("2026-10-03", [kid]);
    await score("2026-10-03", [kid]);
    expect(await snapshots(kid)).toEqual(first);
    expect(await env.admin`select id, reason_code from bnl.recommendations where learner_id = ${kid} and superseded_at is null order by id`).toEqual(recs1);
    // A later as-of adds rows (history kept) and sees the delayed check: R measured as 0 (a real zero).
    await score("2026-10-07", [kid]);
    const all = await snapshots(kid);
    expect(all).toHaveLength(4);
    const latest = all.filter((x) => x.lesson_id === T7).at(-1)!;
    expect(latest.components.R).toBe(0);
    const active = await env.admin<{ reason_code: string }[]>`select reason_code from bnl.recommendations where learner_id = ${kid} and superseded_at is null`;
    expect(active.map((x) => x.reason_code)).toEqual(["retention_low_spaced_recall"]);
  });

  it("a dismissed recommendation stays dismissed across re-runs (reversible by the guardian)", async () => {
    const kid = hh.learners[1];
    await watched(hh, kid, new Date("2026-10-01T09:00:00Z"));
    await attempt(hh, kid, "immediate", new Date("2026-10-01T09:10:00Z"), [0, 1, 2], 0);
    await score("2026-10-08", [kid]);
    const [rec] = await env.admin<{ id: string; reason_code: string }[]>`select id, reason_code from bnl.recommendations where learner_id = ${kid} and superseded_at is null`;
    expect(rec!.reason_code).toBe("mastery_low_prerequisite_practice");
    const session = env.auth.sessionFor({ userId: hh.ownerUserId, email: "owner@synthetic.test" });
    const res = await dismiss.POST(req("POST", `/api/v1/admin/recommendations/${rec!.id}/dismiss`, { session }), { params: Promise.resolve({ id: rec!.id }) });
    expect(res.status).toBe(200);
    await score("2026-10-08", [kid]);
    const [after] = await env.admin<{ id: string; dismissed_at: Date | null }[]>`select id, dismissed_at from bnl.recommendations where learner_id = ${kid} and superseded_at is null`;
    expect(after!.id).toBe(rec!.id);
    expect(after!.dismissed_at).not.toBeNull();
  });
});

describe("scoring job: whole-database run and failure recording", () => {
  it("scores every learner in one job transaction and records failures without partial writes", async () => {
    const r = await scoreLearners(env.runner, { asOf: "2026-09-01" });
    expect(r.learners).toBeGreaterThanOrEqual(4);
    await expect(scoreLearners(env.runner, { asOf: "2026-13-01" })).rejects.toThrow(/YYYY-MM-DD/);
    const [job] = await env.admin<{ status: string }[]>`select status from bnl.job_runs where job_name = 'score_learners' and run_key = 'els:els-v1:2026-13-01'`;
    expect(job!.status).toBe("failed");
    await expect(scoreLearners(env.runner, { asOf: "2026-09-02", learnerIds: ["nope"] })).rejects.toThrow(/UUID/);
    expect(await env.admin`select 1 from bnl.score_runs where run_key = 'els:els-v1:2026-09-02' and status = 'succeeded'`).toHaveLength(0);
  });
});

describe("cross-tenant denial (real RLS)", () => {
  it("another household's adult cannot read or dismiss; API returns 404", async () => {
    const kid = hh.learners[0];
    await watched(hh, kid, new Date("2026-10-01T09:00:00Z"));
    await attempt(hh, kid, "immediate", new Date("2026-10-01T09:10:00Z"), [0, 1, 2], 0);
    await score("2026-10-08", [kid]);
    const [rec] = await env.admin<{ id: string }[]>`select id from bnl.recommendations where learner_id = ${kid} and superseded_at is null`;

    const outsider = env.auth.sessionFor({ userId: other.ownerUserId, email: "other@synthetic.test" });
    const s = await summary.GET(req("GET", `/api/v1/admin/analytics/summary?learner_id=${kid}`, { session: outsider }));
    expect(s.status).toBe(404);
    expect(s.headers.get("cache-control")).toBe("no-store");
    const d = await dismiss.POST(req("POST", `/api/v1/admin/recommendations/${rec!.id}/dismiss`, { session: outsider }), { params: Promise.resolve({ id: rec!.id }) });
    expect(d.status).toBe(404);

    const seen = await env.runner({ kind: "adult", userId: other.ownerUserId }, (sql) => sql`select count(*)::int as n from bnl.mastery_snapshots where learner_id = ${kid}`);
    expect(seen[0]!.n).toBe(0);
    const recsSeen = await env.runner({ kind: "adult", userId: other.ownerUserId }, (sql) => sql`select count(*)::int as n from bnl.recommendations where learner_id = ${kid}`);
    expect(recsSeen[0]!.n).toBe(0);

    // Own adult sees the data, and may only touch dismissed_at.
    const ownSummary = await summary.GET(req("GET", `/api/v1/admin/analytics/summary?learner_id=${kid}`, { session: env.auth.sessionFor({ userId: hh.ownerUserId, email: "o@synthetic.test" }) }));
    expect(ownSummary.status).toBe(200);
    await expect(env.runner({ kind: "adult", userId: hh.ownerUserId }, (sql) => sql`update bnl.recommendations set reason_code = 'ready_for_next_topic' where id = ${rec!.id}`)).rejects.toThrow(/permission denied/);
    await expect(env.runner({ kind: "adult", userId: hh.ownerUserId }, (sql) => sql`update bnl.mastery_snapshots set score = 100 where learner_id = ${kid}`)).rejects.toThrow(/permission denied/);
    // Devices cannot write scores.
    await expect(
      env.runner({ kind: "device", householdId: hh.householdId, deviceId: hh.deviceId }, (sql) =>
        sql`insert into bnl.mastery_snapshots (household_id, learner_id, score_date, status, confidence, components, weights_version) values (${hh.householdId}, ${kid}, '2026-10-01', 'provisional', 'low', '{}'::jsonb, 'x')`),
    ).rejects.toThrow(/permission denied/);
    // Adults cannot run the purge.
    await expect(env.runner({ kind: "adult", userId: hh.ownerUserId }, (sql) => sql`select bnl.purge_expired_analytics(395)`)).rejects.toThrow(/permission denied/);
  });
});

describe("retention purge (real DB)", () => {
  it("deletes only expired raw telemetry and aggregates; purged retention evidence becomes insufficient, not 0", async () => {
    const kid = hh.learners[0];
    const now = Date.now();
    const old = new Date(now - 400 * DAY);
    const recentish = new Date(now - 100 * DAY); // older than raw (90 d), younger than aggregates (395 d)
    // Old learning: immediate + delayed, both beyond 13 months.
    await attempt(hh, kid, "immediate", old, [0, 1, 2], 3);
    await attempt(hh, kid, "delayed", new Date(old.getTime() + 5 * DAY), [6, 7, 8], 3);
    const oldSession = randomUUID();
    const midSession = randomUUID();
    for (const [id, at] of [[oldSession, old], [midSession, recentish]] as const) {
      await env.admin`insert into bnl.learning_sessions (id, household_id, learner_id, device_id, client_session_id, started_at) values (${id}, ${hh.householdId}, ${kid}, ${hh.deviceId}, ${randomUUID()}, ${at})`;
      await env.admin`insert into bnl.learning_events (event_id, household_id, learner_id, device_id, session_id, client_session_id, client_sequence, event_type, schema_version, occurred_at, received_at)
        values (${randomUUID()}, ${hh.householdId}, ${kid}, ${hh.deviceId}, ${id}, ${randomUUID()}, 1, 'app_opened', 1, ${at}, ${at})`;
    }
    await env.admin`insert into bnl.mastery_snapshots (household_id, learner_id, lesson_id, score_date, status, confidence, components, weights_version, computed_at)
      values (${hh.householdId}, ${kid}, ${T8}, ${old.toISOString().slice(0, 10)}, 'provisional', 'low', '{"M":80,"R":null,"I":null,"C":null}'::jsonb, 'els-v1', ${old}),
             (${hh.householdId}, ${kid}, ${T8}, ${recentish.toISOString().slice(0, 10)}, 'provisional', 'low', '{"M":80,"R":null,"I":null,"C":null}'::jsonb, 'els-v1', ${recentish})`;

    const r = await runRetentionPurge(env.runner);
    expect(r.policy).toEqual({ rawTelemetryDays: 90, aggregateDays: 395 });
    const count = async (q: Promise<{ n: number }[]>) => (await q)[0]!.n;
    // Raw events: both older than 90 d are gone.
    expect(await count(env.admin`select count(*)::int as n from bnl.learning_events where learner_id = ${kid}`)).toBe(0);
    // Aggregates: only the >395 d session/snapshot/attempts are gone.
    expect(await count(env.admin`select count(*)::int as n from bnl.learning_sessions where id = ${oldSession}`)).toBe(0);
    expect(await count(env.admin`select count(*)::int as n from bnl.learning_sessions where id = ${midSession}`)).toBe(1);
    expect(await count(env.admin`select count(*)::int as n from bnl.mastery_snapshots where learner_id = ${kid}`)).toBe(1);
    expect(await count(env.admin`select count(*)::int as n from bnl.assessment_attempts where learner_id = ${kid}`)).toBe(0);
    expect(await count(env.admin`select count(*)::int as n from bnl.question_responses where learner_id = ${kid}`)).toBe(0);
    const [audit] = await env.admin<{ n: number }[]>`select count(*)::int as n from bnl.audit_logs where action = 'retention.purge_analytics'`;
    expect(audit!.n).toBeGreaterThan(0);
    // Idempotent: a second pass finds nothing of ours.
    await runRetentionPurge(env.runner);
    expect(await count(env.admin`select count(*)::int as n from bnl.learning_sessions where id = ${midSession}`)).toBe(1);

    // After the purge, scoring today: the lesson was watched but its quiz evidence expired → insufficient, R null.
    await watched(hh, kid, new Date(now - 2 * DAY));
    const today = new Date(now).toISOString().slice(0, 10);
    await score(today, [kid]);
    const rows = (await snapshots(kid)).filter((x) => x.lesson_id === T7);
    expect(rows.at(-1)).toMatchObject({ status: "insufficient_evidence", score: null });
    expect(rows.at(-1)!.components.R).toBeNull();

    // Fails closed on invalid windows.
    await expect(runRetentionPurge(env.runner, { rawTelemetryDays: 90, aggregateDays: 10 })).rejects.toThrow(RangeError);
    await expect(env.runner({ kind: "job" }, (sql) => sql`select bnl.purge_expired_analytics(5)`)).rejects.toThrow(/invalid aggregate retention/);
  });
});
