/**
 * Progress sync outbox (M09, ADR-0002 G1). One entry per (learner, lesson, theme, attempt), holding
 * the latest local state. Completion is monotonic within an attempt; a replay or explicit restart is
 * a new attempt id (the live app's local `complete:false` flip, finding F2, never reaches the server).
 * A request in flight is frozen with its Idempotency-Key so a retry resends identical bytes.
 */
import { isObject, isoNow, readJson, without, writeJson, type KeyValueStore } from "./util";

export const OUTBOX_KEY = "breaknlearn.progress-outbox.v1";

export interface SyncBody {
  learner_id: string;
  lesson_id: string;
  lesson_version_id?: string;
  theme_key: string;
  attempt_id: string;
  client_revision: number;
  base_server_revision: number | null;
  slide_id: string;
  position_seconds: number;
  completed: boolean;
  client_updated_at: string;
}

export interface OutboxEntry {
  learner_id: string;
  lesson_id: string;
  lesson_version_id: string | null;
  theme_key: string;
  attempt_id: string;
  slide_id: string;
  position_seconds: number;
  completed: boolean;
  client_revision: number;
  base_server_revision: number | null;
  dirty: boolean;
  updated_ms: number;
  inflight: { key: string; body: SyncBody } | null;
}

export interface SyncResult {
  status: number; // 0 = network
  body: unknown;
}

export type SyncSender = (body: SyncBody, key: string, done: (r: SyncResult) => void) => void;

export interface ProgressOutbox {
  record(s: { learner_id: string; lesson_id: string; lesson_version_id: string | null; theme_key: string; attempt_id: string; slide_index: number; position_seconds: number; completed: boolean }): void;
  /** Adopt a server state (e.g. from GET /progress) as the base revision for that attempt. */
  adopt(s: { learner_id: string; lesson_id: string; theme_key: string; attempt_id: string; server_revision: number }): void;
  pending(): number;
  entries(): OutboxEntry[];
  flush(send: SyncSender, done?: (authFailed: boolean) => void): void;
  clear(): void;
}

function keyOf(e: { learner_id: string; lesson_id: string; theme_key: string; attempt_id: string }): string {
  return e.learner_id + "|" + e.lesson_id + "|" + e.theme_key + "|" + e.attempt_id;
}

function slideIndex(id: string): number {
  const m = /(\d+)$/.exec(id || "");
  return m ? Number(m[1]) : 0;
}

export function createProgressOutbox(store: KeyValueStore, now: () => number): ProgressOutbox {
  const loaded = readJson(store, OUTBOX_KEY, {});
  let map: { [k: string]: OutboxEntry } = isObject(loaded) ? (loaded as { [k: string]: OutboxEntry }) : {};
  let flushing = false;
  const save = function () {
    writeJson(store, OUTBOX_KEY, map);
  };

  return {
    record: function (s) {
      const k = keyOf(s);
      const slideId = "step-" + s.slide_index;
      const pos = Math.max(0, Math.min(30, Number(s.position_seconds) || 0));
      let e = map[k];
      if (!e) {
        e = { learner_id: s.learner_id, lesson_id: s.lesson_id, lesson_version_id: s.lesson_version_id, theme_key: s.theme_key, attempt_id: s.attempt_id, slide_id: slideId, position_seconds: pos, completed: s.completed, client_revision: 0, base_server_revision: null, dirty: true, updated_ms: now(), inflight: null };
        map[k] = e;
      } else {
        // Completion is sticky within an attempt; the furthest slide is kept once complete.
        if (!e.completed || slideIndex(slideId) >= slideIndex(e.slide_id)) {
          e.slide_id = e.completed && slideIndex(slideId) < slideIndex(e.slide_id) ? e.slide_id : slideId;
          e.position_seconds = pos;
        }
        e.completed = e.completed || s.completed;
        if (s.lesson_version_id) e.lesson_version_id = s.lesson_version_id;
        e.dirty = true;
        e.updated_ms = now();
      }
      save();
    },
    adopt: function (s) {
      const k = keyOf(s);
      const e = map[k];
      if (e && !e.inflight) {
        e.base_server_revision = s.server_revision;
        save();
      } else if (!e) {
        map[k] = { learner_id: s.learner_id, lesson_id: s.lesson_id, lesson_version_id: null, theme_key: s.theme_key, attempt_id: s.attempt_id, slide_id: "step-1", position_seconds: 0, completed: false, client_revision: 0, base_server_revision: s.server_revision, dirty: false, updated_ms: now(), inflight: null };
        save();
      }
    },
    pending: function () {
      let n = 0;
      for (const k in map) if (Object.prototype.hasOwnProperty.call(map, k) && (map[k].dirty || map[k].inflight)) n++;
      return n;
    },
    entries: function () {
      const out: OutboxEntry[] = [];
      for (const k in map) if (Object.prototype.hasOwnProperty.call(map, k)) out.push(map[k]);
      return out;
    },
    clear: function () {
      map = {};
      save();
    },
    flush: function (send, done) {
      if (flushing) {
        if (done) done(false);
        return;
      }
      const keys: string[] = [];
      for (const k in map) if (Object.prototype.hasOwnProperty.call(map, k) && (map[k].dirty || map[k].inflight)) keys.push(k);
      flushing = true;
      let authFailed = false;
      const next = function (i: number) {
        if (i >= keys.length || authFailed) {
          flushing = false;
          save();
          if (done) done(authFailed);
          return;
        }
        const e = map[keys[i]];
        if (!e) {
          next(i + 1);
          return;
        }
        if (!e.inflight) {
          e.client_revision++;
          const body: SyncBody = {
            learner_id: e.learner_id,
            lesson_id: e.lesson_id,
            theme_key: e.theme_key,
            attempt_id: e.attempt_id,
            client_revision: e.client_revision,
            base_server_revision: e.base_server_revision,
            slide_id: e.slide_id,
            position_seconds: e.position_seconds,
            completed: e.completed,
            client_updated_at: isoNow(e.updated_ms),
          };
          if (e.lesson_version_id) body.lesson_version_id = e.lesson_version_id;
          e.inflight = { key: "ps-" + e.attempt_id + "-" + e.client_revision, body: body };
          e.dirty = false;
          save();
        }
        const inflight = e.inflight;
        send(inflight.body, inflight.key, function (r) {
          if (r.status === 0 || r.status === 429 || r.status >= 500) {
            // keep the frozen request; retry later with the same key
          } else if (r.status === 401) {
            authFailed = true;
          } else if (r.status >= 200 && r.status < 300) {
            const st = isObject(r.body) && isObject(r.body.state) ? r.body.state : null;
            if (st && typeof st.server_revision === "number") e.base_server_revision = st.server_revision;
            e.inflight = null;
          } else if (r.status === 409) {
            const d = isObject(r.body) && isObject(r.body.error) && isObject(r.body.error.details) ? r.body.error.details : null;
            const code = isObject(r.body) && isObject(r.body.error) ? r.body.error.code : null;
            if (code === "conflict") {
              const rev = d ? d.server_revision : null;
              e.base_server_revision = typeof rev === "number" ? rev : null;
              e.dirty = true;
            }
            e.inflight = null;
          } else {
            // 403/404/413/422: the server will never accept this attempt; drop it (local progress stays).
            map = without(map, keys[i]);
          }
          save();
          next(i + 1);
        });
      };
      next(0);
    },
  };
}
