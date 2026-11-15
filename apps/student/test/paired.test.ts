import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LearningEvent, LegacyImportRequest } from "../../../packages/contracts/src";
import { legacyFingerprintInput } from "../../../packages/student-progress/src";
import type { HttpRequest, HttpResponse } from "../src/http";
import { LEGACY_PROFILES_KEY } from "../src/legacy";
import { CONFIG_KEY, DEVICE_KEY, IMPORT_KEY, createPaired, type Paired } from "../src/paired";
import { QUEUE_KEY } from "../src/telemetry-queue";
import { lessonForTable, manifestFixture } from "../../../tests/fixtures/student/catalog";
import { storeWith } from "./helpers";

const fixture = JSON.parse(readFileSync(new URL("../../../tests/fixtures/legacy/profiles-v1-two-children.json", import.meta.url), "utf8"));
const historical = JSON.parse(readFileSync(new URL("../../../tests/fixtures/legacy/historical-x3-keys.json", import.meta.url), "utf8"));
const DEVICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HOUSEHOLD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ASHA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RAVI = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NOW = Date.UTC(2026, 10, 14, 10);
const cred = (token = "t1", expires = NOW + 3600_000) => ({ device_id: DEVICE, household_id: HOUSEHOLD, access_token: token, access_expires_at: new Date(expires).toISOString(), refresh_token: "r".repeat(40) });

type Route = (req: HttpRequest) => { status: number; body?: unknown; headers?: Record<string, string> } | null;

function harness(initial: Record<string, string | null>, route: Route) {
  const store = storeWith(initial);
  const calls: HttpRequest[] = [];
  const timers: (() => void)[] = [];
  const paired: Paired = createPaired({
    store,
    now: () => NOW,
    random: () => 0.5,
    setTimeout: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => {},
    setInterval: () => 0,
    http: (req, done) => {
      calls.push(req);
      const r = route(req) ?? { status: 0 };
      const res: HttpResponse = { status: r.status, body: r.body ?? null, header: (n) => r.headers?.[n] ?? null };
      done(res);
    },
  });
  return { store, calls, timers, paired };
}

const profilesText = JSON.stringify(fixture[LEGACY_PROFILES_KEY]);

describe("paired mode is off unless the server enables it", () => {
  it("a 404 config (or no network) keeps local-only behaviour and makes no further calls", () => {
    for (const status of [404, 0]) {
      const h = harness({ [LEGACY_PROFILES_KEY]: profilesText }, (r) => (r.url.endsWith("/student/config") ? { status } : { status: 500 }));
      h.paired.start();
      expect(h.paired.enabled()).toBe(false);
      expect(h.paired.catalog().source).toBe("builtin");
      expect(h.calls.map((c) => c.url)).toEqual(["/api/v1/student/config"]);
    }
  });

  it("keeps the last known config when offline", () => {
    const h = harness({ [CONFIG_KEY]: JSON.stringify({ paired_mode: true, telemetry: true, service_worker: true }) }, () => null);
    h.paired.start();
    expect(h.paired.enabled()).toBe(true);
  });
});

describe("pairing", () => {
  it("shows the 8-char code, polls until approved and stores the device credential", () => {
    let polls = 0;
    const h = harness({ [CONFIG_KEY]: JSON.stringify({ paired_mode: true }) }, (r) => {
      if (r.url.endsWith("/devices/pairing-code")) return { status: 201, body: { pairing_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", code: "ABCD2345", poll_secret: "s".repeat(43), expires_at: new Date(NOW + 600_000).toISOString() } };
      if (r.url.endsWith("/devices/token")) return ++polls < 2 ? { status: 202, body: { status: "pending" } } : { status: 200, body: cred() };
      if (r.url.endsWith("/profiles")) return { status: 200, body: { profiles: [] } };
      return { status: 404 };
    });
    h.paired.startPairing();
    expect(h.paired.pairing()).toEqual({ state: "code", code: "ABCD2345" });
    h.timers.shift()!();
    expect(h.paired.isPaired()).toBe(false);
    h.timers.shift()!();
    expect(h.paired.isPaired()).toBe(true);
    expect(JSON.parse(h.store.getItem(DEVICE_KEY)!)).toMatchObject({ device_id: DEVICE });
    const tokenCall = h.calls.find((c) => c.url.endsWith("/devices/token"))!;
    expect(tokenCall.body).toEqual({ pairing_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", poll_secret: "s".repeat(43) });
  });

  it("expired code (410) and offline both degrade to a retry screen", () => {
    const h = harness({ [CONFIG_KEY]: JSON.stringify({ paired_mode: true }) }, (r) => (r.url.endsWith("/devices/pairing-code") ? { status: 201, body: { pairing_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", code: "ABCD2345", poll_secret: "s".repeat(43), expires_at: new Date(NOW + 600_000).toISOString() } } : { status: 410 }));
    h.paired.startPairing();
    h.timers.shift()!();
    expect(h.paired.pairing().state).toBe("expired");
    const off = harness({ [CONFIG_KEY]: JSON.stringify({ paired_mode: true }) }, () => null);
    off.paired.startPairing();
    expect(off.paired.pairing().state).toBe("offline");
  });
});

function pairedServer(extra: Route = () => null) {
  const imports: { body: unknown; key: string }[] = [];
  const route: Route = (r) => {
    const x = extra(r);
    if (x) return x;
    if (r.url.endsWith("/student/config")) return { status: 200, body: { paired_mode: true, telemetry: true, service_worker: true } };
    if (r.url.includes("/catalog/manifest")) return { status: 200, body: manifestFixture([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), headers: { ETag: '"rev-1"' } };
    const lm = /\/catalog\/lessons\/(.+)$/.exec(r.url);
    if (lm) {
      const t = manifestFixture([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).subjects[1]!.topics[0]!.lessons.find((l) => l.id === lm[1])!.sort_order;
      return { status: 200, body: lessonForTable(t, t === 2 ? { themes: ["candy"] } : {}) };
    }
    if (r.url.endsWith("/profiles")) return { status: 200, body: { profiles: [{ id: ASHA, slot: 1, display_name: "Asha", grade: 2, avatar_id: "fox" }, { id: RAVI, slot: 2, display_name: "Ravi", grade: 6, avatar_id: "astronaut" }] } };
    if (r.url.endsWith("/progress/legacy-import")) {
      imports.push({ body: r.body, key: r.headers!["Idempotency-Key"]! });
      return { status: 200, body: { migration_run_id: (r.body as { migration_run_id: string }).migration_run_id, outcome: imports.length > 1 ? "already_imported" : "imported", per_profile: [], historical: { entries_found: 0, entries_pending_assignment: 0, entries_unrecognized: 0 } } };
    }
    if (r.url.includes("/progress?")) return { status: 200, body: { items: [], next_cursor: null } };
    return { status: 404 };
  };
  return { route, imports };
}

describe("paired: catalog, legacy import, telemetry", () => {
  it("replaces the built-in tables only with a complete valid catalog and caches it", () => {
    const s = pairedServer();
    const h = harness({ [DEVICE_KEY]: JSON.stringify(cred()) }, s.route);
    h.paired.start();
    const c = h.paired.catalog();
    expect(c.source).toBe("server");
    expect(c.tables.find((t) => t.table === 2)!.worlds).toEqual(["candy"]);
    // next launch offline: cached catalog, no network
    const offline = harness(h.store.dump(), () => null);
    expect(offline.paired.catalog().source).toBe("server");
    // a broken lesson response keeps the last good catalog (CAT-008)
    const broken = harness(h.store.dump(), (r) => (r.url.includes("/catalog/lessons/") ? { status: 500 } : r.url.includes("/catalog/manifest") ? { status: 200, body: manifestFixture([1, 2, 3], { revision: 2, versionNo: 2 }) } : s.route(r)));
    broken.paired.start();
    expect(broken.paired.catalog().tables).toHaveLength(10);
  });

  it("legacy import: contract-valid request, server-verifiable fingerprint, linked profiles only, historical only when assigned, idempotent retry", () => {
    let fail = true;
    const s = pairedServer((r) => (r.url.endsWith("/progress/legacy-import") && fail ? { status: 0 } : null));
    const h = harness(
      { [DEVICE_KEY]: JSON.stringify(cred()), [LEGACY_PROFILES_KEY]: profilesText, "breaknlearn.progress.v1": JSON.stringify(historical["breaknlearn.progress.v1"]) },
      s.route,
    );
    h.paired.start();
    expect(h.paired.historicalCount()).toBe(1);
    h.paired.saveLinks({ profiles: { "child-1": ASHA }, historical: null });
    const first = h.calls.filter((c) => c.url.endsWith("/progress/legacy-import"));
    expect(first).toHaveLength(1);
    const body = first[0]!.body as Record<string, unknown>;
    expect(LegacyImportRequest.safeParse(body).success).toBe(true);
    const raw = body.raw as Record<string, unknown>;
    expect(createHash("sha256").update(legacyFingerprintInput(raw), "utf8").digest("hex")).toBe(body.legacy_fingerprint);
    expect((raw[LEGACY_PROFILES_KEY] as { profiles: { id: string }[] }).profiles.map((p) => p.id)).toEqual(["child-1"]);
    expect(raw["breaknlearn.progress.v1"]).toBeNull(); // not assigned by a guardian → not uploaded
    expect(body).not.toHaveProperty("historical_learner_id");
    // network failure: retried later with the same run id, body and Idempotency-Key
    fail = false;
    h.paired.saveLinks({ profiles: { "child-1": ASHA }, historical: null });
    expect(s.imports).toHaveLength(1);
    expect(s.imports[0]!.body).toEqual(body);
    expect(s.imports[0]!.key).toBe(first[0]!.headers!["Idempotency-Key"]);
    expect(JSON.parse(h.store.getItem(IMPORT_KEY)!)[0].status).toBe("done");
    // linking Ravi and assigning historical ×3 entries triggers one more import covering only those
    h.paired.saveLinks({ profiles: { "child-1": ASHA, "child-2": RAVI }, historical: RAVI });
    expect(s.imports).toHaveLength(2);
    const second = s.imports[1]!.body as Record<string, unknown>;
    expect(LegacyImportRequest.safeParse(second).success).toBe(true);
    expect(second.historical_learner_id).toBe(RAVI);
    expect((second.raw as Record<string, { profiles?: { id: string }[] }>)[LEGACY_PROFILES_KEY]!.profiles!.map((p) => p.id)).toEqual(["child-2"]);
    // nothing left to import
    h.paired.saveLinks({ profiles: { "child-1": ASHA, "child-2": RAVI }, historical: RAVI });
    expect(s.imports).toHaveLength(2);
    expect(h.paired.historicalCount()).toBe(0);
  });

  it("telemetry events validate against the frozen LearningEvent schema and are sent with an Idempotency-Key", () => {
    const batches: { events: unknown[]; key: string }[] = [];
    const s = pairedServer((r) => {
      if (!r.url.endsWith("/telemetry/batch")) return null;
      const events = (r.body as { events: { event_id: string }[] }).events;
      batches.push({ events, key: r.headers!["Idempotency-Key"]! });
      return { status: 200, body: { accepted: events.map((e) => e.event_id), duplicates: [], rejected: [] } };
    });
    const h = harness({ [DEVICE_KEY]: JSON.stringify(cred()), [LEGACY_PROFILES_KEY]: profilesText }, s.route);
    h.paired.start();
    h.paired.saveLinks({ profiles: { "child-1": ASHA }, historical: null });
    const asha = fixture[LEGACY_PROFILES_KEY].profiles[0];
    const ravi = fixture[LEGACY_PROFILES_KEY].profiles[1];
    const lesson = h.paired.catalog().tables[6]!;
    const ctx = { profile: asha, lesson, worldId: "puppy" };
    h.paired.profileSelected(asha);
    h.paired.lessonStarted(ctx, false, false);
    h.paired.slideEntered(ctx, 1);
    h.paired.tick(ctx, 1, 16_000);
    h.paired.pauseChanged(ctx, 1, true);
    h.paired.progressSaved(ctx, 10, 0, true);
    h.paired.quizStarted(ctx);
    h.paired.answered(ctx, 4, 28);
    h.paired.answered(ctx, 5, 999);
    h.paired.quizCompleted(ctx);
    h.paired.profileSelected(ravi); // not linked: no events for Ravi
    h.paired.lessonStarted({ profile: ravi, lesson, worldId: "farm" }, false, false);
    const queued = JSON.parse(h.store.getItem(QUEUE_KEY)!) as Record<string, unknown>[];
    expect(queued.map((e) => e.event_type)).toEqual(["profile_selected", "session_started", "lesson_started", "slide_entered", "playback_heartbeat", "playback_paused", "lesson_completed", "quiz_started", "answer_submitted", "answer_submitted", "quiz_completed"]);
    for (const e of queued) expect(LearningEvent.safeParse(e).error?.issues ?? []).toEqual([]);
    expect(new Set(queued.map((e) => e.learner_id))).toEqual(new Set([ASHA]));
    expect(queued.map((e) => e.client_sequence)).toEqual(queued.map((_, i) => i));
    expect(queued[4]!.payload).toEqual({ foreground: true, playing: true, visible_ms: 16000, playback_ms: 16000, theme_key: "puppy", slide_index: 1 });
    const answers = queued.filter((e) => e.event_type === "answer_submitted").map((e) => e.payload as Record<string, unknown>);
    expect(answers[0]).toMatchObject({ question_version_key: "grade2.math.multiplication.table-7.fact-4.v1", attempt_stage: "immediate" });
    expect(answers[1]!.selected_option_id).toBe("v-999");
    h.paired.hidden();
    expect(batches).toHaveLength(1);
    expect(batches[0]!.key).toBe(`tb-${queued[0]!.event_id}-${queued.length + 1}`); // + app_hidden
    expect(h.paired.pendingUploads()).toBe(0);
  });

  it("refreshes an expired token, and a revoked device (refresh 401) stops all device writes but keeps local progress", () => {
    const s = pairedServer((r) => (r.url.endsWith("/devices/token/refresh") ? { status: 401, body: { error: { code: "unauthorized" } } } : null));
    const h = harness({ [DEVICE_KEY]: JSON.stringify(cred("old", NOW - 1)), [LEGACY_PROFILES_KEY]: profilesText }, s.route);
    h.paired.start();
    expect(h.calls.some((c) => c.url.endsWith("/devices/token/refresh"))).toBe(true);
    expect(h.paired.isPaired()).toBe(false);
    expect(h.store.getItem(DEVICE_KEY)).toBeNull();
    expect(h.paired.catalog().source).toBe("builtin");
    expect(h.store.getItem(LEGACY_PROFILES_KEY)).toBe(profilesText);

    const ok = harness({ [DEVICE_KEY]: JSON.stringify(cred("old", NOW - 1)) }, (r) => (r.url.endsWith("/devices/token/refresh") ? { status: 200, body: cred("new") } : s.route(r)));
    ok.paired.start();
    const prof = ok.calls.find((c) => c.url.endsWith("/profiles"))!;
    expect(prof.headers!.Authorization).toBe("Bearer new");
  });
});

describe("paired: no parental consent yet (403 consent_required)", () => {
  const consentRequired = { status: 403, body: { error: { code: "consent_required", message: "Consent required", request_id: "r" } } };

  it("drops refused telemetry batches instead of uploading them later, and keeps the legacy import pending", () => {
    let consent = false;
    const batches: { event_id: string }[][] = [];
    const refused: string[] = [];
    const s = pairedServer((r) => {
      if (r.url.endsWith("/progress/legacy-import") && !consent) return consentRequired;
      if (!r.url.endsWith("/telemetry/batch")) return null;
      const events = (r.body as { events: { event_id: string }[] }).events;
      if (!consent) {
        refused.push(...events.map((e) => e.event_id));
        return consentRequired;
      }
      batches.push(events);
      return { status: 200, body: { accepted: events.map((e) => e.event_id), duplicates: [], rejected: [] } };
    });
    const h = harness({ [DEVICE_KEY]: JSON.stringify(cred()), [LEGACY_PROFILES_KEY]: profilesText }, s.route);
    h.paired.start();
    h.paired.saveLinks({ profiles: { "child-1": ASHA }, historical: null });
    expect(JSON.parse(h.store.getItem(IMPORT_KEY)!)[0].status).toBe("pending");
    const asha = fixture[LEGACY_PROFILES_KEY].profiles[0];
    h.paired.profileSelected(asha);
    h.paired.hidden(); // flush while consent is missing
    expect(refused.length).toBeGreaterThan(0);
    expect(JSON.parse(h.store.getItem(QUEUE_KEY) ?? "[]")).toEqual([]);
    consent = true;
    h.paired.saveLinks({ profiles: { "child-1": ASHA }, historical: null });
    expect(JSON.parse(h.store.getItem(IMPORT_KEY)!)[0].status).toBe("done");
    h.paired.hidden();
    // nothing recorded while consent was off is ever uploaded
    const uploaded = batches.flat().map((e) => e.event_id);
    for (const id of refused) expect(uploaded).not.toContain(id);
  });
});
