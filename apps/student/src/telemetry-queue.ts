/**
 * Durable telemetry queue — an ES5 port of `TelemetryQueue` in @bnl/telemetry (the package uses
 * classes, async/await, Set and Promise, so it cannot ship to old webOS). Same rules:
 * - dedupe by event_id; flush at 25 events or 30 s; batches of at most 100;
 * - Idempotency-Key `tb-<first event_id>-<batch length>` (a retried batch reuses its key);
 * - accepted/duplicate/rejected ids leave the queue, a network error keeps everything;
 * - exponential backoff with jitter (cap 5 min);
 * - bounded: oldest non-evidence events are dropped first, learning-evidence events never silently.
 * Storage is synchronous localStorage (the spec allows a localStorage fallback for IndexedDB); the cap
 * is lower than the package's 5000 to stay inside the ~5 MB localStorage budget.
 */
import { isArray, isObject, readJson, writeJson, type KeyValueStore } from "./util";

export const QUEUE_KEY = "breaknlearn.telemetry-queue.v1";
export const QUEUE_MAX_EVENTS = 1500;
export const FLUSH_EVERY_EVENTS = 25;
export const FLUSH_EVERY_MS = 30000;
export const BATCH_MAX = 100;
const PRESERVE = ["answer_submitted", "quiz_completed", "lesson_completed", "quiz_started", "lesson_started"];

export interface QueuedEvent {
  event_id: string;
  event_type: string;
  [k: string]: unknown;
}

export interface Ack {
  accepted: string[];
  duplicates: string[];
  rejected: { event_id: string | null; code: string }[];
}

/** Transport result: an ack, or null for any failure that should be retried later. */
export type BatchSender = (events: QueuedEvent[], idempotencyKey: string, done: (ack: Ack | null) => void) => void;

export interface TelemetryQueue {
  size(): number;
  dropped(): number;
  enqueue(e: QueuedEvent): void;
  shouldFlush(lastFlushAt: number): boolean;
  backoffMs(): number;
  flush(send: BatchSender, done?: () => void): void;
  clear(): void;
  events(): QueuedEvent[];
}

export function isAck(x: unknown): x is Ack {
  return isObject(x) && isArray(x.accepted) && isArray(x.duplicates) && isArray(x.rejected);
}

export function createTelemetryQueue(store: KeyValueStore, now: () => number, random: () => number): TelemetryQueue {
  const loaded = readJson(store, QUEUE_KEY, []);
  let events: QueuedEvent[] = isArray(loaded) ? (loaded.filter(function (e) {
    return isObject(e) && typeof e.event_id === "string";
  }) as QueuedEvent[]) : [];
  let failures = 0;
  let nextAttemptAt = 0;
  let flushing = false;
  let droppedCount = 0;

  function save() {
    // On quota errors shed droppable events until it fits (never evidence events).
    while (!writeJson(store, QUEUE_KEY, events)) {
      if (!dropOne()) break;
    }
  }

  function dropOne(): boolean {
    for (let i = 0; i < events.length; i++) {
      if (PRESERVE.indexOf(events[i].event_type) < 0) {
        events.splice(i, 1);
        droppedCount++;
        return true;
      }
    }
    return false;
  }

  function backoffMs(): number {
    if (failures === 0) return 0;
    const base = Math.min(5 * 60000, 1000 * Math.pow(2, Math.min(failures, 8)));
    return Math.round(base / 2 + random() * (base / 2));
  }

  return {
    size: function () {
      return events.length;
    },
    dropped: function () {
      return droppedCount;
    },
    events: function () {
      return events.slice();
    },
    enqueue: function (e) {
      for (let i = 0; i < events.length; i++) if (events[i].event_id === e.event_id) return;
      events.push(e);
      while (events.length > QUEUE_MAX_EVENTS) {
        if (!dropOne()) break; // only learning-evidence events left: keep them
      }
      save();
    },
    shouldFlush: function (lastFlushAt) {
      return events.length >= FLUSH_EVERY_EVENTS || (events.length > 0 && now() - lastFlushAt >= FLUSH_EVERY_MS);
    },
    backoffMs: backoffMs,
    clear: function () {
      events = [];
      save();
    },
    flush: function (send, done) {
      const finish = function () {
        flushing = false;
        if (done) done();
      };
      if (flushing || events.length === 0 || now() < nextAttemptAt) {
        if (done) done();
        return;
      }
      flushing = true;
      const batch = events.slice(0, BATCH_MAX);
      const key = "tb-" + batch[0].event_id + "-" + batch.length;
      send(batch, key, function (ack) {
        if (ack) {
          const doneIds: { [id: string]: boolean } = {};
          for (let i = 0; i < ack.accepted.length; i++) doneIds[ack.accepted[i]] = true;
          for (let i = 0; i < ack.duplicates.length; i++) doneIds[ack.duplicates[i]] = true;
          for (let i = 0; i < ack.rejected.length; i++) {
            const id = ack.rejected[i].event_id;
            if (id !== null) doneIds[id] = true;
          }
          events = events.filter(function (e) {
            return !doneIds[e.event_id];
          });
          failures = 0;
          nextAttemptAt = 0;
        } else {
          failures++;
          nextAttemptAt = now() + backoffMs();
        }
        save();
        finish();
      });
    },
  };
}
