# Proposal A7: assessment endpoints, defaults, and lead changes (P4)

- Status: proposed by A7 (Assessment & Retention) on 2026-11-14. This needs lead approval as a follow-up ADR.
- No frozen contract file was changed. The four OpenAPI operations under `/assessments/*` are implemented
  with their v1.1 request and response schemas. Everything below is either additive or a clarification.
- Code:
  - `packages/assessment`: pure functions for selection, scoring rules, the scheduler, the ELS adapter, and the
    ADR-0007 key mapping.
  - `apps/admin/src/server/assessment/**`: the handlers, the repo seam, the SQL repo, and the ELS evidence loader.
  - `apps/admin/src/app/api/v1/assessments/**`
  - `supabase/migrations/0006_assessments.sql`

## 1. Lead changes I need (not in A7's ownership)

These are required. Without them, `@bnl/admin` cannot resolve `@bnl/assessment`. I tested them locally with
`pnpm install --offline`, then reverted them before committing.

1. Add one dependency to `apps/admin/package.json`:
   ```diff
        "@bnl/storage": "workspace:*",
   +    "@bnl/assessment": "workspace:*"
   ```
2. Regenerate `pnpm-lock.yaml` with `pnpm install`. The expected diff is:
   - a new importer `packages/assessment`, with `@bnl/contracts`, `@bnl/intelligence` and `@bnl/lesson-engine`,
     each as a `link:` entry;
   - a new entry `'@bnl/assessment': link:../../packages/assessment` under the `apps/admin` dependencies.

   No external packages are added.
3. `next.config.ts` `transpilePackages`: no change is needed, because `next build` passed locally without one.
   For consistency you may add `@bnl/assessment`, `@bnl/intelligence` and `@bnl/lesson-engine`.
4. Optional: list `FEATURE_ASSESSMENTS` in the ops docs. It is already in `.env.example`, with default `false`.

## 2. Endpoints (all `PAIRED_DEVICE`, Bearer device token)

Every endpoint first checks the feature flag. Unless `FEATURE_ASSESSMENTS === "true"`, it returns
`503 feature_disabled`, and this check runs before authentication, as for A6 telemetry. Next come the device
token checks:
- a missing or invalid token gets `401`;
- a revoked device, or a stale `ver`, also gets `401`, because the check runs in the same transaction as the request.

Then the per-device rate limit applies, and the request runs in a `bnl_device` RLS context. All responses
carry `Cache-Control: no-store`.

| Operation | Behaviour and additions |
|---|---|
| `POST /assessments/start` | The body is `StartAssessmentRequest`, and it is **strict**: unknown keys return 422. The response is 201 `StartAssessmentResponse`. It contains **no answer key**: each question has only `question_version_key`, `prompt` and `options`. The attempt is pinned to the lesson's live version. If the learner is not in the device's household, the response is 403. An unknown or unpublished lesson returns 422 `lesson_unknown`. |
| `POST /assessments/{id}/answers` | The body is `SubmitAnswerRequest`, and it is strict: an `is_correct` field returns 422 (TEL-005). Correctness comes only from `bnl.score_answer`. The response's `correct_option_id` is returned only after the answer is stored. |
| `POST /assessments/{id}/finish` | Totals are computed in the database from the scored responses. The response also gives `next_review_due_at`. |
| `GET /assessments/due?learner_id=` | Lists the open reviews that are due. The 200 body schema is defined in §3. |

### Status codes, clarified (please add them to OpenAPI v1.2)

- **401**: no token, an invalid token, or a revoked device.
- **403** `forbidden`:
  - the learner is not in the household;
  - the attempt id is unknown, malformed, or belongs to another household. These three cases are deliberately the same, so the response cannot reveal which attempts exist.
- **409** `conflict`, with `details.reason` set to one of these values:
  - `baseline_after_exposure`: the learner already has an immediate or delayed attempt, or any `learner_progress` row, for the lesson.
  - `baseline_already_taken`: a finished baseline with questions already exists.
  - `review_not_due`: a delayed check was requested when no open review is due. `details.next_due_at` is included.
  - `attempt_finished`: a new answer arrived after finish.
  - `attempt_expired`: a new answer arrived more than 6 h after the start.
  - `client_attempt_id_taken`: the id is already used, possibly by another household. Nothing about that attempt is returned.
- **409** `idempotency_conflict`:
  - the same `client_attempt_id` was sent with a different learner, lesson or stage;
  - or the same `Idempotency-Key` was sent with a different body.
- **422** `validation_failed`, with issue codes:
  - `lesson_unknown`
  - `question_not_in_attempt`
  - `unknown_option`
  - `invalid_answer` (the database backstop)
  - plus the standard Zod codes.
- **429** `rate_limited` with `Retry-After`. The limits are per device, as fixed windows:
  - start: 30/min
  - answers: 120/min
  - finish: 30/min
  - due: 60/min
- **503** `feature_disabled`.

### Idempotency

- **Natural keys.** Assessment mutations are idempotent without any header:
  - `client_attempt_id`: the same id returns the same attempt, with the same questions and option order. The response is 201 with `Idempotent-Replayed: true`.
  - One answer per (attempt, question): a repeat returns the **first** stored answer with `already_answered: true`, whatever option was sent this time.
  - Finish once: a repeat returns the same totals and `Idempotent-Replayed: true`.
- **Optional `Idempotency-Key`.** The header is accepted but not required, because OpenAPI v1.1 does not require it on these operations.
  - When sent, it is honoured exactly as on the learning endpoints: rows in `bnl.idempotency_keys`, scopes `assessment.start | assessment.answer | assessment.finish`, and the same replay and 409 rules.
  - A malformed key returns 422.

### Additive response shape: `GET /assessments/due`

OpenAPI only says "Gentle, optional delayed reviews that are due". Proposed schema `DueReviewsResponse`:
```json
{ "learner_id": "uuid", "timezone": "Asia/Kolkata", "as_of": "ISO",
  "items": [{ "review_id": "uuid", "lesson_id": "uuid|null", "topic_id": "uuid|null", "source_attempt_id": "uuid|null",
              "due_at": "ISO", "window_ends_at": "ISO", "overdue": false }],
  "next_due_at": "ISO|null" }
```
- Items are sorted oldest first.
- A review stays listed after its window closes, with `overdue: true`. Reviews are optional, and a missed one is never scored as zero.

### ADR-0007 key mapping

The stored A4 bank key is canonical. `@bnl/assessment`'s `toBankItemKey` and `toBankOptionId` translate the
lesson-engine format into it:
- the key `multiplicationItemKey` = `<versionId>:mult-FxN`;
- the option ids `opt-<value>`.

`POST /answers` accepts either format. An engine key maps only when its version id and factor match the
attempt's version. The answer is always stored under the bank key. lesson-engine is unchanged.

## 3. Defaults chosen where the spec is open

All of these live in `packages/assessment/src/policy.ts`.

| Topic | Default |
|---|---|
| Items per stage | The lesson's `quiz_question_count`, clamped to **3..5**. The live lessons use 3. Fewer than 3 eligible items gives `status: insufficient_items` with no questions. That attempt is created already finished, so it can never collect answers. |
| Seed | `seed` = 32 hex characters derived from `(client_attempt_id, lesson_version_id, stage)` with FNV-1a, stored in `assessment_attempts.seed`. Question choice and option order are pure functions of the seed. `Math.random` is never used, and a test checks this. |
| Fresh questions across stages (TEL-006) | Items are compared by identity: the key without its `.v<N>` suffix, so the same fact in a newer version is not fresh. An item the learner saw in **another** stage is used only after everything else is exhausted, and such reuse is reported, not silent. A per-learner "delayed reserve" of N items is kept out of baseline and immediate quizzes. With the 10-item tables this yields 3 baseline, 3–4 immediate (repeat quizzes rotate among these), and 3 fresh delayed items. |
| Baseline | Only before the first exposure to the lesson, at most one finished baseline per lesson, and it never schedules a review. |
| Answer window | 6 h after the start. Later new answers return `attempt_expired`. For ELS, an unfinished attempt counts only after its window has passed. |
| Review ladder | The first delayed check is due at **local midnight, +3 days** after the immediate quiz. The review window covers days +3 to +7 (`DELAYED_REVIEW_MIN/MAX_DAYS`). A passed delayed check (≥ 80 %) moves one step up the ladder of 3 → 7 → 14 → 30 days; a failed one goes back to 3 days. Only one open review exists per learner and lesson: repeat quizzes keep the earliest one, and a unique index enforces this. A finished attempt with no answers schedules nothing. |
| Timezone | `households.timezone`. An unknown or missing zone falls back to `Asia/Kolkata`. Due dates are stored in UTC, and DST is handled. |
| Delayed start | Requires an open review that is due. Otherwise the response is 409 `review_not_due`. |

## 4. ELS inputs (`buildElsInputs`, `elsInputsForLearner`)

`buildElsInputs` produces an `@bnl/intelligence` `ElsInput` for each topic. The intelligence package is
unchanged. It also returns per-stage evidence of the form
`{status: observed | insufficient_evidence, reason, questions}`.

**Absence is never zero.** When retention has no usable evidence, `delayed` is `null`, so R is null and the
score is provisional. The reason is one of:
- `no_attempt`
- `no_answers`
- `delayed_check_too_early`: the check started before local midnight of first exposure + 3 days.
- `delayed_items_not_fresh`: every item was seen in baseline or immediate.
- `no_exposure_reference`

The other rules:
- Each question identity counts once per stage, using its first answer (first-attempt correctness).
- A baseline taken after exposure is excluded and reported as `baseline_after_exposure`. Exposure is the first
  immediate attempt or the first `learner_progress` row.
- `elsInputsForLearner(sql, learnerId, now)` loads attempts, responses, `lessons.topic_id` and the household
  timezone under `bnl_job` or `bnl_adult` RLS. A8's scoring job can call it directly.
- Completion (C) is passed in by the caller, from progress.
- `@bnl/assessment` re-exports `computeEls`.

## 5. Migration 0006 (additive, re-runnable)

The gap: `bnl_device` holds UPDATE on `assessment_attempts`, so a request-path bug could write
`correct_questions`. Also, an attempt with empty `question_keys` let `score_answer` accept any item of the version.

0006 adds:
- A `BEFORE INSERT/UPDATE` guard on `assessment_attempts`. It is SECURITY DEFINER, owned by `bnl_owner`, with `search_path` pinned.
  - The identity columns are immutable.
  - Totals are **computed** from `question_responses` when `finished_at` is first set; any supplied totals are ignored.
  - Once finished, an attempt is frozen.
- A guard on `question_responses`. A response is rejected when:
  - its question is not in the attempt's `question_keys`;
  - the attempt is finished;
  - or the response's learner or household differs from the attempt's.

  Responses are immutable.
- A partial unique index allowing one open (`status = 'due'`) review per (learner, lesson).
- A lookup index `idx_attempts_learner_lesson_stage`.

No tables are added. RLS (ENABLE + FORCE) and the grants are therefore unchanged, and SEC-005 still passes.
The migration ends with the standard revoke sweep.

## 6. Verified: no answer-key leak

- `GET /catalog/lessons/{id}` for the seeded ×7 lesson contains no `correct`, case-insensitive. This is asserted in `test/integration/assessment-db.test.ts`.
- `POST /assessments/start` contains no `correct`. This is asserted in the route tests and the real-DB tests.
- Devices cannot `SELECT bnl.quiz_items`; the existing `@bnl/db` test covers this.

One note: for multiplication, the published `config.factor` together with the prompt `n × m = ?` lets anyone
compute the answer. That is inherent to the content, not a leak of the bank. Content where this matters would
need to keep prompts out of the public lesson config.

## 7. Requests and follow-ups

- In OpenAPI v1.2, add for the four operations:
  - the 401, 409, 422, 429 and 503 responses;
  - the optional `Idempotency-Key` and the `Idempotent-Replayed` header;
  - `DueReviewsResponse`.
- Spec M08 names the location `packages/lesson-engine/assessment`. This proposal uses `packages/assessment` instead, because ADR-0007 asks for lesson-engine to stay unchanged.
- A5 (student): call `/assessments/start` with `stage: "immediate"` after a lesson; this keeps the existing 3-question quiz.
  - Treat `insufficient_items` and 503 as "show the local quiz, no evidence".
  - Baseline and delayed checks are opt-in. Use `GET /assessments/due` to offer them gently.
- A8 (intelligence): build `mastery_snapshots` from `elsInputsForLearner` + `computeEls`. Use
  `evidence.retention.reason` for the limitation text and for the `delayed_review_due` or
  `insufficient_evidence_take_quiz` recommendations.
