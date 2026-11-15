import { describe, expect, it } from "vitest";
import type { LearningEvent, TelemetryAck } from "@bnl/contracts";
import { activeDays, checkEvent, reduceSessions, TelemetryQueue, QUEUE_MAX_EVENTS } from "../src";

const DEV = "5e4d3c2b-1a09-4f8e-8d7c-6b5a4f3e2d33";
const LEARNER = "2f9d6c1b-8a7e-4f3d-9b2a-1c0e5d4f3a22";
const OTHER = "9f9d6c1b-8a7e-4f3d-9b2a-1c0e5d4f3a99";
const LESSON = "f95143b0-7b4c-5452-8a3f-71096a538dff";
const SESSION = "8c1f0a77-1d2e-4c55-8f3e-6a2b9d0c4e21";
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const t0 = Date.parse("2026-11-14T09:00:00Z");

function ev(type: LearningEvent["event_type"], seq: number, payload: LearningEvent["payload"] = {}, extra: Partial<LearningEvent> = {}): LearningEvent {
  const at = new Date(t0 + seq * 1000).toISOString();
  return { event_id: uuid(), schema_version: 1, event_type: type, occurred_at: at, sent_at: at, client_session_id: SESSION, client_sequence: seq, learner_id: LEARNER, device_id: DEV, lesson_id: LESSON, payload, ...extra };
}
const scope = { deviceId: DEV, learnerIds: new Set([LEARNER]), knownLessonIds: new Set([LESSON]) };
const now = new Date(t0 + 60_000);

describe("server validation", () => {
  it("accepts a valid scoped event", () => expect(checkEvent(ev("app_opened", 1), scope, now).ok).toBe(true));
  it("TEL-004: forged learner id rejected", () => {
    const r = checkEvent(ev("app_opened", 1, {}, { learner_id: OTHER }), scope, now);
    expect(r).toMatchObject({ ok: false, code: "learner_not_in_household" });
  });
  it("TEL-004: future timestamp beyond skew rejected", () => {
    const r = checkEvent(ev("app_opened", 1, {}, { occurred_at: new Date(t0 + 3_600_000).toISOString(), sent_at: new Date(t0 + 3_600_000).toISOString() }), scope, now);
    expect(r).toMatchObject({ ok: false, code: "clock_skew_future" });
  });
  it("accepts 72h offline arrival, rejects older", () => {
    const old = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
    expect(checkEvent(ev("app_opened", 1, {}, { occurred_at: old(71), sent_at: old(71) }), scope, now).ok).toBe(true);
    expect(checkEvent(ev("app_opened", 1, {}, { occurred_at: old(73), sent_at: old(73) }), scope, now)).toMatchObject({ code: "too_old" });
  });
  it("other device's events and schema violations rejected with codes", () => {
    expect(checkEvent(ev("app_opened", 1, {}, { device_id: OTHER }), scope, now)).toMatchObject({ code: "device_mismatch" });
    expect(checkEvent({ ...ev("app_opened", 1), payload: { is_correct: true } }, scope, now)).toMatchObject({ code: "schema_invalid" });
    expect(checkEvent("garbage", scope, now)).toEqual({ ok: false, event_id: null, code: "schema_invalid" });
  });
});

describe("active time reducer", () => {
  it("TEL-002: hidden tab for 120s contributes zero; playback vs foreground separated", () => {
    const events = [
      ev("playback_heartbeat", 1, { foreground: true, playing: true, visible_ms: 30000, playback_ms: 30000 }),
      ev("playback_heartbeat", 2, { foreground: true, playing: false, visible_ms: 30000, playback_ms: 0 }),
      ...[3, 4, 5, 6].map((s) => ev("playback_heartbeat", s, { foreground: false, playing: false, visible_ms: 0, playback_ms: 0 })),
    ];
    const m = reduceSessions(events).get(SESSION)!;
    expect(m.playback_ms).toBe(30000);
    expect(m.foreground_estimated_ms).toBe(60000);
  });
  it("TEL-001: the same event twice counts once", () => {
    const hb = ev("playback_heartbeat", 1, { foreground: true, playing: true, visible_ms: 10000, playback_ms: 10000 });
    expect(reduceSessions([hb, hb, { ...hb }]).get(SESSION)!.playback_ms).toBe(10000);
  });
  it("TEL-008: out-of-order delivery gives no negative time and no duplicate slide completion", () => {
    const enter = ev("slide_entered", 1, { theme_key: "candy" }, { slide_id: "step-1" });
    const exit = ev("slide_exited", 2, { theme_key: "candy" }, { slide_id: "step-1" });
    const exit2 = ev("slide_exited", 3, { theme_key: "candy" }, { slide_id: "step-1" });
    const m = reduceSessions([exit2, exit, enter]).get(SESSION)!;
    expect(m.slides_completed.size).toBe(1);
    expect(m.playback_ms).toBeGreaterThanOrEqual(0);
  });
  it("a slide exited without being entered is not a completed slide", () => {
    const m = reduceSessions([ev("slide_exited", 2, {}, { slide_id: "step-9" })]).get(SESSION)!;
    expect(m.slides_completed.size).toBe(0);
  });
  it("TEL-007: activity days use the household time zone", () => {
    // 19:00Z on the 14th is 00:30 on the 15th in IST
    expect(activeDays(["2026-11-14T10:00:00Z", "2026-11-14T19:00:00Z"])).toEqual(["2026-11-14", "2026-11-15"]);
    expect(activeDays(["2026-11-14T10:00:00Z", "2026-11-14T11:00:00Z"])).toHaveLength(1);
  });
});

describe("client queue", () => {
  function memory() {
    let saved: LearningEvent[] = [];
    return { load: async () => saved.slice(), save: async (e: LearningEvent[]) => void (saved = e.slice()), get: () => saved };
  }
  it("TEL-003: survives reload, delivers in order, dedupes, and retries with backoff after failure", async () => {
    const store = memory();
    let online = false;
    const sent: string[][] = [];
    const transport = {
      send: async (batch: LearningEvent[]): Promise<TelemetryAck> => {
        if (!online) throw new Error("offline");
        sent.push(batch.map((e) => e.event_id));
        return { accepted: batch.map((e) => e.event_id), duplicates: [], rejected: [] };
      },
    };
    let clock = 0;
    const q1 = new TelemetryQueue(store, transport, () => clock, () => 0.5);
    await q1.init();
    const events = [1, 2, 3].map((s) => ev("app_opened", s));
    for (const e of events) await q1.enqueue(e);
    await q1.enqueue(events[0]!); // duplicate ignored
    await q1.flush(); // offline
    expect(q1.size).toBe(3);
    expect(q1.backoffMs()).toBeGreaterThan(0);

    // "reload": new queue instance from the same storage
    const q2 = new TelemetryQueue(store, transport, () => clock, () => 0.5);
    await q2.init();
    expect(q2.size).toBe(3);
    online = true;
    clock = 10 * 60_000;
    await q2.flush();
    expect(sent).toEqual([events.map((e) => e.event_id)]);
    expect(q2.size).toBe(0);
    expect(store.get()).toEqual([]);
  });
  it("bounded: drops heartbeats first, never quiz answers", async () => {
    const store = memory();
    const q = new TelemetryQueue(store, { send: async () => { throw new Error("x"); } });
    await q.init();
    await q.enqueue(ev("answer_submitted", 0, { question_version_key: "k", selected_option_id: "opt-3" }));
    for (let i = 1; i <= QUEUE_MAX_EVENTS + 10; i++) await q.enqueue(ev("playback_heartbeat", i, { foreground: true, playing: true, visible_ms: 1, playback_ms: 1 }));
    expect(q.size).toBe(QUEUE_MAX_EVENTS);
    expect(q.dropped).toBe(11);
    expect(store.get().some((e) => e.event_type === "answer_submitted")).toBe(true);
  }, 30_000);
});
