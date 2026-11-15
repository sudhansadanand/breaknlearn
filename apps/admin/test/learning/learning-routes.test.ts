/** Route-level behaviour of the learning endpoints with in-memory fakes (no database). */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { signDeviceAccessToken } from "@bnl/auth";
import { ApiError, MULTIPLICATION_LESSON_IDS, ProgressSyncResponse, TelemetryAck } from "@bnl/contracts";
import { setDepsForTesting } from "../../src/server/deps";
import { setLearningRepoForTesting } from "../../src/server/learning";
import { LegacyImportReceiptV1A } from "../../src/server/learning/legacy-import";
import { legacyAttemptId, uuidV5 } from "../../src/server/learning/uuid";
import { HH_A, HH_B, makeTestEnv, type TestEnv } from "../fakes";
import { deviceRequest, heartbeat, legacyBody, legacyFixture, makeEvent, type EventCtx } from "./builders";
import { emptyLearningStore, fakeLearningRepo, rollbackRunner, type LearningStore } from "./fake-repo";
import { learningRoutes } from "./routes";

const DEV_A = "da000000-0000-4000-8000-0000000000a1";
const DEV_B = "db000000-0000-4000-8000-0000000000b1";
const A1 = "c1000000-0000-4000-8000-0000000000a1";
const A2 = "c1000000-0000-4000-8000-0000000000a2";
const B1 = "c1000000-0000-4000-8000-0000000000b1";
const LESSON = MULTIPLICATION_LESSON_IDS[3]!;
const VERSION = "7a000000-0000-4000-8000-000000000003";

let env: TestEnv;
let ls: LearningStore;
let tokenA: string;
let tokenB: string;
let ctx: EventCtx;

beforeEach(async () => {
  env = makeTestEnv();
  ls = emptyLearningStore([{ id: LESSON, versions: [VERSION] }, ...[1, 2].map((t) => ({ id: MULTIPLICATION_LESSON_IDS[t]!, versions: [] }))]);
  setDepsForTesting({ ...env.deps, db: rollbackRunner(env.deps.db, env.store, ls) });
  setLearningRepoForTesting(fakeLearningRepo(env.store, ls));
  for (const [id, householdId] of [[DEV_A, HH_A], [DEV_B, HH_B]] as const) {
    env.store.devices.push({ id, householdId, label: "TV", tokenVersion: 1, refreshTokenHash: null, lastSeenAt: null, revokedAt: null, createdAt: env.clock.now });
  }
  for (const [id, householdId, slot] of [[A1, HH_A, 1], [A2, HH_A, 2], [B1, HH_B, 1]] as const) {
    env.store.profiles.push({ id, householdId, slot, displayName: "Kid", grade: 2, avatarId: "fox", preferences: {}, updatedAt: env.clock.now });
  }
  tokenA = (await signDeviceAccessToken(env.deps.keys.deviceToken, { deviceId: DEV_A, householdId: HH_A, tokenVersion: 1 }, env.clock.now)).token;
  tokenB = (await signDeviceAccessToken(env.deps.keys.deviceToken, { deviceId: DEV_B, householdId: HH_B, tokenVersion: 1 }, env.clock.now)).token;
  ctx = { deviceId: DEV_A, learnerId: A1, sessionId: randomUUID(), lessonId: LESSON, base: env.clock.now.getTime() - 60_000 };
  process.env.FEATURE_TELEMETRY = "true";
});
afterEach(() => {
  setDepsForTesting(null);
  setLearningRepoForTesting(null);
  delete process.env.FEATURE_TELEMETRY;
});

const tele = (o: Parameters<typeof deviceRequest>[2]) => learningRoutes.telemetryBatch.POST(deviceRequest("POST", "/api/v1/telemetry/batch", { bearer: tokenA, ...o }));
const code = async (r: Response) => ApiError.parse(await r.json()).error.code;

describe("POST /telemetry/batch", () => {
  it("fails closed when FEATURE_TELEMETRY is not exactly 'true'", async () => {
    for (const v of [undefined, "", "1", "TRUE", "false"]) {
      if (v === undefined) delete process.env.FEATURE_TELEMETRY;
      else process.env.FEATURE_TELEMETRY = v;
      const r = await tele({ body: { events: [makeEvent(ctx, "app_opened", 0)] } });
      expect(r.status, String(v)).toBe(503);
      expect(await code(r)).toBe("feature_disabled");
    }
    expect(ls.events).toEqual([]);
  });

  it("auth, header and envelope errors", async () => {
    const ev = makeEvent(ctx, "app_opened", 0);
    expect((await tele({ bearer: "", body: { events: [ev] } })).status).toBe(401);
    expect((await tele({ bearer: "not-a-jwt", body: { events: [ev] } })).status).toBe(401);
    expect((await tele({ idempotencyKey: null, body: { events: [ev] } })).status).toBe(422);
    expect((await tele({ idempotencyKey: "bad key!", body: { events: [ev] } })).status).toBe(422);
    expect((await tele({ rawBody: "x", contentType: "text/plain" })).status).toBe(415);
    expect((await tele({ rawBody: "{" })).status).toBe(400);
    expect((await tele({ body: { events: [] } })).status).toBe(422);
    expect((await tele({ body: { events: [ev], household_id: HH_B } })).status).toBe(422);
    const tooMany = await tele({ body: { events: Array.from({ length: 101 }, (_, i) => makeEvent(ctx, "app_opened", i)) } });
    expect(tooMany.status).toBe(413);
    expect(await code(tooMany)).toBe("payload_too_large");
    expect((await tele({ rawBody: JSON.stringify({ events: [ev], x: "y".repeat(129 * 1024) }) })).status).toBe(413);
    expect(ls.events).toEqual([]);
  });

  it("partial acknowledgement: accepted, duplicate, rejected; household from the token; replay is identical", async () => {
    const a = makeEvent(ctx, "playback_heartbeat", 0, heartbeat(true, true, 1000, 1000));
    const forged = makeEvent(ctx, "app_opened", 1, {}, { learner_id: B1 });
    const key = "tb-fixed-key-0001";
    const r1 = await tele({ idempotencyKey: key, body: { events: [a, a, forged, { nonsense: true }] } });
    const ack = TelemetryAck.parse(await r1.json());
    expect(ack).toEqual({ accepted: [a.event_id], duplicates: [a.event_id], rejected: [{ event_id: forged.event_id, code: "learner_not_in_household" }, { event_id: null, code: "schema_invalid" }] });
    expect(ls.events.map((e) => [e.eventId, e.householdId, e.qualityFlag])).toEqual([[a.event_id, HH_A, "ok"]]);
    const r2 = await tele({ idempotencyKey: key, body: { events: [a, a, forged, { nonsense: true }] } });
    expect(r2.headers.get("Idempotent-Replayed")).toBe("true");
    expect(TelemetryAck.parse(await r2.json())).toEqual(ack);
    expect(ls.events).toHaveLength(1);
  });

  it("rate limits per device (429 with Retry-After) without affecting other devices", async () => {
    let last: Response | null = null;
    for (let i = 0; i < 61; i++) last = await tele({ body: { events: [makeEvent(ctx, "app_opened", i)] } });
    expect(last!.status).toBe(429);
    expect(last!.headers.get("Retry-After")).toBeTruthy();
    const ctxB = { ...ctx, deviceId: DEV_B, learnerId: B1 };
    expect((await tele({ bearer: tokenB, body: { events: [makeEvent(ctxB, "app_opened", 0)] } })).status).toBe(200);
  });

  it("revoked device → 401 and nothing stored", async () => {
    env.store.devices[0] = { ...env.store.devices[0]!, revokedAt: env.clock.now, tokenVersion: 2 };
    expect((await tele({ body: { events: [makeEvent(ctx, "app_opened", 0)] } })).status).toBe(401);
    expect(ls.events).toEqual([]);
  });
});

const syncBody = (o: Record<string, unknown> = {}) => ({
  learner_id: A1, lesson_id: LESSON, theme_key: "candy", attempt_id: "a7000000-0000-4000-8000-000000000001",
  client_revision: 1, base_server_revision: null, slide_id: "step-2", position_seconds: 1, completed: false,
  client_updated_at: "2026-11-14T09:59:00Z", ...o,
});
const sync = (body: unknown, o: Parameters<typeof deviceRequest>[2] = {}) => learningRoutes.progressSync.POST(deviceRequest("POST", "/api/v1/progress/sync", { bearer: tokenA, body, ...o }));

describe("progress", () => {
  it("sync: applied, then stale replay of older state, then forward; client clock is ignored", async () => {
    expect(ProgressSyncResponse.parse(await (await sync(syncBody())).json())).toMatchObject({ outcome: "applied", state: { server_revision: 1 } });
    const stale = ProgressSyncResponse.parse(await (await sync(syncBody({ slide_id: "step-1", client_updated_at: "2030-01-01T00:00:00Z" }))).json());
    expect(stale).toMatchObject({ outcome: "stale_ignored", state: { slide_id: "step-2", server_revision: 1 } });
    const fwd = ProgressSyncResponse.parse(await (await sync(syncBody({ slide_id: "step-5", client_revision: 2, base_server_revision: 1, completed: true }))).json());
    expect(fwd).toMatchObject({ outcome: "applied", state: { slide_id: "step-5", completed: true, server_revision: 2 } });
  });

  it("sync: validation 422, other household learner 403, no key 422, adult cookie cannot sync (401)", async () => {
    expect((await sync(syncBody({ theme_key: "moon" }))).status).toBe(422);
    expect((await sync(syncBody({ position_seconds: 31 }))).status).toBe(422);
    expect((await sync(syncBody({ lesson_id: randomUUID() }))).status).toBe(422);
    expect((await sync(syncBody({ lesson_version_id: randomUUID() }))).status).toBe(422);
    expect((await sync(syncBody({ lesson_version_id: VERSION }))).status).toBe(200);
    const forbidden = await sync(syncBody({ learner_id: B1, attempt_id: randomUUID() }));
    expect(forbidden.status).toBe(403);
    expect((await sync(syncBody(), { idempotencyKey: null })).status).toBe(422);
    expect((await sync(syncBody(), { bearer: "" })).status).toBe(401);
    expect(ls.progress.filter((p) => p.learnerId === B1)).toEqual([]);
  });

  it("GET: query validation, 403 across households, page cursor", async () => {
    await sync(syncBody());
    const get = (q: string, bearer = tokenA) => learningRoutes.progress.GET(deviceRequest("GET", `/api/v1/progress${q}`, { bearer, idempotencyKey: null }));
    expect((await get("")).status).toBe(422);
    expect((await get(`?learner_id=${A1}&cursor=zzz`)).status).toBe(422);
    expect((await get(`?learner_id=${A1}&limit=101`)).status).toBe(422);
    expect((await get(`?learner_id=${A1}`, tokenB)).status).toBe(403);
    const ok = (await (await get(`?learner_id=${A1}`)).json()) as { items: unknown[]; next_cursor: string | null };
    expect(ok.items).toHaveLength(1);
    expect(ok.next_cursor).toBeNull();
  });
});

describe("POST /progress/legacy-import", () => {
  const imp = (body: unknown) => learningRoutes.legacyImport.POST(deviceRequest("POST", "/api/v1/progress/legacy-import", { bearer: tokenA, body }));
  const mapping = [{ local_profile_id: "child-1", learner_id: A1 }, { local_profile_id: "child-2", learner_id: A2 }];

  it("imports, then returns already_imported with an identical receipt; attempt ids are deterministic", async () => {
    const body = await legacyBody(legacyFixture("profiles-v1-two-children.json"), mapping);
    const first = LegacyImportReceiptV1A.parse(await (await imp(body)).json());
    expect(first.per_profile.map((p) => p.entries_imported)).toEqual([3, 1]);
    expect(ls.progress.map((p) => p.attemptId)).toContain(legacyAttemptId(A1, MULTIPLICATION_LESSON_IDS[1]!, "puppy"));
    const again = await (await imp(body)).json();
    expect(again).toEqual({ ...first, outcome: "already_imported" });
    expect(ls.progress).toHaveLength(4);
    expect(ls.aliases).toHaveLength(2);
    expect(JSON.stringify(env.store.audit)).not.toMatch(/Asha|Ravi/);
  });

  it("422 on fingerprint mismatch / incomplete mapping; 403 on a foreign learner; nothing written", async () => {
    const body = await legacyBody(legacyFixture("profiles-v1-two-children.json"), mapping);
    expect((await imp({ ...body, legacy_fingerprint: "f".repeat(64) })).status).toBe(422);
    expect((await imp({ ...body, raw: { ...body.raw, "breaknlearn.progress.v1": { farm: {} } } })).status).toBe(422);
    expect((await imp({ ...body, profile_mapping: [mapping[1]] })).status).toBe(422);
    expect((await imp({ ...body, profile_mapping: [mapping[0], { local_profile_id: "child-2", learner_id: B1 }] })).status).toBe(403);
    expect(ls.progress).toEqual([]);
    expect(ls.runs).toEqual([]);
  });
});

describe("uuidV5", () => {
  it("matches the contract's fixed lesson ids (same algorithm as the seed)", () => {
    expect(uuidV5("6f1d2a0e-6b1e-4a35-9a4e-2f6c3b8d9e10", "grade2.math.multiplication.table-3")).toBe(MULTIPLICATION_LESSON_IDS[3]);
  });
});
