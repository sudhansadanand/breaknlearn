/** OPS-004, TEL-002, TEL-008: ingest through the endpoint, then the session aggregation job (real DB). */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { MULTIPLICATION_LESSON_IDS, TelemetryAck, type LearningEvent } from "@bnl/contracts";
import { aggregateSessions, jobKeyFor } from "../../src/server/learning/aggregate";
import { deviceRequest, heartbeat, makeEvent, type EventCtx } from "../learning/builders";
import { freshHousehold, openDbEnv, type DbEnv, type Household } from "../learning/db-env";
import { learningRoutes } from "../learning/routes";

let env: DbEnv;
let hh: Household;
let ctx: EventCtx;

beforeAll(() => {
  env = openDbEnv();
  process.env.FEATURE_TELEMETRY = "true";
});
afterAll(async () => {
  delete process.env.FEATURE_TELEMETRY;
  await env.close();
});
beforeEach(async () => {
  hh = await freshHousehold(env);
  ctx = { deviceId: hh.deviceId, learnerId: hh.learners[0], sessionId: randomUUID(), lessonId: MULTIPLICATION_LESSON_IDS[2]!, base: Date.now() - 10 * 60_000 };
});

async function ingest(events: LearningEvent[]) {
  const res = await learningRoutes.telemetryBatch.POST(deviceRequest("POST", "/api/v1/telemetry/batch", { bearer: hh.token, body: { events } }));
  expect(res.status).toBe(200);
  return TelemetryAck.parse(await res.json());
}
const sessionRow = async () =>
  (await env.admin`select id, playback_ms::int as playback, foreground_estimated_ms::int as foreground, interaction_count as interactions
                     from bnl.learning_sessions where device_id = ${hh.deviceId} and client_session_id = ${ctx.sessionId}`)[0]!;

describe("session aggregation job", () => {
  it("TEL-002: 120 s hidden contributes zero; playback and foreground are separate; OPS-004 rerun is identical", async () => {
    const events = [
      makeEvent(ctx, "lesson_started", 0),
      makeEvent(ctx, "playback_heartbeat", 1, heartbeat(true, true, 30_000, 30_000)),
      makeEvent(ctx, "playback_paused", 2),
      makeEvent(ctx, "playback_heartbeat", 3, heartbeat(true, false, 30_000, 0)),
      ...[4, 5, 6, 7].map((s) => makeEvent(ctx, "playback_heartbeat", s, heartbeat(false, false, 0, 0))), // 120 s hidden
      makeEvent(ctx, "app_hidden", 8),
    ];
    await ingest(events);
    const { id } = await sessionRow();
    const r1 = await aggregateSessions(env.runner, { sessionIds: [id] });
    expect(r1).toMatchObject({ sessions_considered: 1, sessions_changed: 1, events_considered: 9, totals: { playback_ms: 30_000, foreground_estimated_ms: 60_000, interaction_count: 2 } });
    expect(await sessionRow()).toMatchObject({ playback: 30_000, foreground: 60_000, interactions: 2 });

    const r2 = await aggregateSessions(env.runner, { sessionIds: [id] });
    expect(r2.totals).toEqual(r1.totals);
    expect(r2.sessions_changed).toBe(0);
    expect(await sessionRow()).toMatchObject({ playback: 30_000, foreground: 60_000, interactions: 2 });
    const [run] = await env.admin`select status, attempts, result from bnl.job_runs where job_name = 'aggregate_sessions' and run_key = ${jobKeyFor({ sessionIds: [id] })}`;
    expect(run).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(run!.result).toMatchObject({ totals: r1.totals, max_ingest_lag_ms: expect.any(Number) });
    const agg = await env.admin`select status from bnl.aggregation_runs where job_key = ${jobKeyFor({ sessionIds: [id] })}`;
    expect(agg).toEqual([{ status: "succeeded" }]);
  });

  it("TEL-008 / TEL-001: out-of-order and re-sent batches give no negative or inflated time; suspect heartbeats excluded", async () => {
    const hb = [1, 2, 3].map((s) => makeEvent(ctx, "playback_heartbeat", s, heartbeat(true, true, 20_000, 20_000)));
    const enter = makeEvent(ctx, "slide_entered", 4, { theme_key: "farm" }, { slide_id: "step-1" });
    const exit = makeEvent(ctx, "slide_exited", 5, { theme_key: "farm" }, { slide_id: "step-1" });
    const forged = makeEvent(ctx, "playback_heartbeat", 6, heartbeat(true, true, 1_000, 30_000)); // playback > visible → suspect
    await ingest([exit, hb[2]!, forged]);
    await ingest([hb[0]!, enter, hb[1]!, hb[2]!, exit]);
    const { id } = await sessionRow();
    const r = await aggregateSessions(env.runner, { sessionIds: [id] });
    expect(r.totals).toEqual({ playback_ms: 60_000, foreground_estimated_ms: 60_000, interaction_count: 1 });
    expect(r.events_excluded).toBe(1);
    expect(await env.admin`select count(*)::int as n from bnl.learning_events where client_session_id = ${ctx.sessionId}`).toEqual([{ n: 6 }]);
  });

  it("OPS-004: the CLI runner (bnl_job role) aggregates a date and a rerun yields identical totals", async () => {
    const day = new Date(ctx.base).toISOString().slice(0, 10);
    await ingest([makeEvent(ctx, "lesson_started", 0), makeEvent(ctx, "playback_heartbeat", 1, heartbeat(true, true, 12_000, 9_000))]);
    const script = fileURLToPath(new URL("../../../../scripts/jobs/aggregate-sessions.mjs", import.meta.url));
    const run = () => {
      const r = spawnSync(process.execPath, [script, "--date", day], { env: { ...process.env, BNL_JOB_DB_URL: process.env.BNL_TEST_DB_URL }, encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      return JSON.parse(r.stdout.trim().split("\n").at(-1)!) as { job_key: string; totals: Record<string, number>; sessions_considered: number };
    };
    const a = run();
    const b = run();
    expect(a.job_key).toBe(`sessions:date:${day}`);
    expect(b.totals).toEqual(a.totals);
    expect(b.sessions_considered).toBe(a.sessions_considered);
    expect(await sessionRow()).toMatchObject({ playback: 9_000, foreground: 12_000, interactions: 1 });
    const [jr] = await env.admin`select attempts, status from bnl.job_runs where job_name = 'aggregate_sessions' and run_key = ${a.job_key}`;
    expect(jr!.status).toBe("succeeded");
    expect(Number(jr!.attempts)).toBeGreaterThanOrEqual(2);
  });

  it("a failing run is recorded as failed (in its own transaction) and re-thrown", async () => {
    await expect(aggregateSessions(env.runner, { date: "2026-13-45" })).rejects.toThrow(/date/);
    const sid = randomUUID();
    let calls = 0;
    const flaky: typeof env.runner = (dbctx, fn) =>
      env.runner(dbctx, async (sql) => {
        calls++;
        const out = await fn(sql);
        if (calls === 1) throw new Error("simulated failure after compute");
        return out;
      });
    await expect(aggregateSessions(flaky, { sessionIds: [sid] })).rejects.toThrow("simulated failure");
    const [jr] = await env.admin`select status, error_message from bnl.job_runs where job_name = 'aggregate_sessions' and run_key = ${jobKeyFor({ sessionIds: [sid] })}`;
    expect(jr).toEqual({ status: "failed", error_message: "simulated failure after compute" });
  });
});
