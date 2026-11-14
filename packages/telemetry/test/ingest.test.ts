import { describe, expect, it } from "vitest";
import type { LearningEvent } from "@bnl/contracts";
import { LATE_ARRIVAL_MS, checkEvent, isSuspectHeartbeat, reduceSessions, triageBatch } from "../src";

const DEV = "5e4d3c2b-1a09-4f8e-8d7c-6b5a4f3e2d33";
const LEARNER = "2f9d6c1b-8a7e-4f3d-9b2a-1c0e5d4f3a22";
const LEARNER_2 = "3f9d6c1b-8a7e-4f3d-9b2a-1c0e5d4f3a23";
const LESSON = "f95143b0-7b4c-5452-8a3f-71096a538dff";
const OTHER_LESSON = "02402664-c8e7-5408-ab92-292f6e20a308";
const VERSION = "7a000000-0000-4000-8000-000000000001";
const SESSION = "8c1f0a77-1d2e-4c55-8f3e-6a2b9d0c4e21";
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const now = new Date("2026-11-14T10:00:00Z");
const t0 = now.getTime() - 60_000;

function ev(type: LearningEvent["event_type"], seq: number, payload: LearningEvent["payload"] = {}, extra: Partial<LearningEvent> = {}): LearningEvent {
  const at = new Date(t0 + seq * 1000).toISOString();
  return { event_id: uuid(), schema_version: 1, event_type: type, occurred_at: at, sent_at: at, client_session_id: SESSION, client_sequence: seq, learner_id: LEARNER, device_id: DEV, payload, ...extra };
}
const scope = { deviceId: DEV, learnerIds: new Set([LEARNER, LEARNER_2]), knownLessonIds: new Set([LESSON, OTHER_LESSON]), lessonVersions: new Map([[VERSION, LESSON]]) };
const base = { scope, now, storedEventIds: new Set<string>(), storedSequences: [], sessionLearners: new Map<string, string>() };

describe("checkEvent lesson versions", () => {
  it("rejects unknown versions and versions of another lesson", () => {
    expect(checkEvent(ev("lesson_started", 0, {}, { lesson_id: LESSON, lesson_version_id: VERSION }), scope, now).ok).toBe(true);
    expect(checkEvent(ev("lesson_started", 0, {}, { lesson_id: OTHER_LESSON, lesson_version_id: VERSION }), scope, now)).toMatchObject({ code: "lesson_unknown" });
    expect(checkEvent(ev("lesson_started", 0, {}, { lesson_version_id: uuid() }), scope, now)).toMatchObject({ code: "lesson_unknown" });
  });
});

describe("triageBatch", () => {
  it("TEL-001: in-batch and already-stored duplicates are acknowledged, not accepted", () => {
    const a = ev("app_opened", 0);
    const b = ev("app_opened", 1);
    const t = triageBatch({ ...base, events: [a, a, b], storedEventIds: new Set([b.event_id]) });
    expect(t.accepted.map((x) => x.event.event_id)).toEqual([a.event_id]);
    expect(t.duplicates).toEqual([a.event_id, b.event_id]);
  });

  it("an occupied (session, sequence) slot with another id is sequence_regression", () => {
    const a = ev("app_opened", 3);
    const t = triageBatch({ ...base, events: [a], storedSequences: [{ client_session_id: SESSION, client_sequence: 3, event_id: uuid() }] });
    expect(t.rejected).toEqual([{ event_id: a.event_id, code: "sequence_regression" }]);
    const same = triageBatch({ ...base, events: [ev("app_opened", 4), ev("app_opened", 4)] });
    expect(same.rejected.map((r) => r.code)).toEqual(["sequence_regression"]);
  });

  it("quality flags: ok, sequence_gap, late_arrival, clock_adjusted, suspect (heartbeat or learner switch)", () => {
    const ok0 = ev("app_opened", 0);
    const ok1 = ev("app_opened", 1);
    const gap = ev("app_opened", 4);
    const lateAt = new Date(now.getTime() - LATE_ARRIVAL_MS - 1000).toISOString();
    const late = ev("app_opened", 2, {}, { client_session_id: uuid(), occurred_at: lateAt, sent_at: lateAt });
    const adjusted = ev("app_opened", 0, {}, { client_session_id: uuid(), sent_at: new Date(t0 - 1000).toISOString() });
    const hb = ev("playback_heartbeat", 5, { foreground: false, playing: true, visible_ms: 0, playback_ms: 5000 });
    const switched = ev("app_opened", 6, {}, { learner_id: LEARNER_2 });
    const t = triageBatch({ ...base, events: [ok0, ok1, gap, late, adjusted, hb, switched] });
    expect(t.accepted.map((a) => a.quality_flag)).toEqual(["ok", "ok", "sequence_gap", "late_arrival", "clock_adjusted", "suspect", "suspect"]);
  });

  it("rejections never become accepted and keep their codes", () => {
    const t = triageBatch({ ...base, events: ["junk", ev("app_opened", 0, {}, { learner_id: uuid() })] });
    expect(t.accepted).toEqual([]);
    expect(t.rejected.map((r) => r.code)).toEqual(["schema_invalid", "learner_not_in_household"]);
  });
});

describe("reducer honesty", () => {
  it("never credits more playback than visible foreground time", () => {
    const e = ev("playback_heartbeat", 1, { foreground: true, playing: true, visible_ms: 5000, playback_ms: 20000 });
    expect(isSuspectHeartbeat(e)).toBe(true);
    expect(reduceSessions([e]).get(SESSION)).toMatchObject({ playback_ms: 5000, foreground_estimated_ms: 5000 });
  });
});
