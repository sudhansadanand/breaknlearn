/**
 * A9-PRIV-01 consent API and enforcement with in-memory fakes (no database). The real SQL gate and RLS are proven in
 * test/integration/privacy-db.test.ts. Every enforced endpoint: unauthenticated → 401 first (SEC-001), authenticated
 * without consent → 403 consent_required with nothing stored, and a withdrawal stops ingestion on the next request.
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signDeviceAccessToken } from "@bnl/auth";
import { ApiError, MULTIPLICATION_LESSON_IDS, PairingCodeResponse } from "@bnl/contracts";
import { setDepsForTesting } from "../../src/server/deps";
import { setCurriculumDepsForTesting } from "../../src/server/curriculum/deps";
import { setLearningRepoForTesting } from "../../src/server/learning";
import { CONSENT_VERSION } from "../../src/server/privacy/consent-text";
import { allowAllConsentGate, setConsentGateForTesting } from "../../src/server/privacy/gate";
import * as imports from "../../src/app/api/v1/admin/imports/route";
import * as plans from "../../src/app/api/v1/admin/school-plans/route";
import { GUARDIAN_A, HH_A, HH_B, OUTSIDER, OWNER_A, OWNER_B, bodyOf, req } from "../fakes";
import { assessmentRoutes, attemptParams } from "../assessment/routes";
import { makeCurriculumEnv, type CurriculumTestEnv } from "../curriculum/fakes";
import { deviceRequest, legacyBody, legacyFixture, makeEvent } from "../learning/builders";
import { emptyLearningStore, fakeLearningRepo, rollbackRunner, type LearningStore } from "../learning/fake-repo";
import { learningRoutes } from "../learning/routes";
import { routes } from "../routes";
import { storeConsentGate } from "./helpers";

const DEV_A = "da000000-0000-4000-8000-0000000000a1";
const A1 = "c1000000-0000-4000-8000-0000000000a1";
const A2 = "c1000000-0000-4000-8000-0000000000a2";
const LESSON = MULTIPLICATION_LESSON_IDS[3]!;
const VERSION = "7a000000-0000-4000-8000-000000000003";

let env: CurriculumTestEnv;
let ls: LearningStore;
let token: string;
let gateCalls: string[];

beforeEach(async () => {
  env = makeCurriculumEnv();
  ls = emptyLearningStore([{ id: LESSON, versions: [VERSION] }]);
  setDepsForTesting({ ...env.deps, db: rollbackRunner(env.deps.db, env.store, ls) });
  setCurriculumDepsForTesting(env.cdeps);
  setLearningRepoForTesting(fakeLearningRepo(env.store, ls));
  gateCalls = [];
  setConsentGateForTesting(storeConsentGate(env.store, gateCalls));
  env.store.devices.push({ id: DEV_A, householdId: HH_A, label: "TV", tokenVersion: 1, refreshTokenHash: null, lastSeenAt: null, revokedAt: null, createdAt: env.clock.now });
  for (const [id, slot] of [[A1, 1], [A2, 2]] as const) {
    env.store.profiles.push({ id, householdId: HH_A, slot, displayName: "Kid", grade: 2, avatarId: "fox", preferences: {}, updatedAt: env.clock.now });
  }
  token = (await signDeviceAccessToken(env.deps.keys.deviceToken, { deviceId: DEV_A, householdId: HH_A, tokenVersion: 1 }, env.clock.now)).token;
  process.env.FEATURE_TELEMETRY = "true";
  process.env.FEATURE_ASSESSMENTS = "true";
});
afterEach(() => {
  setDepsForTesting(null);
  setCurriculumDepsForTesting(null);
  setLearningRepoForTesting(null);
  setConsentGateForTesting(allowAllConsentGate);
  delete process.env.FEATURE_TELEMETRY;
  delete process.env.FEATURE_ASSESSMENTS;
});

const sess = (who: { userId: string; email: string }) => env.auth.sessionFor(who);
const consent = (session: string, body: Record<string, unknown>, o: Parameters<typeof req>[2] = {}) =>
  routes.consent.POST(req("POST", "/api/v1/admin/consent", { session, body, ...o }));
const getConsent = (session?: string) => routes.consent.GET(req("GET", "/api/v1/admin/consent", session ? { session } : {}));
const grant = (scopes?: string[], who = OWNER_A) => consent(sess(who), { consent_version: CONSENT_VERSION, decision: "grant", ...(scopes ? { scopes } : {}) });
const revoke = (scopes?: string[], who = OWNER_A) => consent(sess(who), { consent_version: CONSENT_VERSION, decision: "revoke", ...(scopes ? { scopes } : {}) });

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = ApiError.parse(await res.json());
  expect(body.error.code).toBe(code);
  return body;
}

describe("GET/POST /api/v1/admin/consent", () => {
  it("401 without a session; 403 for an adult without a household (no data)", async () => {
    await expectError(await getConsent(), 401, "unauthorized");
    await expectError(await consent("", { consent_version: CONSENT_VERSION, decision: "grant" }, { session: undefined }), 401, "unauthorized");
    await expectError(await getConsent(sess(OUTSIDER)), 403, "forbidden");
    await expectError(await grant(undefined, OUTSIDER), 403, "forbidden");
    expect(env.store.consent).toEqual([]);
  });

  it("GET reports each scope and the current notice version; nothing granted by default", async () => {
    const res = await getConsent(sess(GUARDIAN_A));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await bodyOf(res);
    expect(body).toMatchObject({ current_version: CONSENT_VERSION, text_status: "draft", needs_review: false });
    expect((body.scopes as { scope: string; granted: boolean }[]).map((s) => [s.scope, s.granted])).toEqual([
      ["learning_data", false], ["telemetry", false], ["school_uploads", false],
    ]);
  });

  it("grants per scope (idempotent per version), audited with scopes and role only", async () => {
    const r1 = await grant(["learning_data"]);
    expect(r1.status).toBe(200);
    expect(await bodyOf(r1)).toMatchObject({ scopes: ["learning_data"], changed_scopes: ["learning_data"], changed: true });
    const r2 = await grant(["learning_data", "telemetry"]);
    expect(await bodyOf(r2)).toMatchObject({ changed_scopes: ["telemetry"] });
    expect(env.store.consent.map((c) => [c.scope, c.consentVersion, c.householdId])).toEqual([
      ["learning_data", CONSENT_VERSION, HH_A], ["telemetry", CONSENT_VERSION, HH_A],
    ]);
    const audit = env.store.audit.filter((a) => a.action === "consent.granted");
    expect(audit).toHaveLength(2);
    expect(audit[1]).toMatchObject({ actorAuthId: OWNER_A.userId, householdId: HH_A, targetType: "consent_record" });
    expect(JSON.stringify(audit)).not.toMatch(/Kid|owner@|guardian@/);
    const state = await bodyOf(await getConsent(sess(OWNER_A)));
    expect((state.scopes as { granted: boolean; current: boolean }[]).map((s) => s.granted)).toEqual([true, true, false]);
  });

  it("the original body (no scopes) still works: grant and revoke cover all three scopes", async () => {
    expect((await consent(sess(OWNER_A), { consent_version: "2026-11", decision: "grant" })).status).toBe(200);
    expect(env.store.consent.map((c) => c.scope).sort()).toEqual(["learning_data", "school_uploads", "telemetry"]);
    const state = await bodyOf(await getConsent(sess(OWNER_A)));
    expect(state.needs_review).toBe(true); // granted under another version than the current notice
    expect(await bodyOf(await consent(sess(OWNER_A), { consent_version: "2026-11", decision: "revoke" }))).toMatchObject({ changed: true });
    expect(env.store.consent.every((c) => c.revokedAt !== null)).toBe(true);
  });

  it("a guardian can withdraw consent the owner gave (consent belongs to the household)", async () => {
    await grant();
    const res = await revoke(["telemetry"], GUARDIAN_A);
    expect(await bodyOf(res)).toMatchObject({ changed_scopes: ["telemetry"] });
    expect(env.store.consent.filter((c) => c.revokedAt === null).map((c) => c.scope).sort()).toEqual(["learning_data", "school_uploads"]);
    expect(env.store.audit.at(-1)).toMatchObject({ action: "consent.revoked", actorAuthId: GUARDIAN_A.userId });
  });

  it("validation and CSRF: unknown scope, empty scopes, overlong version, cross-site request", async () => {
    await expectError(await consent(sess(OWNER_A), { consent_version: CONSENT_VERSION, decision: "grant", scopes: ["camera"] }), 422, "validation_failed");
    await expectError(await consent(sess(OWNER_A), { consent_version: CONSENT_VERSION, decision: "grant", scopes: [] }), 422, "validation_failed");
    await expectError(await consent(sess(OWNER_A), { consent_version: "x".repeat(41), decision: "grant" }), 422, "validation_failed");
    await expectError(await consent(sess(OWNER_A), { consent_version: CONSENT_VERSION, decision: "grant" }, { origin: "https://evil.example" }), 403, "forbidden");
    expect(env.store.consent).toEqual([]);
  });

  it("household B's owner cannot see or change household A's consent", async () => {
    await grant();
    await revoke(undefined, OWNER_B);
    expect(env.store.consent.every((c) => c.revokedAt === null)).toBe(true);
    const b = await bodyOf(await getConsent(sess(OWNER_B)));
    expect((b.scopes as { granted: boolean }[]).every((s) => !s.granted)).toBe(true);
  });
});

describe("enforcement: pairing approval needs learning_data", () => {
  async function newCode() {
    return PairingCodeResponse.parse(await (await routes.pairingCode.POST(req("POST", "/api/v1/devices/pairing-code", { csrf: false }))).json());
  }
  const approve = (session: string | undefined, code: string) => routes.pair.POST(req("POST", "/api/v1/devices/pair", { ...(session ? { session } : {}), body: { code, device_label: "Living room TV" } }));

  it("401 without a session, 403 consent_required without consent, 200 after the parent consents", async () => {
    const devicesBefore = env.store.devices.length;
    const code = await newCode();
    await expectError(await approve(undefined, code.code), 401, "unauthorized");
    const denied = await expectError(await approve(sess(OWNER_A), code.code), 403, "consent_required");
    expect(denied.error.details).toEqual({ scopes: ["learning_data"] });
    expect(env.store.devices).toHaveLength(devicesBefore);
    expect(env.store.audit.map((a) => a.action)).not.toContain("device.pair_approved");
    // telemetry/school_uploads alone are not enough.
    await grant(["telemetry", "school_uploads"]);
    await expectError(await approve(sess(OWNER_A), code.code), 403, "consent_required");
    await grant(["learning_data"]);
    expect((await approve(sess(GUARDIAN_A), code.code)).status).toBe(200);
    expect(env.store.devices).toHaveLength(devicesBefore + 1);
  });

  it("household B's consent does not open pairing for household A", async () => {
    env.store.consent.push({ householdId: HH_B, userId: OWNER_B.userId, consentVersion: CONSENT_VERSION, scope: "learning_data", grantedAt: env.clock.now, revokedAt: null });
    const code = await newCode();
    await expectError(await approve(sess(OWNER_A), code.code), 403, "consent_required");
    expect(gateCalls).toEqual(["adult:" + HH_A]);
  });
});

describe("enforcement: device ingestion endpoints", () => {
  const ctx = () => ({ deviceId: DEV_A, learnerId: A1, sessionId: randomUUID(), lessonId: LESSON, base: env.clock.now.getTime() - 60_000 });
  const tele = (bearer: string | undefined, events: unknown[]) => learningRoutes.telemetryBatch.POST(deviceRequest("POST", "/api/v1/telemetry/batch", { ...(bearer ? { bearer } : {}), body: { events } }));
  const syncBody = { learner_id: A1, lesson_id: LESSON, theme_key: "candy", attempt_id: "a7000000-0000-4000-8000-000000000001", client_revision: 1,
    base_server_revision: null, slide_id: "step-2", position_seconds: 1, completed: false, client_updated_at: "2026-11-14T09:59:00Z" };
  const sync = (bearer?: string) => learningRoutes.progressSync.POST(deviceRequest("POST", "/api/v1/progress/sync", { ...(bearer ? { bearer } : {}), body: syncBody }));
  const legacy = async (bearer?: string) => learningRoutes.legacyImport.POST(deviceRequest("POST", "/api/v1/progress/legacy-import", {
    ...(bearer ? { bearer } : {}),
    body: await legacyBody(legacyFixture("profiles-v1-two-children.json"), [{ local_profile_id: "child-1", learner_id: A1 }, { local_profile_id: "child-2", learner_id: A2 }]),
  }));
  const start = (bearer?: string) => assessmentRoutes.start.POST(deviceRequest("POST", "/api/v1/assessments/start", {
    ...(bearer ? { bearer } : {}), idempotencyKey: null, body: { learner_id: A1, lesson_id: LESSON, stage: "immediate", client_attempt_id: randomUUID() },
  }));
  const ATTEMPT = "a7000000-0000-4000-8000-0000000000ff";
  const answer = (bearer?: string) => assessmentRoutes.answers.POST(deviceRequest("POST", `/api/v1/assessments/${ATTEMPT}/answers`, {
    ...(bearer ? { bearer } : {}), idempotencyKey: null, body: { question_version_key: "q-1", selected_option_id: "o-1" },
  }), attemptParams(ATTEMPT));
  const finish = (bearer?: string) => assessmentRoutes.finish.POST(deviceRequest("POST", `/api/v1/assessments/${ATTEMPT}/finish`, { ...(bearer ? { bearer } : {}), idempotencyKey: null }), attemptParams(ATTEMPT));

  const cases: [string, (bearer?: string) => Promise<Response>, string[]][] = [
    ["telemetry batch", (b) => tele(b, [makeEvent(ctx(), "app_opened", 0)]), ["learning_data", "telemetry"]],
    ["progress sync", sync, ["learning_data"]],
    ["legacy import", legacy, ["learning_data"]],
    ["assessment start", start, ["learning_data"]],
    ["assessment answer", answer, ["learning_data"]],
    ["assessment finish", finish, ["learning_data"]],
  ];

  it.each(cases)("%s: 401 without a token, 403 consent_required without consent, nothing stored", async (_n, call, scopes) => {
    await expectError(await call(undefined), 401, "unauthorized");
    const body = await expectError(await call(token), 403, "consent_required");
    expect(body.error.details).toEqual({ scopes });
    expect(ls.events).toEqual([]);
    expect(ls.sessions).toEqual([]);
    expect(ls.progress).toEqual([]);
    expect(gateCalls).toEqual([`device:${HH_A}`]);
  });

  it("telemetry needs both learning_data and telemetry", async () => {
    await grant(["learning_data"]);
    const body = await expectError(await tele(token, [makeEvent(ctx(), "app_opened", 0)]), 403, "consent_required");
    expect(body.error.details).toEqual({ scopes: ["telemetry"] });
    await revoke(["learning_data"]);
    await grant(["telemetry"]);
    await expectError(await tele(token, [makeEvent(ctx(), "app_opened", 0)]), 403, "consent_required");
  });

  it("withdrawing consent stops ingestion on the very next request; data already stored is kept", async () => {
    await grant(["learning_data", "telemetry"]);
    const c = ctx();
    const ok = await tele(token, [makeEvent(c, "app_opened", 0)]);
    expect(ok.status).toBe(200);
    expect(ls.events).toHaveLength(1);
    expect((await sync(token)).status).toBe(200);
    expect(ls.progress).toHaveLength(1);

    await revoke(["telemetry"], GUARDIAN_A);
    await expectError(await tele(token, [makeEvent(c, "lesson_started", 1)]), 403, "consent_required");
    expect(ls.events).toHaveLength(1);
    // Progress (learning_data) still syncs; telemetry is off.
    expect((await sync(token)).status).toBe(200);

    await revoke(["learning_data"]);
    await expectError(await sync(token), 403, "consent_required");
    // Existing rows stay until the parent asks for deletion.
    expect(ls.events).toHaveLength(1);
    expect(ls.progress).toHaveLength(1);
  });

  it("a replayed Idempotency-Key cannot bypass a withdrawal", async () => {
    await grant(["learning_data", "telemetry"]);
    const events = [makeEvent(ctx(), "app_opened", 0)];
    const key = `idem-${randomUUID()}`;
    const send = () => learningRoutes.telemetryBatch.POST(deviceRequest("POST", "/api/v1/telemetry/batch", { bearer: token, idempotencyKey: key, body: { events } }));
    expect((await send()).status).toBe(200);
    await revoke(["telemetry"]);
    await expectError(await send(), 403, "consent_required");
  });
});

describe("enforcement: school syllabus uploads need school_uploads", () => {
  const TOC = "1. Numbers up to 100 ........ 1\n2. Shapes and Patterns ........ 14\n";
  const importReq = (session: string | undefined, planId: string) => {
    const r = req("POST", "/api/v1/admin/imports", { ...(session ? { session } : {}), body: { school_plan_id: planId, toc_text: TOC, format: "lines" } });
    const h = new Headers(r.headers);
    h.set("Idempotency-Key", `k-consent-${randomUUID().slice(0, 8)}`);
    return imports.POST(new Request(r.url, { method: "POST", headers: h, body: r.body, duplex: "half" } as RequestInit));
  };

  it("401 without a session, 403 consent_required without consent (nothing stored), 202 after consent", async () => {
    // Creating a plan (metadata only, no document) is not gated.
    const planRes = await plans.POST(req("POST", "/api/v1/admin/school-plans", { session: sess(OWNER_A), body: { grade: 2, subject_key: "math", academic_year: "2026-27" } }));
    expect(planRes.status).toBe(201);
    const planId = ((await bodyOf(planRes)).school_plan as { id: string }).id;
    await expectError(await importReq(undefined, planId), 401, "unauthorized");
    await expectError(await importReq(sess(OWNER_A), planId), 403, "consent_required");
    expect(env.storage.objects.size).toBe(0);
    expect(env.cs.uploads).toEqual([]);
    await grant(["school_uploads"], GUARDIAN_A);
    expect((await importReq(sess(OWNER_A), planId)).status).toBe(202);
  });
});
