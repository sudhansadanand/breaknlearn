/** Route-level behaviour of the assessment endpoints with in-memory fakes (no database). */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { signDeviceAccessToken } from "@bnl/auth";
import {
  ApiError,
  FinishAssessmentResponse,
  MULTIPLICATION_LESSON_IDS,
  MULTIPLICATION_TOPIC_ID,
  StartAssessmentResponse,
  SubmitAnswerResponse,
} from "@bnl/contracts";
import { bankItemsForContent, multiplicationItemKey } from "@bnl/lesson-engine";
import { z } from "zod";
import { setAssessmentRepoForTesting } from "../../src/server/assessment";
import { setDepsForTesting } from "../../src/server/deps";
import { HH_A, HH_B, makeTestEnv, type TestEnv } from "../fakes";
import { deviceRequest } from "../learning/builders";
import { emptyAssessmentStore, fakeAssessmentRepo, rollbackRunner, type AssessmentStore, type FakeLesson } from "./fake-repo";
import { assessmentRoutes, attemptParams } from "./routes";

const DEV_A = "da000000-0000-4000-8000-0000000000a1";
const DEV_B = "db000000-0000-4000-8000-0000000000b1";
const A1 = "c1000000-0000-4000-8000-0000000000a1";
const A2 = "c1000000-0000-4000-8000-0000000000a2";
const B1 = "c1000000-0000-4000-8000-0000000000b1";
const LESSON = MULTIPLICATION_LESSON_IDS[3]!;
const VERSION = "7a000000-0000-4000-8000-000000000003";
const TINY_LESSON = MULTIPLICATION_LESSON_IDS[4]!;
const DAY = 86_400_000;

const content = (factor: number, from = 1, to = 10) => ({
  contract_version: 1,
  stable_key: `grade2.math.multiplication.table-${factor}`,
  grade: 2,
  subject_key: "math",
  topic_key: "grade2.math.multiplication",
  title: `${factor} Times Table`,
  template: "picture_groups_v1",
  config: { factor, count_from: from, count_to: to, themes: ["puppy", "farm"], seconds_per_slide: 7, quiz_question_count: 3 },
  learning_outcome_keys: ["grade2.math.multiplication"],
  rights: { type: "original_generated_content", reviewed: true },
});
const lesson = (id: string, versionId: string, factor: number, from = 1, to = 10): FakeLesson => {
  const c = content(factor, from, to);
  return { id, topicId: MULTIPLICATION_TOPIC_ID, versionId, versionNo: 1, stableKey: c.stable_key, config: c.config, live: true, bank: bankItemsForContent(c, 1)! };
};

let env: TestEnv;
let as: AssessmentStore;
let tokenA: string;
let tokenB: string;

beforeEach(async () => {
  env = makeTestEnv();
  as = emptyAssessmentStore([lesson(LESSON, VERSION, 3), lesson(TINY_LESSON, "7a000000-0000-4000-8000-000000000004", 4, 1, 2)]);
  setDepsForTesting({ ...env.deps, db: rollbackRunner(env.deps.db, as) });
  setAssessmentRepoForTesting(fakeAssessmentRepo(env.store, as));
  for (const [id, householdId] of [[DEV_A, HH_A], [DEV_B, HH_B]] as const) {
    env.store.devices.push({ id, householdId, label: "TV", tokenVersion: 1, refreshTokenHash: null, lastSeenAt: null, revokedAt: null, createdAt: env.clock.now });
  }
  for (const [id, householdId, slot] of [[A1, HH_A, 1], [A2, HH_A, 2], [B1, HH_B, 1]] as const) {
    env.store.profiles.push({ id, householdId, slot, displayName: "Kid", grade: 2, avatarId: "fox", preferences: {}, updatedAt: env.clock.now });
  }
  tokenA = (await signDeviceAccessToken(env.deps.keys.deviceToken, { deviceId: DEV_A, householdId: HH_A, tokenVersion: 1 }, env.clock.now)).token;
  tokenB = (await signDeviceAccessToken(env.deps.keys.deviceToken, { deviceId: DEV_B, householdId: HH_B, tokenVersion: 1 }, env.clock.now)).token;
  process.env.FEATURE_ASSESSMENTS = "true";
});
/** Moves the clock and re-issues the (short-lived) device tokens, like the TV's refresh would. */
async function advance(ms: number) {
  env.advance(ms);
  tokenA = (await signDeviceAccessToken(env.deps.keys.deviceToken, { deviceId: DEV_A, householdId: HH_A, tokenVersion: 1 }, env.clock.now)).token;
  tokenB = (await signDeviceAccessToken(env.deps.keys.deviceToken, { deviceId: DEV_B, householdId: HH_B, tokenVersion: 1 }, env.clock.now)).token;
}

afterEach(() => {
  setDepsForTesting(null);
  setAssessmentRepoForTesting(null);
  delete process.env.FEATURE_ASSESSMENTS;
});

const code = async (r: Response) => ApiError.parse(await r.json()).error;
const startBody = (o: Partial<{ learner_id: string; lesson_id: string; stage: string; client_attempt_id: string }> = {}) => ({
  learner_id: A1, lesson_id: LESSON, stage: "immediate", client_attempt_id: randomUUID(), ...o,
});
const start = (body: unknown, o: { bearer?: string; key?: string | null } = {}) =>
  assessmentRoutes.start.POST(deviceRequest("POST", "/api/v1/assessments/start", { bearer: o.bearer ?? tokenA, body, idempotencyKey: o.key === undefined ? null : o.key }));
const answer = (attemptId: string, body: unknown, o: { bearer?: string; key?: string | null } = {}) =>
  assessmentRoutes.answers.POST(deviceRequest("POST", `/api/v1/assessments/${attemptId}/answers`, { bearer: o.bearer ?? tokenA, body, idempotencyKey: o.key === undefined ? null : o.key }), attemptParams(attemptId));
const finish = (attemptId: string, o: { bearer?: string; key?: string | null } = {}) =>
  assessmentRoutes.finish.POST(deviceRequest("POST", `/api/v1/assessments/${attemptId}/finish`, { bearer: o.bearer ?? tokenA, idempotencyKey: o.key === undefined ? null : o.key }), attemptParams(attemptId));
const due = (learnerId: string, bearer = tokenA) =>
  assessmentRoutes.due.GET(deviceRequest("GET", `/api/v1/assessments/due?learner_id=${learnerId}`, { bearer, idempotencyKey: null }));

const DueResponse = z.object({
  learner_id: z.string(),
  timezone: z.string(),
  as_of: z.string(),
  items: z.array(z.object({ review_id: z.string(), lesson_id: z.string().nullable(), due_at: z.string(), window_ends_at: z.string(), overdue: z.boolean() }).passthrough()),
  next_due_at: z.string().nullable(),
});

const bankItem = (key: string) => as.lessons.flatMap((l) => l.bank).find((b) => b.question_version_key === key)!;
const wrongOption = (key: string) => bankItem(key).options.find((o) => o.id !== bankItem(key).correct_option_id)!.id;

async function startOk(body = startBody(), bearer = tokenA) {
  const r = await start(body, { bearer });
  expect(r.status).toBe(201);
  return StartAssessmentResponse.parse(await r.json());
}

describe("feature flag and authentication", () => {
  it("503 feature_disabled unless FEATURE_ASSESSMENTS is exactly 'true' (checked before auth)", async () => {
    for (const v of [undefined, "", "1", "TRUE", "false"]) {
      if (v === undefined) delete process.env.FEATURE_ASSESSMENTS;
      else process.env.FEATURE_ASSESSMENTS = v;
      const id = randomUUID();
      for (const r of [await start(startBody(), { bearer: "" }), await answer(id, {}), await finish(id), await due(A1)]) {
        expect(r.status, String(v)).toBe(503);
        expect((await code(r)).code).toBe("feature_disabled");
      }
    }
    expect(as.attempts).toEqual([]);
  });

  it("401 without or with an invalid device token, and for a revoked device", async () => {
    const id = randomUUID();
    for (const bearer of ["", "not-a-jwt"]) {
      for (const r of [await start(startBody(), { bearer }), await answer(id, { question_version_key: "k", selected_option_id: "a" }, { bearer }), await finish(id, { bearer }), await due(A1, bearer)]) {
        expect(r.status).toBe(401);
        expect((await code(r)).code).toBe("unauthorized");
      }
    }
    Object.assign(env.store.devices.find((d) => d.id === DEV_A)!, { revokedAt: env.clock.now });
    expect((await start(startBody())).status).toBe(401);
    expect(as.attempts).toEqual([]);
  });

  it("403 for a learner of another household (start and due); nothing is written", async () => {
    const r = await start(startBody({ learner_id: B1 }));
    expect(r.status).toBe(403);
    expect((await code(r)).code).toBe("forbidden");
    expect((await due(B1)).status).toBe(403);
    expect((await due(randomUUID())).status).toBe(403);
    expect(as.attempts).toEqual([]);
  });

  it("403 for another household's attempt id (answers and finish), indistinguishable from unknown", async () => {
    const b = await startOk(startBody({ learner_id: B1 }), tokenB);
    const q = b.questions[0]!;
    for (const id of [b.attempt_id, randomUUID(), "not-a-uuid"]) {
      expect((await answer(id, { question_version_key: q.question_version_key, selected_option_id: q.options[0]!.id })).status).toBe(403);
      expect((await finish(id)).status).toBe(403);
    }
    expect(as.responses).toEqual([]);
    expect(as.attempts.find((a) => a.id === b.attempt_id)!.finishedAt).toBeNull();
  });

  it("validation: strict bodies, bad stage, unknown lesson, wrong content type, bad learner_id", async () => {
    expect((await start({ ...startBody(), household_id: HH_B })).status).toBe(422);
    expect((await start(startBody({ stage: "final" }))).status).toBe(422);
    const unknown = await start(startBody({ lesson_id: randomUUID() }));
    expect(unknown.status).toBe(422);
    expect(JSON.stringify(await unknown.json())).toContain("lesson_unknown");
    expect((await assessmentRoutes.start.POST(deviceRequest("POST", "/api/v1/assessments/start", { bearer: tokenA, rawBody: "x", contentType: "text/plain", idempotencyKey: null }))).status).toBe(415);
    expect((await due("nope")).status).toBe(422);
    expect((await start(startBody(), { key: "bad key!" })).status).toBe(422);
  });

  it("429 after the per-device start limit", async () => {
    for (let i = 0; i < 30; i++) expect((await start(startBody({ stage: "immediate" }))).status).toBe(201);
    const r = await start(startBody());
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBeTruthy();
  });
});

describe("start: questions without answer keys, deterministic, idempotent", () => {
  it("returns 3 questions, never a correct flag or key, and the attempt is pinned to the live version", async () => {
    const r = await start(startBody());
    const text = await r.text();
    expect(text).not.toMatch(/correct/i);
    const s = StartAssessmentResponse.parse(JSON.parse(text));
    expect(s).toMatchObject({ status: "ready", stage: "immediate", lesson_version_id: VERSION });
    expect(s.questions).toHaveLength(3);
    expect(s.seed).toMatch(/^[0-9a-f]{32}$/);
    for (const q of s.questions) expect(Object.keys(q).sort()).toEqual(["options", "prompt", "question_version_key"]);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("same client_attempt_id replays the same attempt and questions; reuse for another learner/stage → 409", async () => {
    const body = startBody();
    const a = await startOk(body);
    const again = await start(body);
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(StartAssessmentResponse.parse(await again.json())).toEqual(a);
    expect(as.attempts).toHaveLength(1);
    const clash = await start({ ...body, learner_id: A2 });
    expect(clash.status).toBe(409);
    expect((await code(clash)).code).toBe("idempotency_conflict");
    // A client_attempt_id used by another household cannot be read back: plain conflict, no data.
    const other = await start({ ...startBody({ learner_id: B1 }), client_attempt_id: body.client_attempt_id }, { bearer: tokenB });
    expect(other.status).toBe(409);
    expect(JSON.stringify(await other.json())).not.toContain(a.attempt_id);
  });

  it("optional Idempotency-Key: replay returns the stored body; same key + different body → 409", async () => {
    const key = `as-${randomUUID()}`;
    const body = startBody();
    const a = await start(body, { key });
    const b = await start(body, { key });
    expect(b.headers.get("idempotent-replayed")).toBe("true");
    expect(await b.json()).toEqual(await a.json());
    const c = await start(startBody(), { key });
    expect(c.status).toBe(409);
    expect((await code(c)).code).toBe("idempotency_conflict");
    expect(as.attempts).toHaveLength(1);
  });

  it("insufficient_items: fewer than 3 eligible items → no questions and the attempt cannot collect answers", async () => {
    const s = await startOk(startBody({ lesson_id: TINY_LESSON }));
    expect(s).toMatchObject({ status: "insufficient_items", questions: [] });
    const r = await answer(s.attempt_id, { question_version_key: "grade2.math.multiplication.table-4.fact-1.v1", selected_option_id: "a" });
    expect(r.status).toBe(422);
    expect(FinishAssessmentResponse.parse(await (await finish(s.attempt_id)).json())).toMatchObject({ total_questions: 0, correct_questions: 0, next_review_due_at: null });
  });

  it("baseline only before exposure; a second finished baseline is refused", async () => {
    const b = await startOk(startBody({ stage: "baseline" }));
    for (const q of b.questions) await answer(b.attempt_id, { question_version_key: q.question_version_key, selected_option_id: q.options[0]!.id });
    expect(FinishAssessmentResponse.parse(await (await finish(b.attempt_id)).json()).next_review_due_at).toBeNull();
    const again = await start(startBody({ stage: "baseline" }));
    expect(again.status).toBe(409);
    expect((await code(again)).details).toMatchObject({ reason: "baseline_already_taken" });
    await startOk(startBody({ stage: "immediate", learner_id: A2 }));
    const late = await start(startBody({ stage: "baseline", learner_id: A2 }));
    expect((await code(late)).details).toMatchObject({ reason: "baseline_after_exposure" });
    as.progress.push({ learnerId: A1, lessonId: TINY_LESSON });
    expect((await code(await start(startBody({ stage: "baseline", lesson_id: TINY_LESSON })))).details).toMatchObject({ reason: "baseline_after_exposure" });
  });
});

describe("answers: server-authoritative scoring", () => {
  it("scores against the server key; a client is_correct is rejected; the key is revealed only after the answer", async () => {
    const s = await startOk();
    const q = s.questions[0]!;
    const forged = await answer(s.attempt_id, { question_version_key: q.question_version_key, selected_option_id: wrongOption(q.question_version_key), is_correct: true });
    expect(forged.status).toBe(422);
    expect(as.responses).toEqual([]);

    const wrong = SubmitAnswerResponse.parse(await (await answer(s.attempt_id, { question_version_key: q.question_version_key, selected_option_id: wrongOption(q.question_version_key) })).json());
    expect(wrong).toEqual({ correct: false, correct_option_id: bankItem(q.question_version_key).correct_option_id, feedback_code: "good_try", already_answered: false });
    const q2 = s.questions[1]!;
    const right = SubmitAnswerResponse.parse(await (await answer(s.attempt_id, { question_version_key: q2.question_version_key, selected_option_id: bankItem(q2.question_version_key).correct_option_id, response_ms: 1500 })).json());
    expect(right).toMatchObject({ correct: true, feedback_code: "amazing", already_answered: false });
  });

  it("duplicate answers: one answer per question; the first answer wins and is reported as already_answered", async () => {
    const s = await startOk();
    const q = s.questions[0]!;
    await answer(s.attempt_id, { question_version_key: q.question_version_key, selected_option_id: wrongOption(q.question_version_key) });
    const dup = SubmitAnswerResponse.parse(await (await answer(s.attempt_id, { question_version_key: q.question_version_key, selected_option_id: bankItem(q.question_version_key).correct_option_id })).json());
    expect(dup).toMatchObject({ correct: false, already_answered: true });
    expect(as.responses).toHaveLength(1);
  });

  it("rejects questions outside the attempt and unknown options (422) without recording", async () => {
    const s = await startOk();
    const outside = as.lessons[0]!.bank.find((b) => !s.questions.some((q) => q.question_version_key === b.question_version_key))!;
    const r1 = await answer(s.attempt_id, { question_version_key: outside.question_version_key, selected_option_id: outside.correct_option_id });
    expect(r1.status).toBe(422);
    expect(JSON.stringify(await r1.json())).toContain("question_not_in_attempt");
    const r2 = await answer(s.attempt_id, { question_version_key: s.questions[0]!.question_version_key, selected_option_id: "zz" });
    expect(r2.status).toBe(422);
    expect(JSON.stringify(await r2.json())).toContain("unknown_option");
    expect(as.responses).toEqual([]);
  });

  it("ADR-0007: lesson-engine item keys and opt-<value> ids map onto the canonical bank row", async () => {
    const s = await startOk();
    const q = s.questions[0]!;
    const m = Number(/fact-(\d+)\./.exec(q.question_version_key)![1]);
    const r = SubmitAnswerResponse.parse(await (await answer(s.attempt_id, { question_version_key: multiplicationItemKey(VERSION, 3, m), selected_option_id: `opt-${3 * m}` })).json());
    expect(r).toMatchObject({ correct: true, already_answered: false });
    expect(as.responses[0]!.questionVersionKey).toBe(q.question_version_key);
    // An engine key of another version never maps.
    expect((await answer(s.attempt_id, { question_version_key: multiplicationItemKey(randomUUID(), 3, m), selected_option_id: "a" })).status).toBe(422);
  });

  it("late answers: refused after finish (409 attempt_finished) and after the answer window (409 attempt_expired)", async () => {
    const s = await startOk();
    await finish(s.attempt_id);
    const late = await answer(s.attempt_id, { question_version_key: s.questions[0]!.question_version_key, selected_option_id: s.questions[0]!.options[0]!.id });
    expect(late.status).toBe(409);
    expect((await code(late)).details).toMatchObject({ reason: "attempt_finished" });

    const t = await startOk();
    await advance(6 * 3_600_000 + 1);
    const expired = await answer(t.attempt_id, { question_version_key: t.questions[0]!.question_version_key, selected_option_id: t.questions[0]!.options[0]!.id });
    expect(expired.status).toBe(409);
    expect((await code(expired)).details).toMatchObject({ reason: "attempt_expired" });
    expect(as.responses).toEqual([]);
  });

  it("optional Idempotency-Key on answers replays the original response", async () => {
    const s = await startOk();
    const q = s.questions[0]!;
    const key = `ans-${randomUUID()}`;
    const body = { question_version_key: q.question_version_key, selected_option_id: bankItem(q.question_version_key).correct_option_id };
    const a = SubmitAnswerResponse.parse(await (await answer(s.attempt_id, body, { key })).json());
    const b = await answer(s.attempt_id, body, { key });
    expect(b.headers.get("idempotent-replayed")).toBe("true");
    expect(SubmitAnswerResponse.parse(await b.json())).toEqual(a);
    expect(as.scoreCalls).toHaveLength(1);
  });
});

describe("finish, review scheduling and what's due", () => {
  async function answerAll(s: z.infer<typeof StartAssessmentResponse>, correctCount: number) {
    for (const [i, q] of s.questions.entries()) {
      const opt = i < correctCount ? bankItem(q.question_version_key).correct_option_id : wrongOption(q.question_version_key);
      expect((await answer(s.attempt_id, { question_version_key: q.question_version_key, selected_option_id: opt })).status).toBe(200);
    }
  }

  it("totals come from server scores; immediate schedules a review at local midnight +3 days (Asia/Kolkata); finish is idempotent", async () => {
    // 2026-11-14T10:00Z = 15:30 IST → due 2026-11-17 00:00 IST = 2026-11-16T18:30Z.
    const s = await startOk();
    await answerAll(s, 2);
    const f = await finish(s.attempt_id);
    expect(f.status).toBe(200);
    const body = FinishAssessmentResponse.parse(await f.json());
    expect(body).toEqual({ attempt_id: s.attempt_id, total_questions: 3, correct_questions: 2, next_review_due_at: "2026-11-16T18:30:00.000Z" });
    const again = await finish(s.attempt_id);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(FinishAssessmentResponse.parse(await again.json())).toEqual(body);
    expect(as.reviews).toHaveLength(1);

    // A repeat quiz (another world) keeps the one open review.
    const s2 = await startOk();
    await answerAll(s2, 3);
    await advance(DAY);
    expect(FinishAssessmentResponse.parse(await (await finish(s2.attempt_id)).json()).next_review_due_at).toBe("2026-11-16T18:30:00.000Z");
    expect(as.reviews).toHaveLength(1);
  });

  it("household timezone is honoured", async () => {
    as.timezones[HH_A] = "America/New_York";
    const s = await startOk();
    await answerAll(s, 1);
    // 2026-11-14T10:00Z = 05:00 EST on the 14th → 2026-11-17 00:00 EST = 05:00Z.
    expect(FinishAssessmentResponse.parse(await (await finish(s.attempt_id)).json()).next_review_due_at).toBe("2026-11-17T05:00:00.000Z");
  });

  it("an attempt finished without answers schedules nothing (absence is not a zero)", async () => {
    const s = await startOk();
    expect(FinishAssessmentResponse.parse(await (await finish(s.attempt_id)).json())).toMatchObject({ total_questions: 3, correct_questions: 0, next_review_due_at: null });
    expect(as.reviews).toEqual([]);
  });

  it("delayed: refused until due, listed when due, uses fresh questions, completes the review and climbs the ladder", async () => {
    const imm = await startOk();
    await answerAll(imm, 3);
    await finish(imm.attempt_id);

    const early = await start(startBody({ stage: "delayed" }));
    expect(early.status).toBe(409);
    expect((await code(early)).details).toMatchObject({ reason: "review_not_due", next_due_at: "2026-11-16T18:30:00.000Z" });
    const none = DueResponse.parse(await (await due(A1)).json());
    expect(none).toMatchObject({ items: [], next_due_at: "2026-11-16T18:30:00.000Z", timezone: "Asia/Kolkata" });

    await advance(3 * DAY);
    const list = DueResponse.parse(await (await due(A1)).json());
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ lesson_id: LESSON, due_at: "2026-11-16T18:30:00.000Z", window_ends_at: "2026-11-21T18:30:00.000Z", overdue: false });
    expect(DueResponse.parse(await (await due(A2)).json()).items).toEqual([]);

    const d = await startOk(startBody({ stage: "delayed" }));
    expect(d.questions).toHaveLength(3);
    const seen = new Set(imm.questions.map((q) => q.question_version_key));
    for (const q of d.questions) expect(seen.has(q.question_version_key)).toBe(false);
    await answerAll(d, 3);
    const fin = FinishAssessmentResponse.parse(await (await finish(d.attempt_id)).json());
    // Passed → next rung (+7 local days from 2026-11-17 10:00Z = 15:30 IST) → 2026-11-24 00:00 IST.
    expect(fin.next_review_due_at).toBe("2026-11-23T18:30:00.000Z");
    expect(as.reviews.map((r) => r.status).sort()).toEqual(["completed", "due"]);
  });

  it("overdue reviews stay listed (gentle, optional) with overdue=true", async () => {
    const imm = await startOk();
    await answerAll(imm, 1);
    await finish(imm.attempt_id);
    await advance(30 * DAY);
    const list = DueResponse.parse(await (await due(A1)).json());
    expect(list.items[0]).toMatchObject({ overdue: true });
  });
});
