/**
 * Assessment policy defaults (spec M08). Every value the spec leaves open is fixed here and documented in
 * docs/adr/proposals/A7-assessment-contract-additions.md, so the server, jobs and tests agree.
 */
import { DELAYED_REVIEW_MAX_DAYS, DELAYED_REVIEW_MIN_DAYS, type AttemptStage } from "@bnl/contracts";

export type Stage = AttemptStage;
export const STAGES: readonly Stage[] = ["baseline", "immediate", "delayed"];

/** M08: 3–5 items per stage. The lesson's `quiz_question_count` (live default 3) is clamped into this range. */
export const MIN_ITEMS_PER_STAGE = 3;
export const MAX_ITEMS_PER_STAGE = 5;
export const DEFAULT_ITEMS_PER_STAGE = 3;

/** Answers are accepted for this long after an attempt starts; later answers are refused (`attempt_expired`). */
export const ANSWER_WINDOW_MS = 6 * 3_600_000;

/**
 * Spaced review ladder in days. The first delayed check is due DELAYED_REVIEW_MIN_DAYS (+3) after the
 * immediate quiz; each passed delayed check moves one rung up, a missed one repeats the first rung.
 */
export const REVIEW_LADDER_DAYS: readonly number[] = [DELAYED_REVIEW_MIN_DAYS, DELAYED_REVIEW_MAX_DAYS, 14, 30];
/** A review stays "in window" this many days after it becomes due (+3..+7 for the first rung). */
export const REVIEW_WINDOW_DAYS = DELAYED_REVIEW_MAX_DAYS - DELAYED_REVIEW_MIN_DAYS;
/** Share of correct answers (0..100) at which a delayed check counts as passed for the ladder. */
export const REVIEW_PASS_PCT = 80;

/** Default household timezone (spec M11). */
export const DEFAULT_TIMEZONE = "Asia/Kolkata";

export function itemsPerStage(quizQuestionCount: unknown): number {
  const n = typeof quizQuestionCount === "number" && Number.isInteger(quizQuestionCount) ? quizQuestionCount : DEFAULT_ITEMS_PER_STAGE;
  return Math.min(MAX_ITEMS_PER_STAGE, Math.max(MIN_ITEMS_PER_STAGE, n));
}
