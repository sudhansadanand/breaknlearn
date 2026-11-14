/**
 * A9 cross-tenant red-team at the HTTP layer (P6 gate `cross_tenant_redteam_pass`): the real route handlers on the
 * real schema/RLS (scripts/db/test-db.mjs). Household X is the victim; the attackers are household Y's owner and
 * TV, an outsider adult, a revoked X TV, and forged credentials (wrong key, alg=none, swapped household claim,
 * expired, stale token_version, an adult cookie presented as a device and vice versa). Every route family that
 * touches household data and every `[id]` route is attacked with X's ids (IDOR).
 *
 * Each attack must be refused (401/403/404/409/410/422), its body must not contain any of X's identifiers or
 * names, and household X's rows must be byte-for-byte unchanged at the end.
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signDeviceAccessToken } from "@bnl/auth";
import { MULTIPLICATION_LESSON_IDS, PairingCodeResponse, StartAssessmentResponse } from "@bnl/contracts";
import { LocalFsStorage } from "@bnl/storage";
import * as analyticsScores from "../../src/app/api/v1/admin/analytics/learning-scores/route";
import * as analyticsSummary from "../../src/app/api/v1/admin/analytics/summary/route";
import * as imports from "../../src/app/api/v1/admin/imports/route";
import * as importJob from "../../src/app/api/v1/admin/imports/[jobId]/route";
import * as importFile from "../../src/app/api/v1/admin/imports/[jobId]/file/route";
import * as importReview from "../../src/app/api/v1/admin/imports/[jobId]/review/route";
import * as localObject from "../../src/app/api/v1/admin/imports/local-object/route";
import * as lesson from "../../src/app/api/v1/admin/lessons/[lessonId]/route";
import * as lessonPublish from "../../src/app/api/v1/admin/lessons/[lessonId]/publish/route";
import * as lessonUnpublish from "../../src/app/api/v1/admin/lessons/[lessonId]/unpublish/route";
import * as versionPreview from "../../src/app/api/v1/admin/lessons/[lessonId]/versions/[versionId]/preview/route";
import * as versionTransition from "../../src/app/api/v1/admin/lessons/[lessonId]/versions/[versionId]/transition/route";
import * as lessons from "../../src/app/api/v1/admin/lessons/route";
import * as manifestPin from "../../src/app/api/v1/admin/manifests/[revision]/pin/route";
import * as recDismiss from "../../src/app/api/v1/admin/recommendations/[id]/dismiss/route";
import * as recs from "../../src/app/api/v1/admin/recommendations/route";
import * as schoolPlans from "../../src/app/api/v1/admin/school-plans/route";
import * as curriculumReview from "../../src/app/api/v1/admin/curriculum/[nodeId]/review/route";
import * as catalogLesson from "../../src/app/api/v1/catalog/lessons/[lessonId]/route";
import { setAssessmentRepoForTesting } from "../../src/server/assessment";
import { LOCAL_OBJECT_PATH, setCurriculumDepsForTesting } from "../../src/server/curriculum/deps";
import { sqlCurriculumRepo } from "../../src/server/curriculum/sql-repo";
import { assessmentRoutes, attemptParams } from "../assessment/routes";
import { req, type ReqOpts } from "../fakes";
import { deviceRequest, legacyBody, legacyFixture, makeEvent } from "../learning/builders";
import { freshHousehold, openDbEnv, revoke, type DbEnv, type Household } from "../learning/db-env";
import { learningRoutes } from "../learning/routes";
import { params, routes } from "../routes";

const LESSON_7 = MULTIPLICATION_LESSON_IDS[7]!;
const DRAFT_LESSON = "1e000000-0000-4000-8000-000000000001";
const DRAFT_VERSION = "1f000000-0000-4000-8000-000000000001";
const DENY = [401, 403, 404, 409, 410, 422];

let env: DbEnv;
let X: Household;
let Y: Household;
let xRevoked: { deviceId: string; token: string };
let xAttempt: string;
let xQuestionKey: string;
let xRecommendation: string;
let xJob: string;
let xObjectKey: string;
let xChapter: string;
let xNode: string;
let storageDir: string;
let local: LocalFsStorage;
const xNames = ["Synthetic Xavi", "Synthetic Xena"];

const b64url = (v: Buffer | string) => Buffer.from(v).toString("base64url");
function jwt(header: object, payload: object, key: Uint8Array | null): string {
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const sig = key ? createHmac("sha256", key).update(`${h}.${p}`).digest("base64url") : "";
  return `${h}.${p}.${sig}`;
}
function deviceClaims(sub: string, hid: string, ver = 1, offsetS = 0) {
  const iat = Math.floor(Date.now() / 1000) + offsetS;
  return { sub, hid, ver, scope: "device", iss: "bnl", aud: "bnl:device", iat, exp: iat + 900 };
}

/** Identifiers of household X that must never appear in an attacker's response. */
const xSecrets = () => [X.householdId, X.deviceId, ...X.learners, xAttempt, xRecommendation, xJob, xObjectKey, ...xNames].filter(Boolean);

async function snapshotX(): Promise<string> {
  const tables = ["learner_profiles", "paired_devices", "learner_progress", "learning_events", "learning_sessions", "assessment_attempts",
    "question_responses", "review_schedule", "recommendations", "school_plans", "syllabus_uploads", "import_jobs", "chapter_topic_mappings",
    "consent_records", "migration_runs", "household_memberships"];
  const out: Record<string, unknown> = {};
  for (const t of tables) {
    out[t] = await env.admin.unsafe(`select to_jsonb(t) - 'last_seen_at' as r from bnl.${t} t where household_id = $1 order by 1::text`, [X.householdId]);
  }
  return JSON.stringify(out);
}

async function expectRefused(label: string, res: Response): Promise<void> {
  const text = await res.text();
  if (process.env.REDTEAM_DEBUG) console.log(`[redteam] ${res.status} ${label} ${text.slice(0, 90)}`);
  expect(DENY, `${label}: status ${res.status} body ${text.slice(0, 200)}`).toContain(res.status);
  for (const s of xSecrets()) expect(text, `${label} leaked ${s}`).not.toContain(s);
}

beforeAll(async () => {
  env = openDbEnv();
  setAssessmentRepoForTesting(null);
  process.env.FEATURE_ASSESSMENTS = "true";
  process.env.FEATURE_TELEMETRY = "true";
  storageDir = mkdtempSync(join(tmpdir(), "bnl-a9-redteam-"));
  local = new LocalFsStorage(storageDir, { signingKey: new Uint8Array(32).fill(9), baseUrl: LOCAL_OBJECT_PATH });
  setCurriculumDepsForTesting({ repo: sqlCurriculumRepo, storage: local, localStorage: local, importMaxBytes: 20 * 1024 * 1024, signedUrlTtlSeconds: 60, suggestThreshold: 0.2 });

  X = await freshHousehold(env);
  Y = await freshHousehold(env);
  // Y keeps one free profile slot so the IDOR attempt on POST /profiles reaches the id check (not the 2-profile limit).
  await env.admin`delete from bnl.learner_profiles where id = ${Y.learners[1]}`;
  // freshHousehold names every learner alike; give X's learners names that only X has.
  await env.admin`update bnl.learner_profiles set display_name = case slot when 1 then ${xNames[0]!} else ${xNames[1]!} end where household_id = ${X.householdId}`;
  // A second, revoked TV in X.
  const revokedId = randomUUID();
  await env.admin`insert into bnl.paired_devices (id, household_id, label, token_version) values (${revokedId}, ${X.householdId}, 'SYNTHETIC A9 old TV', 1)`;
  xRevoked = { deviceId: revokedId, token: (await signDeviceAccessToken(env.deps.keys.deviceToken, { deviceId: revokedId, householdId: X.householdId, tokenVersion: 1 })).token };
  await revoke(env, revokedId);

  // X's own legitimate data, created through the API: an assessment attempt, progress, telemetry, an import.
  const start = await assessmentRoutes.start.POST(deviceRequest("POST", "/api/v1/assessments/start", {
    bearer: X.token, idempotencyKey: null, body: { learner_id: X.learners[0], lesson_id: LESSON_7, stage: "immediate", client_attempt_id: randomUUID() },
  }));
  expect(start.status).toBe(201);
  const started = StartAssessmentResponse.parse(await start.json());
  xAttempt = started.attempt_id;
  xQuestionKey = started.questions[0]!.question_version_key;
  const sync = await learningRoutes.progressSync.POST(deviceRequest("POST", "/api/v1/progress/sync", { bearer: X.token, body: progressBody(X.learners[0], randomUUID()) }));
  expect(sync.status).toBe(200);
  xRecommendation = randomUUID();
  await env.admin`insert into bnl.recommendations (id, household_id, learner_id, reason_code, suggested_lesson_id) values
    (${xRecommendation}, ${X.householdId}, ${X.learners[0]}, 'insufficient_evidence_take_quiz', ${LESSON_7})`;

  const owner = env.auth.sessionFor({ userId: X.ownerUserId, email: "owner-x@bnl.test" });
  const plan = await schoolPlans.POST(req("POST", "/api/v1/admin/school-plans", { session: owner, body: { grade: 2, subject_key: "math", academic_year: "2026-27", school_label: "SYNTHETIC School X" } }));
  expect(plan.status).toBe(201);
  const planId = ((await plan.json()) as { school_plan: { id: string } }).school_plan.id;
  const up = req("POST", "/api/v1/admin/imports", { session: owner });
  const h = new Headers(up.headers);
  h.set("Idempotency-Key", `a9-${randomUUID()}`);
  const form = new FormData();
  form.set("file", new File(["chapter_no,title,page_start,grade,subject\n1,Shapes and Patterns,14,2,math\n"], "x-private.csv", { type: "text/csv" }));
  form.set("school_plan_id", planId);
  const created = await imports.POST(new Request(up.url, { method: "POST", headers: h, body: form }));
  expect(created.status).toBe(202);
  xJob = ((await created.json()) as { job_id: string }).job_id;
  const [m] = await env.admin`select chapter_id, curriculum_node_id from bnl.chapter_topic_mappings where household_id = ${X.householdId} limit 1`;
  xChapter = String(m!.chapter_id);
  xNode = String(m!.curriculum_node_id);
  xObjectKey = String((await env.admin`select u.object_key from bnl.import_jobs j join bnl.syllabus_uploads u on u.id = j.upload_id where j.id = ${xJob}`)[0]!.object_key);
});

afterAll(async () => {
  delete process.env.FEATURE_ASSESSMENTS;
  delete process.env.FEATURE_TELEMETRY;
  setCurriculumDepsForTesting(null);
  rmSync(storageDir, { recursive: true, force: true });
  await env.close();
});

function progressBody(learner: string, attempt: string) {
  return {
    learner_id: learner, lesson_id: LESSON_7, theme_key: "farm", attempt_id: attempt, client_revision: 1, base_server_revision: null,
    slide_id: "step-2", position_seconds: 0, completed: false, client_updated_at: new Date().toISOString(),
  };
}

/** Device credentials an attacker could present. */
async function deviceAttackers(): Promise<{ name: string; bearer: string }[]> {
  const keys = env.deps.keys;
  return [
    { name: "Y's TV", bearer: Y.token },
    { name: "X's revoked TV", bearer: xRevoked.token },
    { name: "forged: Y's device id with X's household claim (real key)", bearer: (await signDeviceAccessToken(keys.deviceToken, { deviceId: Y.deviceId, householdId: X.householdId, tokenVersion: 1 })).token },
    { name: "forged: X's device, wrong signing key", bearer: jwt({ alg: "HS256", typ: "JWT" }, deviceClaims(X.deviceId, X.householdId), new Uint8Array(32).fill(1)) },
    { name: "forged: X's device, alg=none", bearer: jwt({ alg: "none", typ: "JWT" }, deviceClaims(X.deviceId, X.householdId), null) },
    { name: "forged: X's device signed with the dev-session key (key confusion)", bearer: jwt({ alg: "HS256", typ: "JWT" }, deviceClaims(X.deviceId, X.householdId), keys.devSession) },
    { name: "expired X token", bearer: jwt({ alg: "HS256", typ: "JWT" }, deviceClaims(X.deviceId, X.householdId, 1, -3600), keys.deviceToken) },
    { name: "X token with a future token_version", bearer: (await signDeviceAccessToken(keys.deviceToken, { deviceId: X.deviceId, householdId: X.householdId, tokenVersion: 7 })).token },
    { name: "X token with scope=adult", bearer: jwt({ alg: "HS256", typ: "JWT" }, { ...deviceClaims(X.deviceId, X.householdId), scope: "adult" }, keys.deviceToken) },
  ];
}

/** Adult sessions an attacker could present. */
function adultAttackers(): { name: string; session: string }[] {
  return [
    { name: "Y's owner", session: env.auth.sessionFor({ userId: Y.ownerUserId, email: "owner-y@bnl.test" }) },
    { name: "outsider adult", session: env.auth.sessionFor({ userId: randomUUID(), email: "outsider@bnl.test" }) },
    { name: "X's device token as a session cookie", session: X.token },
    { name: "garbage session", session: "sess-not-issued" },
  ];
}

describe("device-credential routes attacked with X's ids", () => {
  it("profiles, progress, telemetry, legacy import and assessments refuse every forged or foreign device credential", async () => {
    const before = await snapshotX();
    for (const a of await deviceAttackers()) {
      const r = (method: string, path: string, body?: unknown, key: string | null = `a9-${randomUUID()}`) =>
        deviceRequest(method, path, { bearer: a.bearer, idempotencyKey: key, ...(body === undefined ? {} : { body }) });
      const L = (s: string) => `${a.name} → ${s}`;
      // Own-household listing must never contain X (Y's TV legitimately gets 200 with Y's profiles).
      const list = await routes.profiles.GET(r("GET", "/api/v1/profiles", undefined, null));
      const listText = await list.text();
      for (const s of xSecrets()) expect(listText, L(`GET /profiles leaked ${s}`)).not.toContain(s);
      if (a.bearer !== Y.token) expect(list.status, L("GET /profiles")).toBe(401);

      await expectRefused(L("POST /profiles (X learner id)"), await routes.profiles.POST(r("POST", "/api/v1/profiles", { id: X.learners[0], slot: 2, display_name: "Hijack", grade: 2, avatar_id: "fox" }, null)));
      await expectRefused(L("GET /progress?learner_id=X"), await learningRoutes.progress.GET(r("GET", `/api/v1/progress?learner_id=${X.learners[0]}`, undefined, null)));
      await expectRefused(L("POST /progress/sync X learner"), await learningRoutes.progressSync.POST(r("POST", "/api/v1/progress/sync", progressBody(X.learners[0], randomUUID()))));
      await expectRefused(L("POST /progress/legacy-import → X learner"), await learningRoutes.legacyImport.POST(r("POST", "/api/v1/progress/legacy-import",
        await legacyBody(legacyFixture("profiles-v1-two-children.json"), [{ local_profile_id: "child-1", learner_id: X.learners[0] }, { local_profile_id: "child-2", learner_id: X.learners[1] }]))));
      await expectRefused(L("POST /assessments/start X learner"), await assessmentRoutes.start.POST(r("POST", "/api/v1/assessments/start", { learner_id: X.learners[0], lesson_id: LESSON_7, stage: "baseline", client_attempt_id: randomUUID() }, null)));
      await expectRefused(L("GET /assessments/due X learner"), await assessmentRoutes.due.GET(r("GET", `/api/v1/assessments/due?learner_id=${X.learners[0]}`, undefined, null)));
      await expectRefused(L("POST /assessments/{X attempt}/answers"), await assessmentRoutes.answers.POST(r("POST", `/api/v1/assessments/${xAttempt}/answers`, { question_version_key: xQuestionKey, selected_option_id: "a" }, null), attemptParams(xAttempt)));
      await expectRefused(L("POST /assessments/{X attempt}/finish"), await assessmentRoutes.finish.POST(r("POST", `/api/v1/assessments/${xAttempt}/finish`, undefined, null), attemptParams(xAttempt)));

      // Telemetry: a batch naming X's learner and device is never stored (the ack may be 200 with every event rejected).
      const ev = makeEvent({ deviceId: X.deviceId, learnerId: X.learners[0], sessionId: randomUUID(), lessonId: LESSON_7, base: Date.now() - 5000 }, "lesson_started", 1, { theme_key: "farm" });
      const tel = await learningRoutes.telemetryBatch.POST(r("POST", "/api/v1/telemetry/batch", { events: [ev] }, `tb-${ev.event_id}-1`));
      const telText = await tel.text();
      if (tel.status === 200) expect(JSON.parse(telText).accepted, L("telemetry accepted")).toEqual([]);
      else expect(DENY, L(`telemetry ${tel.status}`)).toContain(tel.status);
      expect((await env.admin`select 1 from bnl.learning_events where event_id = ${ev.event_id}`).length, L("telemetry stored")).toBe(0);
    }
    expect(await snapshotX()).toBe(before);
  });

  it("an adult session cookie is not a device credential", async () => {
    const owner = env.auth.sessionFor({ userId: X.ownerUserId, email: "owner-x@bnl.test" });
    const viaCookie = (path: string, body: unknown) => deviceRequest("POST", path, { session: owner, body, idempotencyKey: `a9-${randomUUID()}` });
    expect((await learningRoutes.progressSync.POST(viaCookie("/api/v1/progress/sync", progressBody(X.learners[0], randomUUID())))).status).toBe(401);
    expect((await assessmentRoutes.start.POST(viaCookie("/api/v1/assessments/start", { learner_id: X.learners[0], lesson_id: LESSON_7, stage: "baseline", client_attempt_id: randomUUID() }))).status).toBe(401);
  });
});

describe("adult-session routes attacked with X's ids (IDOR on every [id] route)", () => {
  it("analytics, recommendations, devices, school plans and imports never reveal or change X", async () => {
    const before = await snapshotX();
    for (const a of adultAttackers()) {
      const L = (s: string) => `${a.name} → ${s}`;
      const get = (path: string) => req("GET", path, { session: a.session });
      const post = (path: string, body?: unknown, o: ReqOpts = {}) => req("POST", path, { session: a.session, ...(body === undefined ? {} : { body }), ...o });

      await expectRefused(L("analytics/summary?learner_id=X"), await analyticsSummary.GET(get(`/api/v1/admin/analytics/summary?learner_id=${X.learners[0]}`)));
      await expectRefused(L("analytics/learning-scores?learner_id=X"), await analyticsScores.GET(get(`/api/v1/admin/analytics/learning-scores?learner_id=${X.learners[0]}`)));
      await expectRefused(L("recommendations?learner_id=X"), await recs.GET(get(`/api/v1/admin/recommendations?learner_id=${X.learners[0]}`)));
      await expectRefused(L("recommendations/{X}/dismiss"), await recDismiss.POST(post(`/api/v1/admin/recommendations/${xRecommendation}/dismiss`), params({ id: xRecommendation })));
      await expectRefused(L("devices/{X}/revoke"), await routes.revoke.POST(post(`/api/v1/devices/${X.deviceId}/revoke`), params({ deviceId: X.deviceId })));
      await expectRefused(L("imports/{X job}"), await importJob.GET(get(`/api/v1/admin/imports/${xJob}`), params({ jobId: xJob })));
      await expectRefused(L("imports/{X job}/file"), await importFile.GET(get(`/api/v1/admin/imports/${xJob}/file`), params({ jobId: xJob })));
      await expectRefused(L("imports/{X job}/review"), await importReview.POST(post(`/api/v1/admin/imports/${xJob}/review`, { decisions: [{ chapter_id: xChapter, curriculum_node_id: xNode, decision: "approve" }] }), params({ jobId: xJob })));
      // A validly signed URL for X's object is still refused for anyone outside X (SEC-007).
      const signed = new URL(await local.signedUrl("school-syllabi", xObjectKey, 60), "http://localhost:3000");
      await expectRefused(L("local-object signed URL of X"), await localObject.GET(get(`${signed.pathname}${signed.search}`)));

      // Listings scoped to the caller: whatever comes back, nothing of X.
      for (const [name, res] of [
        ["GET /devices", await routes.devices.GET(get("/api/v1/devices"))],
        ["GET /profiles", await routes.profiles.GET(get("/api/v1/profiles"))],
        ["GET analytics/summary", await analyticsSummary.GET(get("/api/v1/admin/analytics/summary"))],
        ["GET recommendations", await recs.GET(get("/api/v1/admin/recommendations"))],
        ["GET school-plans", await schoolPlans.GET(get("/api/v1/admin/school-plans"))],
        ["GET imports", await imports.GET(get("/api/v1/admin/imports"))],
      ] as const) {
        const text = await res.text();
        for (const s of xSecrets()) expect(text, L(`${name} leaked ${s}`)).not.toContain(s);
      }
    }
    // Unauthenticated signed URL (no session at all).
    const signed = new URL(await local.signedUrl("school-syllabi", xObjectKey, 60), "http://localhost:3000");
    expect((await localObject.GET(req("GET", `${signed.pathname}${signed.search}`))).status).toBe(401);
    expect(await snapshotX()).toBe(before);
  });

  it("X's own owner can use the same routes (positive control: the ids are real)", async () => {
    const owner = env.auth.sessionFor({ userId: X.ownerUserId, email: "owner-x@bnl.test" });
    expect((await analyticsSummary.GET(req("GET", `/api/v1/admin/analytics/summary?learner_id=${X.learners[0]}`, { session: owner }))).status).toBe(200);
    expect((await importJob.GET(req("GET", `/api/v1/admin/imports/${xJob}`, { session: owner }), params({ jobId: xJob }))).status).toBe(200);
    expect((await importFile.GET(req("GET", `/api/v1/admin/imports/${xJob}/file`, { session: owner }), params({ jobId: xJob }))).status).toBe(302);
    const recList = await (await recs.GET(req("GET", "/api/v1/admin/recommendations", { session: owner }))).text();
    expect(recList).toContain(xRecommendation);
  });
});

describe("content/staff routes: household adults hold no content role (ADR-0003)", () => {
  it("a household owner without staff roles is refused on every lesson/manifest/curriculum mutation and on drafts", async () => {
    const owner = env.auth.sessionFor({ userId: X.ownerUserId, email: "owner-x@bnl.test" });
    const get = (path: string) => req("GET", path, { session: owner });
    const post = (path: string, body: unknown = {}) => req("POST", path, { session: owner, body });
    const withKey = (r: Request) => { const h = new Headers(r.headers); h.set("Idempotency-Key", `a9-${randomUUID()}`); return new Request(r.url, { method: r.method, headers: h, body: r.body, duplex: "half" } as RequestInit); };
    const cases: [string, Response][] = [
      ["GET lessons", await lessons.GET(get("/api/v1/admin/lessons"))],
      ["GET draft lesson", await lesson.GET(get(`/api/v1/admin/lessons/${DRAFT_LESSON}`), params({ lessonId: DRAFT_LESSON }))],
      ["GET draft preview", await versionPreview.GET(get(`/api/v1/admin/lessons/${DRAFT_LESSON}/versions/${DRAFT_VERSION}/preview`), params({ lessonId: DRAFT_LESSON, versionId: DRAFT_VERSION }))],
      ["POST transition approve", await versionTransition.POST(post(`/api/v1/admin/lessons/${DRAFT_LESSON}/versions/${DRAFT_VERSION}/transition`, { action: "approve" }), params({ lessonId: DRAFT_LESSON, versionId: DRAFT_VERSION }))],
      ["POST publish draft", await lessonPublish.POST(withKey(post(`/api/v1/admin/lessons/${DRAFT_LESSON}/publish`, { version_id: DRAFT_VERSION, reason: "x" })), params({ lessonId: DRAFT_LESSON }))],
      ["POST unpublish ×7", await lessonUnpublish.POST(withKey(post(`/api/v1/admin/lessons/${LESSON_7}/unpublish`, { reason: "x" })), params({ lessonId: LESSON_7 }))],
      ["POST pin manifest 1", await manifestPin.POST(withKey(post("/api/v1/admin/manifests/1/pin", {})), params({ revision: "1" }))],
      ["POST curriculum review", await curriculumReview.POST(post(`/api/v1/admin/curriculum/${randomUUID()}/review`, { action: "submit" }), params({ nodeId: randomUUID() }))],
    ];
    for (const [name, res] of cases) expect([403, 404], `${name}: ${res.status}`).toContain(res.status);
  });

  it("the public catalog never serves a draft lesson id (SEC-006 IDOR)", async () => {
    const res = await catalogLesson.GET(new Request(`http://localhost:3000/api/v1/catalog/lessons/${DRAFT_LESSON}`), { params: Promise.resolve({ lessonId: DRAFT_LESSON }) });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("SYNTHETIC draft");
  });
});

describe("pairing takeover attempts", () => {
  it("A9-SEC-01 is blocked at the HTTP layer: a code claimed (at SQL level) for Y but pointing at X's TV redeems to 410", async () => {
    const codeRes = await routes.pairingCode.POST(req("POST", "/api/v1/devices/pairing-code", { csrf: false, ip: "198.51.100.77" }));
    expect(codeRes.status).toBe(201);
    const code = PairingCodeResponse.parse(await codeRes.json());
    // Simulate the RLS gap (bnl_adult may write a foreign device_id into a claim) with the superuser connection.
    // Once migration 0008 (proposal) binds device_id to household_id, even the superuser cannot write the claim:
    // the takeover is then impossible below the BFF as well, which is the fixed state.
    const claimed = await env.admin`update bnl.device_pairing_codes set household_id = ${Y.householdId}, approved_by = ${Y.ownerUserId}, approved_at = now(), device_id = ${X.deviceId}
                    where pairing_id = ${code.pairing_id}`.then(() => true, (e: { code?: string }) => {
      expect(e.code).toBe("23503");
      return false;
    });
    if (!claimed) return;
    const [beforeDev] = await env.admin`select refresh_token_hash, token_version from bnl.paired_devices where id = ${X.deviceId}`;
    const poll = await routes.token.POST(req("POST", "/api/v1/devices/token", { csrf: false, body: { pairing_id: code.pairing_id, poll_secret: code.poll_secret } }));
    expect(poll.status).toBe(410);
    const text = await poll.text();
    expect(text).not.toContain(X.deviceId);
    const [afterDev] = await env.admin`select refresh_token_hash, token_version from bnl.paired_devices where id = ${X.deviceId}`;
    expect(afterDev).toEqual(beforeDev);
  });

  it("a guessed pairing_id / poll secret never yields a token, and brute force burns the code", async () => {
    const codeRes = await routes.pairingCode.POST(req("POST", "/api/v1/devices/pairing-code", { csrf: false, ip: "198.51.100.78" }));
    const code = PairingCodeResponse.parse(await codeRes.json());
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await routes.token.POST(req("POST", "/api/v1/devices/token", { csrf: false, ip: `198.51.100.${100 + i}`, body: { pairing_id: code.pairing_id, poll_secret: `w${createHash("sha256").update(String(i)).digest("base64url")}` } }));
      statuses.push(r.status);
      expect(await r.text()).not.toMatch(/access_token/);
    }
    expect(statuses.every((s) => s >= 400)).toBe(true);
    // Even the right secret is refused once the attempt budget is exhausted.
    const real = await routes.token.POST(req("POST", "/api/v1/devices/token", { csrf: false, ip: "198.51.100.120", body: { pairing_id: code.pairing_id, poll_secret: code.poll_secret } }));
    expect([401, 403, 404, 410, 429]).toContain(real.status);
  });
});
