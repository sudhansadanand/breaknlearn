/**
 * M08 assessments on the real schema (RLS enforced through the bnl_app login): server-authoritative scoring,
 * duplicate answers, cross-tenant denial, review scheduling, ELS evidence (absence ≠ zero) and the 0006 guards.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { signDeviceAccessToken } from "@bnl/auth";
import { computeEls } from "@bnl/assessment";
import { ApiError, FinishAssessmentResponse, MULTIPLICATION_LESSON_IDS, StartAssessmentResponse, SubmitAnswerResponse } from "@bnl/contracts";
import * as catalogLesson from "../../src/app/api/v1/catalog/lessons/[lessonId]/route";
import { setAssessmentRepoForTesting } from "../../src/server/assessment";
import { elsInputsForLearner } from "../../src/server/assessment/evidence";
import { setDepsForTesting } from "../../src/server/deps";
import { assessmentRoutes, attemptParams } from "../assessment/routes";
import { deviceRequest } from "../learning/builders";
import { freshHousehold, openDbEnv, revoke, type DbEnv, type Household } from "../learning/db-env";

const LESSON_7 = MULTIPLICATION_LESSON_IDS[7]!;
const DAY = 86_400_000;
let env: DbEnv;
let hh: Household;
let other: Household;
let clock: Date;

beforeAll(() => {
  env = openDbEnv();
  setAssessmentRepoForTesting(null);
});
afterAll(async () => {
  delete process.env.FEATURE_ASSESSMENTS;
  await env.close();
});
beforeEach(async () => {
  process.env.FEATURE_ASSESSMENTS = "true";
  clock = new Date();
  setDepsForTesting({ ...env.deps, now: () => clock });
  hh = await freshHousehold(env);
  other = await freshHousehold(env);
});

/** Moves the handler clock and returns a token valid at that time. */
async function at(h: Household, when: Date): Promise<string> {
  clock = when;
  return (await signDeviceAccessToken(env.deps.keys.deviceToken, { deviceId: h.deviceId, householdId: h.householdId, tokenVersion: 1 }, when)).token;
}

const startReq = (token: string, body: Record<string, unknown>) =>
  assessmentRoutes.start.POST(deviceRequest("POST", "/api/v1/assessments/start", { bearer: token, body, idempotencyKey: null }));
const answerReq = (token: string, attemptId: string, body: unknown) =>
  assessmentRoutes.answers.POST(deviceRequest("POST", `/api/v1/assessments/${attemptId}/answers`, { bearer: token, body, idempotencyKey: null }), attemptParams(attemptId));
const finishReq = (token: string, attemptId: string) =>
  assessmentRoutes.finish.POST(deviceRequest("POST", `/api/v1/assessments/${attemptId}/finish`, { bearer: token, idempotencyKey: null }), attemptParams(attemptId));
const dueReq = (token: string, learnerId: string) =>
  assessmentRoutes.due.GET(deviceRequest("GET", `/api/v1/assessments/due?learner_id=${learnerId}`, { bearer: token, idempotencyKey: null }));

async function start(token: string, o: { learner?: string; stage?: string; lesson?: string } = {}) {
  const res = await startReq(token, { learner_id: o.learner ?? hh.learners[0], lesson_id: o.lesson ?? LESSON_7, stage: o.stage ?? "immediate", client_attempt_id: randomUUID() });
  const text = await res.text();
  return { status: res.status, text, body: res.status === 201 ? StartAssessmentResponse.parse(JSON.parse(text)) : null };
}

const answerKey = async (key: string) =>
  (await env.admin<{ correct_option_id: string; options: { id: string }[] }[]>`select correct_option_id, options from bnl.quiz_items where question_version_key = ${key}`)[0]!;
async function answerAll(token: string, s: { attempt_id: string; questions: { question_version_key: string }[] }, correctCount: number) {
  for (const [i, q] of s.questions.entries()) {
    const k = await answerKey(q.question_version_key);
    const opt = i < correctCount ? k.correct_option_id : k.options.find((o) => o.id !== k.correct_option_id)!.id;
    expect((await answerReq(token, s.attempt_id, { question_version_key: q.question_version_key, selected_option_id: opt })).status).toBe(200);
  }
}

describe("assessments (real DB)", () => {
  it("catalog and start payloads never expose an answer key; correctness is computed by the server", async () => {
    const cat = await catalogLesson.GET(new Request(`http://localhost:3000/api/v1/catalog/lessons/${LESSON_7}`), { params: Promise.resolve({ lessonId: LESSON_7 }) });
    expect(cat.status).toBe(200);
    expect(await cat.text()).not.toMatch(/correct/i);

    const s = await start(hh.token);
    expect(s.status).toBe(201);
    expect(s.text).not.toMatch(/correct/i);
    expect(s.body!.questions).toHaveLength(3);
    const [row] = await env.admin<{ question_keys: string[]; seed: string; lesson_version_id: string }[]>`
      select question_keys, seed, lesson_version_id from bnl.assessment_attempts where id = ${s.body!.attempt_id}`;
    expect(row!.question_keys).toEqual(s.body!.questions.map((q) => q.question_version_key));
    expect(row!.seed).toBe(s.body!.seed);

    const q = s.body!.questions[0]!;
    const k = await answerKey(q.question_version_key);
    const wrong = k.options.find((o) => o.id !== k.correct_option_id)!.id;
    const forged = await answerReq(hh.token, s.body!.attempt_id, { question_version_key: q.question_version_key, selected_option_id: wrong, is_correct: true });
    expect(forged.status).toBe(422);
    const r = SubmitAnswerResponse.parse(await (await answerReq(hh.token, s.body!.attempt_id, { question_version_key: q.question_version_key, selected_option_id: wrong })).json());
    expect(r).toEqual({ correct: false, correct_option_id: k.correct_option_id, feedback_code: "good_try", already_answered: false });
    const stored = await env.admin<{ correct: boolean; selected_option_id: string }[]>`select correct, selected_option_id from bnl.question_responses where attempt_id = ${s.body!.attempt_id}`;
    expect(stored).toEqual([{ correct: false, selected_option_id: wrong }]);
  });

  it("0006 guard: totals are computed from scored responses; a device cannot forge counts, identity or responses", async () => {
    const s = (await start(hh.token)).body!;
    await answerAll(hh.token, s, 2);
    const device = { kind: "device" as const, householdId: hh.householdId, deviceId: hh.deviceId };
    // Unfinished: supplied totals are ignored.
    await env.runner(device, (sql) => sql`update bnl.assessment_attempts set correct_questions = 3, total_questions = 3 where id = ${s.attempt_id}`);
    expect((await env.admin`select correct_questions::int as c from bnl.assessment_attempts where id = ${s.attempt_id}`)[0]).toEqual({ c: 0 });
    await expect(env.runner(device, (sql) => sql`update bnl.assessment_attempts set question_keys = '[]'::jsonb where id = ${s.attempt_id}`)).rejects.toMatchObject({ code: "55000" });
    await expect(env.runner(device, (sql) => sql`
      insert into bnl.question_responses (household_id, attempt_id, learner_id, question_version_key, selected_option_id, correct)
      values (${hh.householdId}, ${s.attempt_id}, ${hh.learners[0]}, ${s.questions[2]!.question_version_key}, 'a', true)`)).rejects.toMatchObject({ code: "42501" });

    const f = FinishAssessmentResponse.parse(await (await finishReq(hh.token, s.attempt_id)).json());
    expect(f).toMatchObject({ total_questions: 3, correct_questions: 2 });
    await expect(env.runner(device, (sql) => sql`update bnl.assessment_attempts set correct_questions = 3 where id = ${s.attempt_id}`)).rejects.toMatchObject({ code: "55000" });
    // Finished attempts take no more responses, even through score_answer.
    const s2 = (await start(hh.token)).body!;
    expect((await finishReq(hh.token, s2.attempt_id)).status).toBe(200);
    await expect(env.runner(device, (sql) => sql`select * from bnl.score_answer(${s2.attempt_id}, ${s2.questions[0]!.question_version_key}, 'a')`)).rejects.toMatchObject({ code: "55000" });
    // An attempt with no presented questions accepts no answers at all (closes the empty question_keys gap).
    const [v] = await env.admin<{ id: string }[]>`select lesson_version_id as id from bnl.publication_records where lesson_id = ${LESSON_7} and unpublished_at is null`;
    const [empty] = await env.runner(device, (sql) => sql<{ id: string }[]>`
      insert into bnl.assessment_attempts (household_id, learner_id, device_id, lesson_id, lesson_version_id, client_attempt_id, stage, seed)
      values (${hh.householdId}, ${hh.learners[0]}, ${hh.deviceId}, ${LESSON_7}, ${v!.id}, gen_random_uuid(), 'immediate', 's') returning id`);
    await expect(env.runner(device, (sql) => sql`select * from bnl.score_answer(${empty!.id}, 'grade2.math.multiplication.table-7.fact-1.v1', 'a')`)).rejects.toMatchObject({ code: "22023" });
  });

  it("duplicate answers (sequential and concurrent) store one response; the first answer wins", async () => {
    const s = (await start(hh.token)).body!;
    const q = s.questions[0]!;
    const k = await answerKey(q.question_version_key);
    const wrong = k.options.find((o) => o.id !== k.correct_option_id)!.id;
    const results = await Promise.all([
      answerReq(hh.token, s.attempt_id, { question_version_key: q.question_version_key, selected_option_id: wrong }),
      answerReq(hh.token, s.attempt_id, { question_version_key: q.question_version_key, selected_option_id: wrong }),
    ]);
    const bodies = await Promise.all(results.map(async (r) => SubmitAnswerResponse.parse(await r.json())));
    expect(bodies.map((b) => b.already_answered).sort()).toEqual([false, true]);
    const again = SubmitAnswerResponse.parse(await (await answerReq(hh.token, s.attempt_id, { question_version_key: q.question_version_key, selected_option_id: k.correct_option_id })).json());
    expect(again).toMatchObject({ correct: false, already_answered: true });
    expect(await env.admin`select 1 from bnl.question_responses where attempt_id = ${s.attempt_id}`).toHaveLength(1);
  });

  it("cross-tenant denial: another household can neither start for, answer, finish nor list our learner", async () => {
    const s = (await start(hh.token)).body!;
    const q = s.questions[0]!;
    const startOther = await startReq(other.token, { learner_id: hh.learners[0], lesson_id: LESSON_7, stage: "immediate", client_attempt_id: randomUUID() });
    expect(startOther.status).toBe(403);
    const ans = await answerReq(other.token, s.attempt_id, { question_version_key: q.question_version_key, selected_option_id: "a" });
    expect(ans.status).toBe(403);
    expect(ApiError.parse(await ans.json()).error.code).toBe("forbidden");
    expect((await finishReq(other.token, s.attempt_id)).status).toBe(403);
    expect((await dueReq(other.token, hh.learners[0])).status).toBe(403);
    const seen = await env.runner({ kind: "device", householdId: other.householdId, deviceId: other.deviceId }, (sql) => sql`
      select (select count(*) from bnl.assessment_attempts where household_id = ${hh.householdId})::int as a,
             (select count(*) from bnl.review_schedule where household_id = ${hh.householdId})::int as r`);
    expect(seen[0]).toEqual({ a: 0, r: 0 });
    expect(await env.admin`select 1 from bnl.question_responses where attempt_id = ${s.attempt_id}`).toHaveLength(0);
    expect((await env.admin`select finished_at from bnl.assessment_attempts where id = ${s.attempt_id}`)[0]).toEqual({ finished_at: null });
    // A revoked device is refused at once.
    await revoke(env, hh.deviceId);
    expect((await startReq(hh.token, { learner_id: hh.learners[0], lesson_id: LESSON_7, stage: "immediate", client_attempt_id: randomUUID() })).status).toBe(401);
  });

  it("baseline → immediate → delayed: different questions (TEL-006), review due +3 local days, ELS evidence; absence ≠ zero", async () => {
    const t0 = new Date("2026-11-14T10:00:00Z");
    let token = await at(hh, t0);
    const base = (await start(token, { stage: "baseline" })).body!;
    await answerAll(token, base, 1);
    await finishReq(token, base.attempt_id);
    token = await at(hh, new Date(t0.getTime() + 3_600_000));
    const imm = (await start(token)).body!;
    await answerAll(token, imm, 3);
    const fin = FinishAssessmentResponse.parse(await (await finishReq(token, imm.attempt_id)).json());
    expect(fin.next_review_due_at).toBe("2026-11-16T18:30:00.000Z"); // 2026-11-17 00:00 Asia/Kolkata
    const [review] = await env.admin<{ due_at: Date; status: string; topic_id: string | null }[]>`
      select due_at, status, topic_id from bnl.review_schedule where learner_id = ${hh.learners[0]}`;
    expect(review).toMatchObject({ status: "due" });
    expect(review!.topic_id).not.toBeNull();

    // Before the delayed check: retention is insufficient evidence, R is null and the score is provisional.
    const before = await env.runner({ kind: "job" }, (sql) => elsInputsForLearner(sql, hh.learners[0], clock));
    expect(before).toHaveLength(1);
    expect(before[0]!.evidence.retention).toEqual({ status: "insufficient_evidence", reason: "no_attempt", questions: 0 });
    expect(before[0]!.input.baseline).toMatchObject({ total: 3, correct: 1 });
    const scoreBefore = computeEls(before[0]!.input);
    expect(scoreBefore.components.R).toBeNull();
    expect(scoreBefore.status).toBe("provisional");

    const early = await startReq(token, { learner_id: hh.learners[0], lesson_id: LESSON_7, stage: "delayed", client_attempt_id: randomUUID() });
    expect(early.status).toBe(409);

    token = await at(hh, new Date(t0.getTime() + 3 * DAY));
    const due = (await (await dueReq(token, hh.learners[0])).json()) as { items: { lesson_id: string }[]; timezone: string };
    expect(due).toMatchObject({ timezone: "Asia/Kolkata", items: [{ lesson_id: LESSON_7 }] });
    const del = (await start(token, { stage: "delayed" })).body!;
    const used = new Set([...base.questions, ...imm.questions].map((q) => q.question_version_key));
    expect(del.questions).toHaveLength(3);
    for (const q of del.questions) expect(used.has(q.question_version_key)).toBe(false);
    const outcomes = await env.admin<{ outcome_key: string }[]>`
      select distinct outcome_key from bnl.quiz_items where question_version_key = any(${env.admin.array([...used, ...del.questions.map((q) => q.question_version_key)])})`;
    expect(outcomes).toHaveLength(1);
    await answerAll(token, del, 2);
    const delFin = FinishAssessmentResponse.parse(await (await finishReq(token, del.attempt_id)).json());
    expect(delFin).toMatchObject({ total_questions: 3, correct_questions: 2 });
    expect(delFin.next_review_due_at).toBe("2026-11-19T18:30:00.000Z"); // missed the 80% pass → first rung again (+3)
    expect((await env.admin`select status from bnl.review_schedule where learner_id = ${hh.learners[0]} order by due_at`).map((r) => r.status)).toEqual(["completed", "due"]);

    const after = await env.runner({ kind: "job" }, (sql) => elsInputsForLearner(sql, hh.learners[0], clock));
    expect(after[0]!.evidence.retention.status).toBe("observed");
    expect(after[0]!.input.delayed).toMatchObject({ total: 3, correct: 2 });
    const s = computeEls(after[0]!.input);
    expect(s.components.R).toBeCloseTo(66.67, 2);
    expect(s.components.M).toBe(100);
    expect(s.questions_count).toBe(9);
  });
});
