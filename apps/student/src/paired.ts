/**
 * Optional paired mode (M06 + M01/M05/M07/M09). Off unless the server says so:
 *   GET /api/v1/student/config  →  { paired_mode: true, telemetry?: bool, service_worker?: bool }
 * (a 404, an error or no network keeps the live, local-only behaviour). When on and the TV holds a
 * device token, it consumes the published catalog, queues telemetry, syncs progress and runs the
 * one-time legacy import. Every network failure degrades silently: a child is never blocked.
 */
import { builtinCatalog, catalogFromCache, CATALOG_CACHE_KEY, lessonFromPublished, manifestLessons, saveCachedCatalog, type CachedCatalog, type ManifestLessonRef, type StudentCatalog, type TableLesson } from "./catalog";
import type { Http, HttpResponse } from "./http";
import { historicalEntryCount, legacyFingerprint, loadProfiles, legacySnapshot, type LegacySnapshot, type LocalProfile } from "./legacy";
import { createProgressOutbox, type ProgressOutbox } from "./progress-outbox";
import { createTelemetryQueue, isAck, type QueuedEvent, type TelemetryQueue } from "./telemetry-queue";
import { isArray, isObject, isoNow, isUuid, readJson, uuid4, without, writeJson, type KeyValueStore } from "./util";

export const CONFIG_KEY = "breaknlearn.student-config.v1";
export const DEVICE_KEY = "breaknlearn.device.v1";
export const LINKS_KEY = "breaknlearn.profile-links.v1";
export const SERVER_PROFILES_KEY = "breaknlearn.server-profiles.v1";
export const IMPORT_KEY = "breaknlearn.legacy-import.v1";
export const ATTEMPTS_KEY = "breaknlearn.attempts.v1";

export const API = "/api/v1";

export interface StudentConfig {
  paired_mode: boolean;
  telemetry: boolean;
  service_worker: boolean;
}

export interface DeviceCredential {
  device_id: string;
  household_id: string;
  access_token: string;
  access_expires_at: string;
  refresh_token: string;
}

export interface ServerProfile {
  id: string;
  slot: number;
  display_name: string;
  grade: number;
}

export interface Links {
  /** local profile id ("child-1") → server learner id */
  profiles: { [localId: string]: string };
  /** learner chosen by the guardian for historical ×3 keys; null = not assigned */
  historical: string | null;
}

export interface ImportRun {
  migration_run_id: string;
  key: string;
  request: { [k: string]: unknown };
  receipt: unknown;
  status: "pending" | "done" | "failed";
  covers: string[];
  historical: boolean;
}

export interface PairingView {
  state: "idle" | "loading" | "code" | "expired" | "offline" | "paired";
  code: string | null;
}

export interface LessonContext {
  profile: LocalProfile;
  lesson: TableLesson;
  worldId: string;
}

export interface Paired {
  config(): StudentConfig;
  enabled(): boolean;
  isPaired(): boolean;
  catalog(): StudentCatalog;
  pairing(): PairingView;
  serverProfiles(): ServerProfile[] | null;
  links(): Links;
  pendingUploads(): number;
  historicalCount(): number;
  lastImport(): ImportRun | null;
  start(): void;
  startPairing(): void;
  cancelPairing(): void;
  loadServerProfiles(done?: (ok: boolean) => void): void;
  saveLinks(links: Links): void;
  unpair(): void;
  flushNow(): void;
  setListener(fn: () => void): void;
  // app hooks (no-ops unless paired + linked)
  profileSelected(p: LocalProfile): void;
  lessonStarted(ctx: LessonContext, restart: boolean, wasComplete: boolean): void;
  progressSaved(ctx: LessonContext, slide: number, position: number, completed: boolean): void;
  slideEntered(ctx: LessonContext, slide: number): void;
  tick(ctx: LessonContext, slide: number, ms: number): void;
  pauseChanged(ctx: LessonContext, slide: number, paused: boolean): void;
  quizStarted(ctx: LessonContext): void;
  answered(ctx: LessonContext, multiplier: number, value: number): void;
  quizCompleted(ctx: LessonContext): void;
  lessonLeft(ctx: LessonContext | null, slide: number): void;
  hidden(): void;
}

export interface PairedDeps {
  store: KeyValueStore;
  http: Http;
  now: () => number;
  random: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  /** Applies a service-worker config decision (kill switch). */
  onServiceWorkerFlag?: (enabled: boolean) => void;
}

const DEFAULT_CONFIG: StudentConfig = { paired_mode: false, telemetry: false, service_worker: true };

export function parseConfig(x: unknown): StudentConfig | null {
  if (!isObject(x) || typeof x.paired_mode !== "boolean") return null;
  return { paired_mode: x.paired_mode, telemetry: x.telemetry === true, service_worker: x.service_worker !== false };
}

function parseCredential(x: unknown): DeviceCredential | null {
  if (!isObject(x) || !isUuid(x.device_id) || !isUuid(x.household_id) || typeof x.access_token !== "string" || typeof x.refresh_token !== "string" || typeof x.access_expires_at !== "string") return null;
  return { device_id: x.device_id, household_id: x.household_id, access_token: x.access_token, access_expires_at: x.access_expires_at, refresh_token: x.refresh_token };
}

function parseServerProfiles(x: unknown): ServerProfile[] | null {
  if (!isObject(x) || !isArray(x.profiles)) return null;
  const out: ServerProfile[] = [];
  for (let i = 0; i < x.profiles.length; i++) {
    const p = x.profiles[i];
    if (isObject(p) && isUuid(p.id) && (p.slot === 1 || p.slot === 2) && typeof p.display_name === "string") out.push({ id: p.id, slot: p.slot, display_name: p.display_name, grade: Number(p.grade) });
  }
  return out;
}

/** Server slot for a local profile: "child-N" → N. */
export function localSlot(localId: string): number | null {
  const m = /^child-([12])$/.exec(localId);
  return m ? Number(m[1]) : null;
}

export function createPaired(deps: PairedDeps): Paired {
  const store = deps.store;
  let cfg: StudentConfig = parseConfig(readJson(store, CONFIG_KEY, null)) || DEFAULT_CONFIG;
  let cred: DeviceCredential | null = parseCredential(readJson(store, DEVICE_KEY, null));
  let catalog: StudentCatalog = (cfg.paired_mode && cred && catalogFromCache(readJson(store, CATALOG_CACHE_KEY, null))) || builtinCatalog();
  let servers: ServerProfile[] | null = parseServerProfiles(readJson(store, SERVER_PROFILES_KEY, null));
  const linksRaw = readJson(store, LINKS_KEY, null);
  let links: Links = isObject(linksRaw) && isObject(linksRaw.profiles) ? { profiles: linksRaw.profiles as { [k: string]: string }, historical: isUuid(linksRaw.historical) ? linksRaw.historical : null } : { profiles: {}, historical: null };
  const attemptsRaw = readJson(store, ATTEMPTS_KEY, {});
  const attempts: { [k: string]: string } = isObject(attemptsRaw) ? (attemptsRaw as { [k: string]: string }) : {};
  const importRaw = readJson(store, IMPORT_KEY, []);
  const runs: ImportRun[] = isArray(importRaw) ? (importRaw as ImportRun[]) : [];
  const queue: TelemetryQueue = createTelemetryQueue(store, deps.now, deps.random);
  const outbox: ProgressOutbox = createProgressOutbox(store, deps.now);
  let pairingView: PairingView = { state: cred ? "paired" : "idle", code: null };
  let pairingTimer: unknown = null;
  let pairingSession = 0;
  let listener: () => void = function () {};
  let started = false;
  let lastTelemetryFlush = deps.now();
  let lastProgressFlush = 0;
  let lastCatalogFetch = 0;
  /** After consent_required, wait before asking again (a parent has to act on the Privacy page first). */
  let importRetryAt = 0;
  let refreshWaiters: ((ok: boolean) => void)[] | null = null;
  let session: { id: string; seq: number; learner: string } | null = null;
  let heartbeatMs = 0;
  let quizAttempt: string | null = null;

  const notify = function () {
    try {
      listener();
    } catch {
      /* UI listener failures must not break sync */
    }
  };

  function active(): boolean {
    return cfg.paired_mode && cred !== null;
  }

  // ---------- device credential ----------
  function saveCred(c: DeviceCredential | null) {
    cred = c;
    if (c) writeJson(store, DEVICE_KEY, c);
    else store.removeItem(DEVICE_KEY);
  }

  function forgetDevice() {
    // Revoked or disconnected: stop all device writes. Local progress in breaknlearn.profiles.v1 stays.
    saveCred(null);
    queue.clear();
    outbox.clear();
    session = null;
    catalog = builtinCatalog();
    pairingView = { state: "idle", code: null };
    notify();
  }

  function refreshToken(done: (ok: boolean) => void) {
    if (!cred) {
      done(false);
      return;
    }
    if (refreshWaiters) {
      refreshWaiters.push(done);
      return;
    }
    refreshWaiters = [done];
    deps.http({ method: "POST", url: API + "/devices/token/refresh", body: { refresh_token: cred.refresh_token } }, function (res) {
      let ok = false;
      if (res.status === 200) {
        const c = parseCredential(res.body);
        if (c) {
          saveCred(c);
          ok = true;
        }
      } else if (res.status === 401) {
        forgetDevice();
      }
      const w = refreshWaiters || [];
      refreshWaiters = null;
      for (let i = 0; i < w.length; i++) w[i](ok);
    });
  }

  function tokenFresh(): boolean {
    if (!cred) return false;
    const exp = Date.parse(cred.access_expires_at);
    return !isNaN(exp) && exp - 60000 > deps.now();
  }

  /** Device-authenticated request: refreshes an expired token first and retries once on 401. */
  function authed(method: "GET" | "POST", path: string, body: unknown, headers: { [k: string]: string }, done: (res: HttpResponse) => void) {
    const send = function (retry: boolean) {
      if (!cred) {
        done({ status: 401, body: null, header: function () { return null; } });
        return;
      }
      const h: { [k: string]: string } = { Authorization: "Bearer " + cred.access_token };
      for (const k in headers) if (Object.prototype.hasOwnProperty.call(headers, k)) h[k] = headers[k];
      const req = body === undefined ? { method: method, url: API + path, headers: h } : { method: method, url: API + path, headers: h, body: body };
      deps.http(req, function (res) {
        if (res.status === 401 && retry) {
          refreshToken(function (ok) {
            if (ok) send(false);
            else done(res);
          });
          return;
        }
        done(res);
      });
    };
    if (!tokenFresh() && cred) {
      refreshToken(function () {
        send(true);
      });
    } else send(true);
  }

  // ---------- config / catalog ----------
  function fetchConfig(done: () => void) {
    deps.http({ method: "GET", url: API + "/student/config", timeoutMs: 6000 }, function (res) {
      if (res.status === 200) {
        const c = parseConfig(res.body);
        if (c) {
          cfg = c;
          writeJson(store, CONFIG_KEY, c);
          if (!c.paired_mode) catalog = builtinCatalog();
        }
      } else if (res.status === 404) {
        // Server without the flag endpoint: paired mode is off.
        cfg = DEFAULT_CONFIG;
        writeJson(store, CONFIG_KEY, cfg);
        catalog = builtinCatalog();
      }
      // other failures (offline): keep the last known config
      if (deps.onServiceWorkerFlag) deps.onServiceWorkerFlag(cfg.service_worker);
      done();
    });
  }

  function refreshCatalog(done?: () => void) {
    const finish = function () {
      if (done) done();
    };
    if (!active()) {
      finish();
      return;
    }
    lastCatalogFetch = deps.now();
    const cached = readJson(store, CATALOG_CACHE_KEY, null) as CachedCatalog | null;
    const headers: { [k: string]: string } = {};
    if (isObject(cached) && typeof cached.etag === "string") headers["If-None-Match"] = cached.etag;
    deps.http({ method: "GET", url: API + "/catalog/manifest?grade=2", headers: headers, timeoutMs: 8000 }, function (res) {
      if (res.status === 304 && cached) {
        const c = catalogFromCache(cached);
        if (c) catalog = c;
        finish();
        return;
      }
      const m = res.status === 200 ? manifestLessons(res.body) : null;
      if (!m) {
        finish(); // keep last good (CAT-008)
        return;
      }
      const next: CachedCatalog = { version: 1, revision: m.revision, etag: res.header("ETag"), playable: m.playable, lessons: {}, order: [] };
      const refs = m.lessons;
      const step = function (i: number) {
        if (i >= refs.length) {
          if (saveCachedCatalog(store, next)) {
            const c = catalogFromCache(next);
            if (c) catalog = c;
          }
          finish();
          return;
        }
        const ref: ManifestLessonRef = refs[i];
        const prev = isObject(cached) && isObject(cached.lessons) ? (cached.lessons as { [k: string]: { ref: ManifestLessonRef; lesson: unknown } })[ref.id] : undefined;
        if (prev && isObject(prev.ref) && prev.ref.version_id === ref.version_id && lessonFromPublished(ref, prev.lesson)) {
          next.lessons[ref.id] = { ref: ref, lesson: prev.lesson };
          next.order.push(ref.id);
          step(i + 1);
          return;
        }
        deps.http({ method: "GET", url: API + "/catalog/lessons/" + ref.id, timeoutMs: 8000 }, function (lr) {
          if (lr.status !== 200 || !lessonFromPublished(ref, lr.body)) {
            finish(); // incomplete set: keep last good catalog
            return;
          }
          next.lessons[ref.id] = { ref: ref, lesson: lr.body };
          next.order.push(ref.id);
          step(i + 1);
        });
      };
      step(0);
    });
  }

  // ---------- pairing ----------
  function startPairing() {
    cancelPairing();
    const mySession = ++pairingSession;
    pairingView = { state: "loading", code: null };
    notify();
    deps.http({ method: "POST", url: API + "/devices/pairing-code", body: {}, timeoutMs: 8000 }, function (res) {
      if (mySession !== pairingSession) return;
      const b = res.body;
      if (res.status !== 201 && res.status !== 200) {
        pairingView = { state: "offline", code: null };
        notify();
        return;
      }
      if (!isObject(b) || typeof b.code !== "string" || !isUuid(b.pairing_id) || typeof b.poll_secret !== "string") {
        pairingView = { state: "offline", code: null };
        notify();
        return;
      }
      pairingView = { state: "code", code: b.code };
      notify();
      const expires = typeof b.expires_at === "string" ? Date.parse(b.expires_at) : NaN;
      const poll = function () {
        if (mySession !== pairingSession) return;
        if (!isNaN(expires) && deps.now() > expires) {
          pairingView = { state: "expired", code: null };
          notify();
          return;
        }
        deps.http({ method: "POST", url: API + "/devices/token", body: { pairing_id: b.pairing_id, poll_secret: b.poll_secret }, timeoutMs: 8000 }, function (tr) {
          if (mySession !== pairingSession) return;
          if (tr.status === 200) {
            const c = parseCredential(tr.body);
            if (c) {
              saveCred(c);
              pairingView = { state: "paired", code: null };
              pairingTimer = null;
              notify();
              loadServerProfiles();
              refreshCatalog();
              return;
            }
          }
          if (tr.status === 410) {
            pairingView = { state: "expired", code: null };
            notify();
            return;
          }
          // 202 pending, network errors and anything else: keep polling until expiry
          pairingTimer = deps.setTimeout(poll, 3000);
        });
      };
      pairingTimer = deps.setTimeout(poll, 3000);
    });
  }

  function cancelPairing() {
    pairingSession++;
    if (pairingTimer !== null) deps.clearTimeout(pairingTimer);
    pairingTimer = null;
    if (pairingView.state !== "paired") pairingView = { state: cred ? "paired" : "idle", code: null };
  }

  // ---------- profiles / links / legacy import ----------
  function loadServerProfiles(done?: (ok: boolean) => void) {
    if (!active()) {
      if (done) done(false);
      return;
    }
    authed("GET", "/profiles", undefined, {}, function (res) {
      const list = res.status === 200 ? parseServerProfiles(res.body) : null;
      if (list) {
        servers = list;
        writeJson(store, SERVER_PROFILES_KEY, list);
        // drop links to learners that no longer exist in the household
        let changed = false;
        for (const k in links.profiles) {
          if (!Object.prototype.hasOwnProperty.call(links.profiles, k)) continue;
          let found = false;
          for (let i = 0; i < list.length; i++) if (list[i].id === links.profiles[k]) found = true;
          if (!found) {
            links.profiles = without(links.profiles, k);
            changed = true;
          }
        }
        if (changed) writeJson(store, LINKS_KEY, links);
      }
      notify();
      if (done) done(!!list);
    });
  }

  function learnerFor(p: LocalProfile | null | undefined): string | null {
    if (!p || !active()) return null;
    const l = links.profiles[p.id];
    return isUuid(l) ? l : null;
  }

  function coveredIds(): string[] {
    const out: string[] = [];
    for (let i = 0; i < runs.length; i++) {
      if (runs[i].status !== "done") continue;
      for (let j = 0; j < runs[i].covers.length; j++) out.push(runs[i].covers[j]);
    }
    return out;
  }

  function historicalDone(): boolean {
    for (let i = 0; i < runs.length; i++) if (runs[i].status === "done" && runs[i].historical) return true;
    return false;
  }

  /** Builds (once) the import request for linked profiles not yet covered by a receipt. */
  function planImport() {
    for (let i = 0; i < runs.length; i++) if (runs[i].status === "pending") return; // finish that one first
    const snap: LegacySnapshot = legacySnapshot(store);
    const covered = coveredIds();
    const root = snap["breaknlearn.profiles.v1"] as { profiles?: unknown[] } | null;
    const mapping: { local_profile_id: string; learner_id: string }[] = [];
    const sendProfiles: unknown[] = [];
    if (root && isArray(root.profiles)) {
      for (let i = 0; i < root.profiles.length; i++) {
        const p = root.profiles[i];
        if (!isObject(p) || typeof p.id !== "string") continue;
        const learner = links.profiles[p.id];
        if (!isUuid(learner) || covered.indexOf(p.id) >= 0) continue;
        mapping.push({ local_profile_id: p.id, learner_id: learner });
        sendProfiles.push(p);
      }
    }
    const wantHistorical = links.historical !== null && !historicalDone() && historicalEntryCount(snap) > 0;
    if (mapping.length === 0 && !wantHistorical) return;
    // Only the profiles the guardian linked are uploaded; the full verbatim copy stays in the device backup.
    const raw: LegacySnapshot = {
      "breaknlearn.profiles.v1": root ? copyWithProfiles(root as { [k: string]: unknown }, sendProfiles) : null,
      "breaknlearn.progress.v1": wantHistorical ? snap["breaknlearn.progress.v1"] : null,
      "learnbreak-x3-v4-progress": wantHistorical ? snap["learnbreak-x3-v4-progress"] : null,
    };
    const runId = uuid4();
    const request: { [k: string]: unknown } = {
      migration_run_id: runId,
      legacy_fingerprint: legacyFingerprint(raw as unknown as { [k: string]: unknown }),
      raw: raw,
      profile_mapping: mapping,
    };
    if (wantHistorical) request.historical_learner_id = links.historical;
    const covers: string[] = [];
    for (let i = 0; i < mapping.length; i++) covers.push(mapping[i].local_profile_id);
    runs.push({ migration_run_id: runId, key: "li-" + runId, request: request, receipt: null, status: "pending", covers: covers, historical: wantHistorical });
    writeJson(store, IMPORT_KEY, runs);
  }

  function copyWithProfiles(root: { [k: string]: unknown }, profiles: unknown[]): { [k: string]: unknown } {
    const out: { [k: string]: unknown } = {};
    for (const k in root) if (Object.prototype.hasOwnProperty.call(root, k)) out[k] = root[k];
    out.profiles = profiles;
    return out;
  }

  function runImport(done: () => void) {
    if (!active()) {
      done();
      return;
    }
    planImport();
    let run: ImportRun | null = null;
    for (let i = 0; i < runs.length; i++) if (runs[i].status === "pending") run = runs[i];
    if (!run) {
      done();
      return;
    }
    const r = run;
    authed("POST", "/progress/legacy-import", r.request, { "Idempotency-Key": r.key }, function (res) {
      if (res.status === 200 && isObject(res.body)) {
        r.status = "done";
        r.receipt = res.body;
        writeJson(store, IMPORT_KEY, runs);
        pullProgress();
      } else if (isConsentRequired(res)) {
        // Consent not given yet: keep the run pending with the same key and retry in 10 minutes.
        importRetryAt = deps.now() + 10 * 60000;
      } else if (res.status === 409 || res.status === 422 || res.status === 403 || res.status === 413) {
        r.status = "failed";
        r.receipt = isObject(res.body) ? res.body : null;
        writeJson(store, IMPORT_KEY, runs);
      }
      // 0 / 429 / 5xx: retry later with the same run id, fingerprint and key (idempotent)
      notify();
      done();
    });
  }

  /** Adopt the server's latest incomplete attempt per (lesson, theme) so local play continues it. */
  function pullProgress() {
    const local = loadProfiles(store).state.profiles;
    for (let i = 0; i < local.length; i++) {
      const p = local[i];
      const learner = learnerFor(p);
      if (!p || !learner) continue;
      authed("GET", "/progress?learner_id=" + learner + "&limit=100", undefined, {}, function (res) {
        if (res.status !== 200 || !isObject(res.body) || !isArray(res.body.items)) return;
        const best: { [k: string]: { [k: string]: unknown } } = {};
        for (let j = 0; j < res.body.items.length; j++) {
          const it: unknown = (res.body.items as unknown[])[j];
          if (!isObject(it) || it.completed === true || !isUuid(it.attempt_id) || typeof it.server_revision !== "number") continue;
          const k = it.lesson_id + "|" + it.theme_key;
          if (!best[k] || (best[k].server_revision as number) < it.server_revision) best[k] = it;
        }
        for (const k in best) {
          if (!Object.prototype.hasOwnProperty.call(best, k)) continue;
          const it: { [k: string]: unknown } = best[k];
          const t = tableForLesson(String(it.lesson_id));
          if (t === null) continue;
          const ak = p.id + "|" + t + "|" + it.theme_key;
          if (!attempts[ak]) {
            attempts[ak] = String(it.attempt_id);
            outbox.adopt({ learner_id: learner, lesson_id: String(it.lesson_id), theme_key: String(it.theme_key), attempt_id: String(it.attempt_id), server_revision: it.server_revision as number });
          }
        }
        writeJson(store, ATTEMPTS_KEY, attempts);
      });
    }
  }

  function tableForLesson(lessonId: string): number | null {
    const all = catalog.tables.concat(builtinCatalog().tables);
    for (let i = 0; i < all.length; i++) if (all[i].lessonId === lessonId) return all[i].table;
    return null;
  }

  // ---------- telemetry ----------
  function emit(type: string, learner: string | null, extra: { lesson?: TableLesson; slide?: number; payload?: { [k: string]: unknown } }) {
    if (!active() || !cfg.telemetry || !learner || !cred) return;
    if (!session || session.learner !== learner) session = { id: uuid4(), seq: 0, learner: learner };
    const at = isoNow(deps.now());
    const e: QueuedEvent = {
      event_id: uuid4(),
      schema_version: 1,
      event_type: type,
      occurred_at: at,
      sent_at: at, // frozen at creation so a retried batch is byte-identical (Idempotency-Key)
      client_session_id: session.id,
      client_sequence: session.seq++,
      learner_id: learner,
      device_id: cred.device_id,
      payload: extra.payload || {},
    };
    if (extra.lesson) {
      e.lesson_id = extra.lesson.lessonId;
      if (extra.lesson.versionId) e.lesson_version_id = extra.lesson.versionId;
    }
    if (extra.slide) e.slide_id = "step-" + extra.slide;
    queue.enqueue(e);
  }

  function flushHeartbeat(ctx: LessonContext | null, slide: number) {
    if (!ctx || heartbeatMs < 1000) {
      heartbeatMs = 0;
      return;
    }
    const ms = Math.min(30000, Math.round(heartbeatMs));
    heartbeatMs = 0;
    emit("playback_heartbeat", learnerFor(ctx.profile), { lesson: ctx.lesson, slide: slide, payload: { foreground: true, playing: true, visible_ms: ms, playback_ms: ms, theme_key: ctx.worldId, slide_index: slide } });
  }

  function sendBatch(events: QueuedEvent[], key: string, done: (ack: ReturnType<typeof ackOrNull>) => void) {
    authed("POST", "/telemetry/batch", { events: events }, { "Idempotency-Key": key }, function (res) {
      if (isConsentRequired(res)) {
        // No consent for this household: drop the batch so activity recorded while consent was off is never
        // uploaded later (privacy). Play continues; nothing is shown to the child.
        const ids: { event_id: string | null; code: string }[] = [];
        for (let i = 0; i < events.length; i++) ids.push({ event_id: events[i].event_id, code: "consent_required" });
        done({ accepted: [], duplicates: [], rejected: ids });
        return;
      }
      done(ackOrNull(res));
    });
  }

  /** 403 with error code consent_required (the household has not given, or withdrew, consent). */
  function isConsentRequired(res: HttpResponse): boolean {
    if (res.status !== 403 || !isObject(res.body)) return false;
    const err = (res.body as { error?: unknown }).error;
    return isObject(err) && (err as { code?: unknown }).code === "consent_required";
  }

  /** Anything but a valid ack (offline, 401, 429, 503 feature_disabled, …) is retried with backoff. */
  function ackOrNull(res: HttpResponse) {
    return res.status === 200 && isAck(res.body) ? res.body : null;
  }

  function flushNow() {
    if (!active()) return;
    if (queue.size() > 0) {
      lastTelemetryFlush = deps.now();
      queue.flush(sendBatch);
    }
    if (outbox.pending() > 0) {
      lastProgressFlush = deps.now();
      outbox.flush(function (body, key, done) {
        authed("POST", "/progress/sync", body, { "Idempotency-Key": key }, function (res) {
          done({ status: res.status, body: res.body });
        });
      });
    }
  }

  function loop() {
    if (!active()) return;
    const now = deps.now();
    if (queue.shouldFlush(lastTelemetryFlush)) {
      lastTelemetryFlush = now;
      queue.flush(sendBatch);
    }
    if (outbox.pending() > 0 && now - lastProgressFlush >= 10000) flushNow();
    if (now - lastCatalogFetch >= 30 * 60000) refreshCatalog();
    for (let i = 0; i < runs.length && now >= importRetryAt; i++) {
      if (runs[i].status === "pending") {
        runImport(function () {});
        return;
      }
    }
  }

  return {
    config: function () {
      return cfg;
    },
    enabled: function () {
      return cfg.paired_mode;
    },
    isPaired: function () {
      return cred !== null;
    },
    catalog: function () {
      return catalog;
    },
    pairing: function () {
      return pairingView;
    },
    serverProfiles: function () {
      return servers;
    },
    links: function () {
      return links;
    },
    pendingUploads: function () {
      return queue.size() + outbox.pending();
    },
    historicalCount: function () {
      return historicalDone() ? 0 : historicalEntryCount(legacySnapshot(store));
    },
    lastImport: function () {
      return runs.length ? runs[runs.length - 1] : null;
    },
    setListener: function (fn) {
      listener = fn;
    },
    start: function () {
      if (started) return;
      started = true;
      fetchConfig(function () {
        notify();
        if (!active()) return;
        refreshCatalog(function () {
          notify();
        });
        loadServerProfiles(function () {
          runImport(function () {});
        });
      });
      deps.setInterval(function () {
        try {
          loop();
        } catch {
          /* never let sync break playback */
        }
      }, 5000);
    },
    startPairing: startPairing,
    cancelPairing: cancelPairing,
    loadServerProfiles: loadServerProfiles,
    saveLinks: function (l) {
      links = { profiles: l.profiles, historical: l.historical };
      writeJson(store, LINKS_KEY, links);
      runImport(function () {});
      notify();
    },
    unpair: function () {
      cancelPairing();
      store.removeItem(LINKS_KEY);
      store.removeItem(SERVER_PROFILES_KEY);
      links = { profiles: {}, historical: null };
      servers = null;
      forgetDevice();
    },
    flushNow: flushNow,
    profileSelected: function (p) {
      const learner = learnerFor(p);
      if (!learner) return;
      if (session && session.learner !== learner) emit("session_ended", session.learner, {});
      session = null;
      emit("profile_selected", learner, {});
      emit("session_started", learner, {});
    },
    lessonStarted: function (ctx, restart, wasComplete) {
      const ak = ctx.profile.id + "|" + ctx.lesson.table + "|" + ctx.worldId;
      if (restart || wasComplete || !attempts[ak]) {
        attempts[ak] = uuid4(); // replay/restart = new attempt; completion of the old one stays on the server
        writeJson(store, ATTEMPTS_KEY, attempts);
      }
      heartbeatMs = 0;
      emit("lesson_started", learnerFor(ctx.profile), { lesson: ctx.lesson, payload: { theme_key: ctx.worldId } });
    },
    progressSaved: function (ctx, slide, position, completed) {
      const learner = learnerFor(ctx.profile);
      if (!learner) return;
      const ak = ctx.profile.id + "|" + ctx.lesson.table + "|" + ctx.worldId;
      if (!attempts[ak]) {
        attempts[ak] = uuid4();
        writeJson(store, ATTEMPTS_KEY, attempts);
      }
      outbox.record({ learner_id: learner, lesson_id: ctx.lesson.lessonId, lesson_version_id: ctx.lesson.versionId, theme_key: ctx.worldId, attempt_id: attempts[ak], slide_index: slide, position_seconds: position, completed: completed });
      if (completed) emit("lesson_completed", learner, { lesson: ctx.lesson, payload: { theme_key: ctx.worldId } });
    },
    slideEntered: function (ctx, slide) {
      flushHeartbeat(ctx, slide > 1 ? slide - 1 : slide);
      emit("slide_entered", learnerFor(ctx.profile), { lesson: ctx.lesson, slide: slide, payload: { theme_key: ctx.worldId, slide_index: slide } });
    },
    tick: function (ctx, slide, ms) {
      if (!learnerFor(ctx.profile)) return;
      heartbeatMs += ms;
      if (heartbeatMs >= 15000) flushHeartbeat(ctx, slide);
    },
    pauseChanged: function (ctx, slide, paused) {
      if (paused) flushHeartbeat(ctx, slide);
      emit(paused ? "playback_paused" : "playback_resumed", learnerFor(ctx.profile), { lesson: ctx.lesson, slide: slide, payload: { theme_key: ctx.worldId, slide_index: slide } });
    },
    quizStarted: function (ctx) {
      quizAttempt = uuid4();
      emit("quiz_started", learnerFor(ctx.profile), { lesson: ctx.lesson, payload: { theme_key: ctx.worldId, quiz_attempt_id: quizAttempt, attempt_stage: "immediate" } });
    },
    answered: function (ctx, multiplier, value) {
      const payload: { [k: string]: unknown } = { quiz_attempt_id: quizAttempt || uuid4(), attempt_stage: "immediate", selected_option_id: optionIdFor(ctx.lesson, multiplier, value) };
      if (ctx.lesson.versionNo !== null) payload.question_version_key = ctx.lesson.stableKey + ".fact-" + multiplier + ".v" + ctx.lesson.versionNo;
      emit("answer_submitted", learnerFor(ctx.profile), { lesson: ctx.lesson, payload: payload });
    },
    quizCompleted: function (ctx) {
      emit("quiz_completed", learnerFor(ctx.profile), { lesson: ctx.lesson, payload: { theme_key: ctx.worldId, quiz_attempt_id: quizAttempt || uuid4(), attempt_stage: "immediate" } });
      quizAttempt = null;
    },
    lessonLeft: function (ctx, slide) {
      flushHeartbeat(ctx, slide);
    },
    hidden: function () {
      if (session) emit("app_hidden", session.learner, {});
      flushNow();
    },
  };
}

/**
 * Option id the server's item bank uses for this value (`bankMultiplicationItem` in
 * @bnl/lesson-engine: ids a..d). A value that is not one of the bank's options is reported as
 * `v-<value>`; it can never be the correct one because the bank always contains the product.
 */
export function optionIdFor(lesson: TableLesson, multiplier: number, value: number): string {
  const opts = bankOptions(lesson.table, multiplier);
  for (let i = 0; i < opts.length; i++) if (opts[i] === value) return ["a", "b", "c", "d"][i];
  return "v-" + value;
}

/** Port of the option values of `bankMultiplicationItem` (parity-tested). */
export function bankOptions(n: number, m: number): number[] {
  const a = n * m;
  const cands = [a + n, a - n, a + 1, a - 1, a + 2, a - 2, a + n + 1, a + 3, a + 4, a + 5];
  const distractors: number[] = [];
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    if (c > 0 && c !== a && distractors.indexOf(c) < 0 && distractors.length < 3) distractors.push(c);
  }
  const correctPos = ((n + m) % 4) + 1;
  return distractors.slice(0, correctPos - 1).concat([a], distractors.slice(correctPos - 1, 3));
}
