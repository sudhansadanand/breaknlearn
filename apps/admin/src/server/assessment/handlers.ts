/**
 * Assessments (M08): POST /assessments/start, POST /assessments/{id}/answers, POST /assessments/{id}/finish,
 * GET /assessments/due. Paired device only (household from the verified token, RLS-scoped transaction).
 *
 * Server authority (TEL-005): the device sends only `selected_option_id`; correctness comes from
 * `bnl.score_answer` against `bnl.quiz_items`, which no request role can read. Start never returns an
 * answer key; an answer's key is returned only after that answer is recorded.
 */
import { HttpError } from "@bnl/auth";
import {
  ANSWER_WINDOW_MS,
  attemptSeed,
  dueReviews,
  feedbackFor,
  itemsPerStage,
  learnerSeed,
  nextReview,
  passedDelayedStreak,
  safeTimezone,
  seededOptionOrder,
  selectQuestions,
  toBankItemKey,
  toBankOptionId,
  type PriorAttempt,
} from "@bnl/assessment";
import { FinishAssessmentResponse, StartAssessmentRequest, StartAssessmentResponse, SubmitAnswerRequest, SubmitAnswerResponse, Uuid, type DeviceTokenClaims } from "@bnl/contracts";
import type { z } from "zod";
import { verifyDeviceBearer, withDevice } from "../authn";
import type { Sql } from "../db-port";
import { json, validationFailed, type Ctx } from "../http";
import { readBoundedJson } from "../learning/common";
import {
  REPLAY_HEADER,
  enforceAssessmentRateLimit,
  mapDbError,
  maybeIdempotent,
  optionalIdempotencyKey,
  requireAssessmentsEnabled,
  type Outcome,
} from "./common";
import { assessmentRepo, type AssessmentRepo, type AttemptRow } from "./index";

const BODY_MAX_BYTES = 4 * 1024;

type StartBody = z.infer<typeof StartAssessmentResponse>;
type AnswerBody = z.infer<typeof SubmitAnswerResponse>;
type FinishBody = z.infer<typeof FinishAssessmentResponse>;

const forbiddenLearner = () => new HttpError(403, "forbidden", "Learner is not in your household");
/** Unknown and other households' attempts are indistinguishable (no existence oracle). */
const forbiddenAttempt = () => new HttpError(403, "forbidden", "Attempt is not available");
const conflict = (reason: string, message: string, extra: Record<string, unknown> = {}) => new HttpError(409, "conflict", message, { reason, ...extra });

function reply(c: Ctx, out: Outcome<unknown>): Response {
  return json(c, out.body, out.status, out.replayed ? { [REPLAY_HEADER]: "true" } : {});
}

async function assertLearner(sql: Sql, repo: AssessmentRepo, claims: DeviceTokenClaims, learnerId: string): Promise<void> {
  if (!(await repo.learnerInHousehold(sql, claims.hid, learnerId))) throw forbiddenLearner();
}

function attemptIdParam(raw: string): string {
  const id = Uuid.safeParse(raw);
  if (!id.success) throw forbiddenAttempt();
  return id.data;
}

// ---------------------------------------------------------------------------
// POST /assessments/start
// ---------------------------------------------------------------------------

/** The stored attempt as a start response (questions and option order rebuilt from the stored seed). */
async function startBodyFor(sql: Sql, repo: AssessmentRepo, a: AttemptRow): Promise<StartBody> {
  const items = await repo.publicItems(sql, a.lessonVersionId);
  const byKey = new Map(items.map((i) => [i.question_version_key, i]));
  const questions = a.questionKeys.flatMap((k) => {
    const item = byKey.get(k);
    return item ? [{ question_version_key: item.question_version_key, prompt: item.prompt, options: seededOptionOrder(item.options, a.seed, item.question_version_key) }] : [];
  });
  return StartAssessmentResponse.parse({
    attempt_id: a.id,
    stage: a.stage,
    lesson_version_id: a.lessonVersionId,
    seed: a.seed,
    questions,
    status: a.questionKeys.length > 0 ? "ready" : "insufficient_items",
  });
}

export async function startAssessmentHandler(req: Request, c: Ctx): Promise<Response> {
  requireAssessmentsEnabled();
  const claims = await verifyDeviceBearer(req, c);
  const key = optionalIdempotencyKey(req);
  await enforceAssessmentRateLimit(c, "assessmentStartByDevice", claims.sub);
  const raw = await readBoundedJson(req, BODY_MAX_BYTES);
  const parsed = StartAssessmentRequest.strict().safeParse(raw);
  if (!parsed.success) throw validationFailed(parsed.error.issues);
  const body = parsed.data;
  const repo = assessmentRepo();
  const now = c.deps.now();

  const out = await withDevice(c, claims, (sql) =>
    maybeIdempotent(sql, repo, { scope: "assessment.start", key, ownerId: claims.sub, householdId: claims.hid, request: raw, now }, async () => {
      await assertLearner(sql, repo, claims, body.learner_id);

      // Natural idempotency: the same client_attempt_id returns the same attempt and questions.
      const existing = await repo.attemptByClientId(sql, body.client_attempt_id);
      if (existing) {
        if (existing.learnerId !== body.learner_id || existing.lessonId !== body.lesson_id || existing.stage !== body.stage) {
          throw new HttpError(409, "idempotency_conflict", "client_attempt_id was already used for a different attempt");
        }
        return { status: 201, body: await startBodyFor(sql, repo, existing), replayed: true };
      }

      const lesson = await repo.liveLesson(sql, body.lesson_id);
      if (!lesson) throw validationFailed([{ path: ["lesson_id"], code: "lesson_unknown" }], "Unknown lesson");
      const prior = await repo.learnerLessonAttempts(sql, body.learner_id, body.lesson_id);
      await assertStageAllowed(sql, repo, body.stage, body.learner_id, body.lesson_id, prior, now);

      const seed = attemptSeed({ clientAttemptId: body.client_attempt_id, lessonVersionId: lesson.versionId, stage: body.stage });
      const selection = selectQuestions({
        items: await repo.publicItems(sql, lesson.versionId),
        stage: body.stage,
        count: itemsPerStage(lesson.config.quiz_question_count),
        seed,
        learnerSeed: learnerSeed(body.learner_id, lesson.versionId),
        prior: prior.map((a): PriorAttempt => ({ stage: a.stage, questionKeys: a.questionKeys })),
      });
      const inserted = await repo.insertAttempt(sql, {
        householdId: claims.hid,
        learnerId: body.learner_id,
        deviceId: claims.sub,
        lessonId: body.lesson_id,
        lessonVersionId: lesson.versionId,
        clientAttemptId: body.client_attempt_id,
        stage: body.stage,
        seed,
        questionKeys: selection.questions.map((q) => q.question_version_key),
        startedAt: now,
        // Nothing to answer: the attempt is closed at once so it can never collect answers.
        finishedAt: selection.status === "ready" ? null : now,
      });
      // client_attempt_id is unique across households; one we cannot see is a conflict, never a lookup.
      if (!inserted) throw conflict("client_attempt_id_taken", "client_attempt_id is already in use");
      const res: StartBody = StartAssessmentResponse.parse({
        attempt_id: inserted.id,
        stage: inserted.stage,
        lesson_version_id: inserted.lessonVersionId,
        seed,
        questions: selection.questions,
        status: selection.status,
      });
      return { status: 201, body: res, replayed: false };
    }),
  );
  return reply(c, out);
}

async function assertStageAllowed(sql: Sql, repo: AssessmentRepo, stage: string, learnerId: string, lessonId: string, prior: readonly AttemptRow[], now: Date): Promise<void> {
  if (stage === "baseline") {
    // A baseline is a pre-test: refused once the learner has met the lesson (spec §7 "baseline before exposure").
    if (prior.some((a) => a.stage !== "baseline") || (await repo.hasProgress(sql, learnerId, lessonId))) {
      throw conflict("baseline_after_exposure", "A baseline check is only offered before the lesson");
    }
    if (prior.some((a) => a.stage === "baseline" && a.finishedAt !== null && a.questionKeys.length > 0)) {
      throw conflict("baseline_already_taken", "The baseline check for this lesson was already taken");
    }
  }
  if (stage === "delayed") {
    const reviews = (await repo.reviewsForLearner(sql, learnerId, lessonId)).filter((r) => r.status === "due");
    if (!reviews.some((r) => r.dueAt.getTime() <= now.getTime())) {
      const next = reviews.map((r) => r.dueAt).sort((a, b) => a.getTime() - b.getTime())[0];
      throw conflict("review_not_due", "No delayed review is due for this lesson yet", { next_due_at: next ? next.toISOString() : null });
    }
  }
}

// ---------------------------------------------------------------------------
// POST /assessments/{attemptId}/answers
// ---------------------------------------------------------------------------

export async function submitAnswerHandler(req: Request, c: Ctx, attemptIdRaw: string): Promise<Response> {
  requireAssessmentsEnabled();
  const claims = await verifyDeviceBearer(req, c);
  const key = optionalIdempotencyKey(req);
  await enforceAssessmentRateLimit(c, "assessmentAnswerByDevice", claims.sub);
  const attemptId = attemptIdParam(attemptIdRaw);
  const raw = await readBoundedJson(req, BODY_MAX_BYTES);
  // .strict(): an `is_correct` (or any other extra field) is rejected, never trusted (TEL-005).
  const parsed = SubmitAnswerRequest.safeParse(raw);
  if (!parsed.success) throw validationFailed(parsed.error.issues);
  const body = parsed.data;
  const repo = assessmentRepo();
  const now = c.deps.now();

  const out = await withDevice(c, claims, (sql) =>
    maybeIdempotent(sql, repo, { scope: "assessment.answer", key, ownerId: claims.sub, householdId: claims.hid, request: { attempt_id: attemptId, ...body }, now }, async () => {
      const attempt = await repo.attemptForUpdate(sql, attemptId);
      if (!attempt) throw forbiddenAttempt();

      // ADR-0007: lesson-engine keys/options are mapped onto the canonical bank row of the same version.
      const version = await repo.versionRef(sql, attempt.lessonVersionId);
      const factor = typeof version?.config.factor === "number" ? version.config.factor : NaN;
      const questionKey = version ? toBankItemKey(body.question_version_key, { lessonVersionId: version.versionId, stableKey: version.stableKey, versionNo: version.versionNo, factor }) : body.question_version_key;
      if (questionKey === null || !attempt.questionKeys.includes(questionKey)) {
        throw validationFailed([{ path: ["question_version_key"], code: "question_not_in_attempt" }], "Question is not part of this attempt");
      }

      const prior = (await repo.responsesFor(sql, [attempt.id])).find((r) => r.questionVersionKey === questionKey);
      let selected = body.selected_option_id;
      if (!prior) {
        // Late answers: never after finish, never after the answer window (the first answer is the evidence).
        if (attempt.finishedAt !== null) throw conflict("attempt_finished", "Attempt is already finished");
        if (now.getTime() - attempt.startedAt.getTime() > ANSWER_WINDOW_MS) throw conflict("attempt_expired", "Attempt is no longer accepting answers");
        const item = (await repo.publicItems(sql, attempt.lessonVersionId)).find((i) => i.question_version_key === questionKey);
        const mapped = item ? toBankOptionId(selected, item.options) : null;
        if (!item || mapped === null || !item.options.some((o) => o.id === mapped)) {
          throw validationFailed([{ path: ["selected_option_id"], code: "unknown_option" }], "Unknown option");
        }
        selected = mapped;
      }
      // Duplicates: score_answer returns the FIRST recorded answer (already_answered = true), whatever is sent now.
      const scored = await repo
        .scoreAnswer(sql, { attemptId: attempt.id, questionVersionKey: questionKey, selectedOptionId: selected, responseMs: body.response_ms ?? null })
        .catch(mapDbError);
      const res: AnswerBody = SubmitAnswerResponse.parse({
        correct: scored.correct,
        correct_option_id: scored.correctOptionId,
        feedback_code: feedbackFor(scored.correct),
        already_answered: scored.alreadyAnswered,
      });
      return { status: 200, body: res, replayed: false };
    }),
  );
  return reply(c, out);
}

// ---------------------------------------------------------------------------
// POST /assessments/{attemptId}/finish
// ---------------------------------------------------------------------------

export async function finishAssessmentHandler(req: Request, c: Ctx, attemptIdRaw: string): Promise<Response> {
  requireAssessmentsEnabled();
  const claims = await verifyDeviceBearer(req, c);
  const key = optionalIdempotencyKey(req);
  await enforceAssessmentRateLimit(c, "assessmentFinishByDevice", claims.sub);
  const attemptId = attemptIdParam(attemptIdRaw);
  const repo = assessmentRepo();
  const now = c.deps.now();

  const out = await withDevice(c, claims, (sql) =>
    maybeIdempotent(sql, repo, { scope: "assessment.finish", key, ownerId: claims.sub, householdId: claims.hid, request: { attempt_id: attemptId }, now }, async () => {
      const attempt = await repo.attemptForUpdate(sql, attemptId);
      if (!attempt) throw forbiddenAttempt();
      if (attempt.finishedAt !== null) {
        // Replay: same totals; the review it scheduled (or the one already open for the lesson).
        return { status: 200, body: await finishBody(sql, repo, attempt), replayed: true };
      }
      const finished = await repo.finishAttempt(sql, attempt.id, now).catch(mapDbError);
      await scheduleAfterFinish(sql, repo, claims, finished, now);
      return { status: 200, body: await finishBody(sql, repo, finished), replayed: false };
    }),
  );
  return reply(c, out);
}

async function finishBody(sql: Sql, repo: AssessmentRepo, a: AttemptRow): Promise<FinishBody> {
  const reviews = await repo.reviewsForLearner(sql, a.learnerId, a.lessonId);
  const own = reviews.find((r) => r.sourceAttemptId === a.id);
  const open = reviews.find((r) => r.status === "due");
  const next = a.stage === "baseline" ? null : (own ?? open ?? null);
  return FinishAssessmentResponse.parse({
    attempt_id: a.id,
    total_questions: a.totalQuestions,
    correct_questions: a.correctQuestions,
    next_review_due_at: next ? next.dueAt.toISOString() : null,
  });
}

async function scheduleAfterFinish(sql: Sql, repo: AssessmentRepo, claims: DeviceTokenClaims, a: AttemptRow, now: Date): Promise<void> {
  if (a.stage === "baseline") return;
  const responses = (await repo.responsesFor(sql, [a.id])).filter((r) => a.questionKeys.includes(r.questionVersionKey));
  const answered = responses.length;
  if (answered === 0) return; // nothing measured: keep any open review as it is
  const correct = responses.filter((r) => r.correct).length;
  const tz = safeTimezone(await repo.householdTimezone(sql, claims.hid));
  const lesson = await repo.liveLesson(sql, a.lessonId);
  const topicId = lesson?.topicId ?? null;

  let streak = 0;
  if (a.stage === "delayed") {
    await repo.completeOpenReviews(sql, a.learnerId, a.lessonId);
    const earlier = (await repo.learnerLessonAttempts(sql, a.learnerId, a.lessonId)).filter((x) => x.stage === "delayed" && x.finishedAt !== null && x.id !== a.id);
    const answers = await repo.responsesFor(sql, earlier.map((x) => x.id));
    streak = passedDelayedStreak(
      earlier.map((x) => {
        const mine = answers.filter((r) => r.attemptId === x.id && x.questionKeys.includes(r.questionVersionKey));
        return { finishedAt: x.finishedAt as Date, answered: mine.length, correct: mine.filter((r) => r.correct).length };
      }),
    );
  }
  const plan = nextReview({ stage: a.stage, finishedAt: now, answered, correct, passedDelayedStreak: streak, timezone: tz });
  if (!plan) return;
  // One open review per learner+lesson: repeated immediate quizzes keep the earliest due date.
  await repo.insertReview(sql, { householdId: claims.hid, learnerId: a.learnerId, lessonId: a.lessonId, topicId, sourceAttemptId: a.id, dueAt: plan.dueAt });
}

// ---------------------------------------------------------------------------
// GET /assessments/due?learner_id=
// ---------------------------------------------------------------------------

export async function dueReviewsHandler(req: Request, c: Ctx): Promise<Response> {
  requireAssessmentsEnabled();
  const claims = await verifyDeviceBearer(req, c);
  await enforceAssessmentRateLimit(c, "assessmentDueByDevice", claims.sub);
  const learner = Uuid.safeParse(new URL(req.url).searchParams.get("learner_id"));
  if (!learner.success) throw validationFailed([{ path: ["learner_id"], code: "invalid_string" }]);
  const repo = assessmentRepo();
  const now = c.deps.now();
  const body = await withDevice(c, claims, async (sql) => {
    await assertLearner(sql, repo, claims, learner.data);
    const tz = safeTimezone(await repo.householdTimezone(sql, claims.hid));
    const due = dueReviews(await repo.reviewsForLearner(sql, learner.data), now, tz);
    return { learner_id: learner.data, timezone: tz, as_of: now.toISOString(), ...due };
  });
  return json(c, body);
}
