/** Transparent, reversible recommendation rules (spec M10). Never optimises for screen time. */
import type { LearningScore } from "@bnl/contracts";

export const RECOMMENDATION_RULES_VERSION = "rules-v1";
export const THRESHOLDS = { retentionLow: 60, masteryLow: 60, ready: 80 } as const;

export type ReasonCode =
  | "insufficient_evidence_take_quiz"
  | "retention_low_spaced_recall"
  | "mastery_low_prerequisite_practice"
  | "ready_for_next_topic";

/** Returns at most one reason, in priority order, or null when no nudge is warranted. */
export function recommend(s: LearningScore, opts: { delayedReviewDue?: boolean } = {}): ReasonCode | "delayed_review_due" | null {
  const { M, R, C } = s.components;
  if (s.status === "insufficient_evidence") return "insufficient_evidence_take_quiz";
  if (R !== null && R < THRESHOLDS.retentionLow) return "retention_low_spaced_recall";
  if (M !== null && M < THRESHOLDS.masteryLow) return "mastery_low_prerequisite_practice";
  if (opts.delayedReviewDue && R === null) return "delayed_review_due";
  if (M !== null && M >= THRESHOLDS.ready && (C ?? 0) >= THRESHOLDS.ready && (R === null || R >= THRESHOLDS.ready)) {
    return "ready_for_next_topic";
  }
  return null;
}
