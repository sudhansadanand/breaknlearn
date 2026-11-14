/** TEL-001/004/005, SEC-003/004 for POST /telemetry/batch against the real schema + RLS. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ApiError, MULTIPLICATION_LESSON_IDS, TelemetryAck } from "@bnl/contracts";
import { deviceRequest, heartbeat, makeEvent, type EventCtx } from "../learning/builders";
import { freshHousehold, openDbEnv, revoke, type DbEnv, type Household } from "../learning/db-env";
import { learningRoutes } from "../learning/routes";

const LESSON_3 = MULTIPLICATION_LESSON_IDS[3]!;
let env: DbEnv;
let hh: Household;
let other: Household;
let ctx: EventCtx;

beforeAll(() => {
  env = openDbEnv();
});
afterAll(async () => {
  delete process.env.FEATURE_TELEMETRY;
  await env.close();
});
beforeEach(async () => {
  process.env.FEATURE_TELEMETRY = "true";
  hh = await freshHousehold(env);
  other = await freshHousehold(env);
  ctx = { deviceId: hh.deviceId, learnerId: hh.learners[0], sessionId: randomUUID(), lessonId: LESSON_3, base: Date.now() - 60_000 };
});

const post = (body: unknown, o: { bearer?: string; key?: string | null; raw?: string } = {}) =>
  learningRoutes.telemetryBatch.POST(
    deviceRequest("POST", "/api/v1/telemetry/batch", { bearer: o.bearer ?? hh.token, idempotencyKey: o.key, ...(o.raw === undefined ? { body } : { rawBody: o.raw }) }),
  );
const stored = async (ids: string[]) =>
  (await env.admin`select event_id from bnl.learning_events where event_id = any(${env.admin.array(ids)}::uuid[])`).map((r) => r.event_id as string);

describe("telemetry ingest (real DB)", () => {
  it("TEL-001: same event twice is stored once; replaying the batch (same or new key) is idempotent", async () => {
    const a = makeEvent(ctx, "lesson_started", 0);
    const b = makeEvent(ctx, "playback_heartbeat", 1, heartbeat(true, true, 10_000, 10_000));
    const key = `tb-${randomUUID()}`;
    const first = await post({ events: [a, b, a] }, { key });
    expect(first.status).toBe(200);
    const ack1 = TelemetryAck.parse(await first.json());
    expect(ack1).toEqual({ accepted: [a.event_id, b.event_id], duplicates: [a.event_id], rejected: [] });

    const replay = await post({ events: [a, b, a] }, { key });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(TelemetryAck.parse(await replay.json())).toEqual(ack1);

    const fresh = TelemetryAck.parse(await (await post({ events: [a, b] })).json());
    expect(fresh).toEqual({ accepted: [], duplicates: [a.event_id, b.event_id], rejected: [] });

    expect(await stored([a.event_id, b.event_id])).toHaveLength(2);
    const sessions = await env.admin`select household_id, learner_id from bnl.learning_sessions where device_id = ${hh.deviceId} and client_session_id = ${ctx.sessionId}`;
    expect(sessions).toEqual([{ household_id: hh.householdId, learner_id: hh.learners[0] }]);
    const [row] = await env.admin`select household_id, quality_flag, session_id is not null as linked from bnl.learning_events where event_id = ${b.event_id}`;
    expect(row).toEqual({ household_id: hh.householdId, quality_flag: "ok", linked: true });
  });

  it("same Idempotency-Key with a different batch is a 409 idempotency_conflict", async () => {
    const key = `tb-${randomUUID()}`;
    expect((await post({ events: [makeEvent(ctx, "app_opened", 0)] }, { key })).status).toBe(200);
    const res = await post({ events: [makeEvent(ctx, "app_opened", 1)] }, { key });
    expect(res.status).toBe(409);
    expect(ApiError.parse(await res.json()).error.code).toBe("idempotency_conflict");
  });

  it("TEL-004 / SEC-003: forged learner, other device, future skew, unknown lesson are rejected with codes and never stored", async () => {
    const forged = makeEvent(ctx, "app_opened", 0, {}, { learner_id: other.learners[0] });
    const foreignDevice = makeEvent(ctx, "app_opened", 1, {}, { device_id: other.deviceId });
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const skewed = makeEvent(ctx, "app_opened", 2, {}, { occurred_at: future, sent_at: future });
    const old = new Date(Date.now() - 73 * 3_600_000).toISOString();
    const tooOld = makeEvent(ctx, "app_opened", 3, {}, { occurred_at: old, sent_at: old });
    const unknownLesson = makeEvent(ctx, "lesson_started", 4, {}, { lesson_id: randomUUID() });
    const draftLesson = makeEvent(ctx, "lesson_started", 5, {}, { lesson_id: "1e000000-0000-4000-8000-000000000001" });
    const badVersion = makeEvent(ctx, "lesson_started", 6, {}, { lesson_version_id: randomUUID() });
    const good = makeEvent(ctx, "app_opened", 7);
    const all = [forged, foreignDevice, skewed, tooOld, unknownLesson, draftLesson, badVersion, good];
    const ack = TelemetryAck.parse(await (await post({ events: all })).json());
    expect(ack.accepted).toEqual([good.event_id]);
    expect(ack.rejected).toEqual([
      { event_id: forged.event_id, code: "learner_not_in_household" },
      { event_id: foreignDevice.event_id, code: "device_mismatch" },
      { event_id: skewed.event_id, code: "clock_skew_future" },
      { event_id: tooOld.event_id, code: "too_old" },
      { event_id: unknownLesson.event_id, code: "lesson_unknown" },
      { event_id: draftLesson.event_id, code: "lesson_unknown" },
      { event_id: badVersion.event_id, code: "lesson_unknown" },
    ]);
    expect(await stored(all.map((e) => e.event_id))).toEqual([good.event_id]);
    // The other household's learner got nothing.
    expect(await env.admin`select 1 from bnl.learning_events where learner_id = ${other.learners[0]}`).toHaveLength(0);
  });

  it("TEL-004: oversize body → 413, >100 events → 413, nothing stored", async () => {
    const big = makeEvent(ctx, "app_opened", 0);
    const raw = JSON.stringify({ events: [big], pad: "x".repeat(130 * 1024) });
    const res = await post(null, { raw });
    expect(res.status).toBe(413);
    expect(ApiError.parse(await res.json()).error.code).toBe("payload_too_large");
    const many = Array.from({ length: 101 }, (_, i) => makeEvent(ctx, "playback_heartbeat", i, heartbeat(true, true, 1000, 1000)));
    expect((await post({ events: many })).status).toBe(413);
    expect(await stored([big.event_id, ...many.map((e) => e.event_id)])).toEqual([]);
  });

  it("TEL-005: a client correctness field is never accepted (payload or envelope)", async () => {
    const inPayload = { ...makeEvent(ctx, "answer_submitted", 0, { selected_option_id: "b" }), payload: { selected_option_id: "b", is_correct: true } };
    const inEnvelope = { ...makeEvent(ctx, "answer_submitted", 1, { selected_option_id: "b" }), is_correct: true };
    const nameInPayload = { ...makeEvent(ctx, "profile_selected", 2), payload: { display_name: "Asha" } };
    const ack = TelemetryAck.parse(await (await post({ events: [inPayload, inEnvelope, nameInPayload] })).json());
    expect(ack.accepted).toEqual([]);
    expect(ack.rejected.map((r) => r.code)).toEqual(["schema_invalid", "schema_invalid", "schema_invalid"]);
    expect(await stored([inPayload.event_id, inEnvelope.event_id, nameInPayload.event_id])).toEqual([]);
    // Defence in depth: the table itself refuses is_correct.
    await expect(env.admin`insert into bnl.learning_events (event_id, household_id, learner_id, device_id, client_session_id, client_sequence, event_type, schema_version, occurred_at, payload)
      values (${randomUUID()}, ${hh.householdId}, ${hh.learners[0]}, ${hh.deviceId}, ${ctx.sessionId}, 99, 'answer_submitted', 1, now(), '{"is_correct": true}')`).rejects.toThrow();
  });

  it("SEC-004: a revoked device is refused (401) and writes nothing", async () => {
    await revoke(env, hh.deviceId);
    const e = makeEvent(ctx, "app_opened", 0);
    expect((await post({ events: [e] })).status).toBe(401);
    expect(await stored([e.event_id])).toEqual([]);
  });

  it("requires Idempotency-Key (422) and a device token (401); feature flag off → 503 feature_disabled", async () => {
    const e = makeEvent(ctx, "app_opened", 0);
    expect((await post({ events: [e] }, { key: null })).status).toBe(422);
    expect((await learningRoutes.telemetryBatch.POST(deviceRequest("POST", "/api/v1/telemetry/batch", { body: { events: [e] } }))).status).toBe(401);
    process.env.FEATURE_TELEMETRY = "false";
    const off = await post({ events: [e] });
    expect(off.status).toBe(503);
    expect(ApiError.parse(await off.json()).error.code).toBe("feature_disabled");
    expect(await stored([e.event_id])).toEqual([]);
  });

  it("quality flags: late arrival, sequence gap, suspect heartbeat; same slot with another id is sequence_regression", async () => {
    const lateAt = new Date(Date.now() - 30 * 3_600_000).toISOString();
    const late = makeEvent(ctx, "app_opened", 0, {}, { occurred_at: lateAt, sent_at: lateAt });
    const gap = makeEvent(ctx, "app_opened", 5);
    const suspect = makeEvent(ctx, "playback_heartbeat", 6, heartbeat(false, true, 0, 20_000));
    const ack = TelemetryAck.parse(await (await post({ events: [late, gap, suspect] })).json());
    expect(ack.accepted).toHaveLength(3);
    const flags = await env.admin`select event_id, quality_flag from bnl.learning_events where client_session_id = ${ctx.sessionId}`;
    expect(Object.fromEntries(flags.map((f) => [f.event_id, f.quality_flag]))).toEqual({ [late.event_id]: "late_arrival", [gap.event_id]: "sequence_gap", [suspect.event_id]: "suspect" });
    const clash = makeEvent(ctx, "app_opened", 5);
    expect(TelemetryAck.parse(await (await post({ events: [clash] })).json()).rejected).toEqual([{ event_id: clash.event_id, code: "sequence_regression" }]);
  });
});
