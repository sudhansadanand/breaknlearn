import { describe, expect, it } from "vitest";
import { ProgressSyncRequest } from "../../../packages/contracts/src";
import { createProgressOutbox, OUTBOX_KEY, type SyncBody } from "../src/progress-outbox";
import { createTelemetryQueue, QUEUE_KEY, QUEUE_MAX_EVENTS, type Ack, type QueuedEvent } from "../src/telemetry-queue";
import { uuid4 } from "../src/util";
import { storeWith } from "./helpers";

const ev = (type = "playback_heartbeat"): QueuedEvent => ({ event_id: uuid4(), event_type: type });
const ackAll = (events: QueuedEvent[]): Ack => ({ accepted: events.map((e) => e.event_id), duplicates: [], rejected: [] });

describe("telemetry queue (port of @bnl/telemetry TelemetryQueue)", () => {
  it("dedupes, persists across reloads and flushes at 25 events or 30 s", () => {
    let now = 0;
    const store = storeWith({});
    const q = createTelemetryQueue(store, () => now, () => 0.5);
    const e = ev();
    q.enqueue(e);
    q.enqueue(e);
    expect(q.size()).toBe(1);
    expect(q.shouldFlush(0)).toBe(false);
    now = 30_000;
    expect(q.shouldFlush(0)).toBe(true);
    for (let i = 0; i < 24; i++) q.enqueue(ev());
    expect(q.shouldFlush(now)).toBe(true);
    const reloaded = createTelemetryQueue(store, () => now, () => 0.5);
    expect(reloaded.events().map((x) => x.event_id)).toEqual(q.events().map((x) => x.event_id));
  });

  it("removes acknowledged ids (accepted, duplicate, rejected) and keeps the rest", () => {
    const q = createTelemetryQueue(storeWith({}), () => 0, () => 0.5);
    const [a, b, c, d] = [ev(), ev(), ev(), ev()];
    [a, b, c, d].forEach((x) => q.enqueue(x));
    let key = "";
    q.flush((events, k, done) => {
      key = k;
      expect(events).toHaveLength(4);
      done({ accepted: [a.event_id], duplicates: [b.event_id], rejected: [{ event_id: c.event_id, code: "schema_invalid" }, { event_id: null, code: "schema_invalid" }] });
    });
    expect(key).toBe(`tb-${a.event_id}-4`);
    expect(q.events().map((x) => x.event_id)).toEqual([d.event_id]);
  });

  it("network failure keeps everything, backs off, and retries the identical batch with the same key", () => {
    let now = 0;
    const q = createTelemetryQueue(storeWith({}), () => now, () => 0);
    for (let i = 0; i < 3; i++) q.enqueue(ev());
    const sent: { key: string; ids: string[] }[] = [];
    const fail = (events: QueuedEvent[], key: string, done: (a: Ack | null) => void) => {
      sent.push({ key, ids: events.map((e) => e.event_id) });
      done(null);
    };
    q.flush(fail);
    expect(q.size()).toBe(3);
    expect(q.backoffMs()).toBe(1000); // base 2 s, jitter 0 → 1 s
    q.flush(fail); // inside the backoff window: nothing sent
    expect(sent).toHaveLength(1);
    now = 1000;
    q.flush((events, key, done) => {
      sent.push({ key, ids: events.map((e) => e.event_id) });
      done(ackAll(events));
    });
    expect(sent[1]).toEqual(sent[0]);
    expect(q.size()).toBe(0);
  });

  it("is bounded: drops oldest non-evidence events first, never evidence events", () => {
    const q = createTelemetryQueue(storeWith({}), () => 0, () => 0.5);
    const first = ev("answer_submitted");
    q.enqueue(first);
    for (let i = 0; i < QUEUE_MAX_EVENTS + 10; i++) q.enqueue(ev());
    expect(q.size()).toBe(QUEUE_MAX_EVENTS);
    expect(q.dropped()).toBe(11);
    expect(q.events()[0]!.event_id).toBe(first.event_id);
  });

  it("survives a corrupt stored queue", () => {
    const q = createTelemetryQueue(storeWith({ [QUEUE_KEY]: "{bad" }), () => 0, () => 0.5);
    expect(q.size()).toBe(0);
  });
});

describe("progress outbox (M09)", () => {
  const L = "11111111-1111-4111-8111-111111111111";
  const LESSON = "f95143b0-7b4c-5452-8a3f-71096a538dff";
  const A = "22222222-2222-4222-8222-222222222222";
  const rec = (slide: number, completed = false) => ({ learner_id: L, lesson_id: LESSON, lesson_version_id: null, theme_key: "candy", attempt_id: A, slide_index: slide, position_seconds: 2.5, completed });

  it("sends contract-valid bodies, coalesces updates and keeps completion monotonic within an attempt", () => {
    const store = storeWith({});
    const o = createProgressOutbox(store, () => 1762990000000);
    o.record(rec(3));
    o.record(rec(10, true));
    o.record(rec(1)); // live F2 flip (replay of same key) must not regress the attempt
    const bodies: SyncBody[] = [];
    o.flush((body, key, done) => {
      bodies.push(body);
      expect(key).toBe(`ps-${A}-1`);
      expect(ProgressSyncRequest.safeParse(body).success).toBe(true);
      done({ status: 200, body: { outcome: "applied", state: { server_revision: 1 } } });
    });
    expect(bodies).toEqual([expect.objectContaining({ slide_id: "step-10", completed: true, base_server_revision: null, client_revision: 1 })]);
    expect(o.pending()).toBe(0);
    o.record(rec(4));
    o.flush((body, _k, done) => {
      bodies.push(body);
      done({ status: 200, body: { outcome: "stale_ignored", state: { server_revision: 1 } } });
    });
    expect(bodies[1]).toMatchObject({ base_server_revision: 1, client_revision: 2, completed: true });
  });

  it("retries a request lost on the network with the identical body and key", () => {
    const store = storeWith({});
    const o = createProgressOutbox(store, () => 5);
    o.record(rec(2));
    const sent: { body: SyncBody; key: string }[] = [];
    o.flush((body, key, done) => {
      sent.push({ body, key });
      done({ status: 0, body: null });
    });
    o.record(rec(5)); // newer change while the first is in flight
    const reloaded = createProgressOutbox(store, () => 9); // survives a reload
    reloaded.flush((body, key, done) => {
      sent.push({ body, key });
      done({ status: 200, body: { state: { server_revision: 1 } } });
    });
    expect(sent[1]).toEqual(sent[0]);
    expect(reloaded.pending()).toBe(1); // the newer slide is still to be sent
    reloaded.flush((body, key, done) => {
      sent.push({ body, key });
      done({ status: 200, body: { state: { server_revision: 2 } } });
    });
    expect(sent[2]!.body).toMatchObject({ slide_id: "step-5", base_server_revision: 1, client_revision: 2 });
  });

  it("adopts the server revision on 409 conflict and drops terminally rejected attempts", () => {
    const store = storeWith({});
    const o = createProgressOutbox(store, () => 5);
    o.record(rec(2));
    o.flush((_b, _k, done) => done({ status: 409, body: { error: { code: "conflict", details: { server_revision: 7 } } } }));
    let base: number | null = null;
    o.flush((b, _k, done) => {
      base = b.base_server_revision;
      done({ status: 422, body: { error: { code: "validation_failed" } } });
    });
    expect(base).toBe(7);
    expect(o.pending()).toBe(0);
    expect(JSON.parse(store.getItem(OUTBOX_KEY)!)).toEqual({});
  });

  it("stops on 401 so the caller can refresh the token", () => {
    const o = createProgressOutbox(storeWith({}), () => 5);
    o.record(rec(2));
    let auth = false;
    o.flush((_b, _k, done) => done({ status: 401, body: null }), (a) => (auth = a));
    expect(auth).toBe(true);
    expect(o.pending()).toBe(1);
  });
});
