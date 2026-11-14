/** Transparent, reversible recommendation rules (spec M10). Never optimises for screen time. */
import type { LearningScore } from "@bnl/contracts";

export const RECOMMENDATION_RULES_VERSION = "rules-v1";
export const THRESHOLDS = { retentionLow: 60, masteryLow: 60, ready: 80 } as const;

export type ReasonCode =
  | "insufficient_evidence_take_quiz"
  | "retention_low_spaced_recall"
  | "mastery_low_prerequisite_practice"
  | "ready_for_next_topic";

export type RecommendationCode = ReasonCode | "delayed_review_due";

/** Returns at most one reason, in priority order, or null when no nudge is warranted. */
export function recommend(s: LearningScore, opts: { delayedReviewDue?: boolean } = {}): RecommendationCode | null {
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

/**
 * Inputs for one learner × lesson. Deliberately has NO time-spent, visit-count or streak field: a
 * recommendation can only come from assessment evidence, completion, or a scheduled review (spec §8).
 */
export interface LessonRecommendationInput {
  readonly learnerId: string;
  readonly topicId: string | null;
  readonly lessonId: string;
  /** The lesson's latest score; null when the lesson has no evidence at all. */
  readonly score: LearningScore | null;
  /** An open delayed review for this lesson is due at the as-of instant (review_schedule). */
  readonly reviewDue: boolean;
  /** The next lesson in sequence (e.g. ×4 after ×3); null at the end of a sequence. */
  readonly nextLessonId: string | null;
}

export interface LessonRecommendation {
  readonly learner_id: string;
  readonly topic_id: string | null;
  readonly lesson_id: string;
  readonly reason_code: RecommendationCode;
  readonly suggested_lesson_id: string | null;
  /** Explainability record stored with the row: which rule fired on which inputs. */
  readonly detail: {
    readonly rules_version: string;
    readonly thresholds: typeof THRESHOLDS;
    readonly inputs: {
      readonly M: number | null;
      readonly R: number | null;
      readonly C: number | null;
      readonly status: LearningScore["status"] | "no_score";
      readonly confidence: LearningScore["confidence"] | null;
      readonly review_due: boolean;
    };
  };
}

/** One recommendation (or none) for a learner × lesson. Deterministic and order-independent. */
export function recommendForLesson(input: LessonRecommendationInput): LessonRecommendation | null {
  const s = input.score;
  let code: RecommendationCode | null;
  if (s === null) code = input.reviewDue ? "delayed_review_due" : null;
  else code = recommend(s, { delayedReviewDue: input.reviewDue });
  if (code === null) return null;
  return {
    learner_id: input.learnerId,
    topic_id: input.topicId,
    lesson_id: input.lessonId,
    reason_code: code,
    suggested_lesson_id: code === "ready_for_next_topic" ? input.nextLessonId : input.lessonId,
    detail: {
      rules_version: RECOMMENDATION_RULES_VERSION,
      thresholds: THRESHOLDS,
      inputs: {
        M: s?.components.M ?? null,
        R: s?.components.R ?? null,
        C: s?.components.C ?? null,
        status: s?.status ?? "no_score",
        confidence: s?.confidence ?? null,
        review_due: input.reviewDue,
      },
    },
  };
}

/** Plain-language explanation for guardians, per reason code (`{lesson}` is the lesson's name). */
export const RECOMMENDATION_TEXT: Record<RecommendationCode, { readonly action: string; readonly why: string }> = {
  insufficient_evidence_take_quiz: {
    action: "Try the short quiz after {lesson}",
    why: "There are no quiz answers for this lesson yet, so we cannot tell how it is going. Watching alone is not counted as learning.",
  },
  retention_low_spaced_recall: {
    action: "Do a short review of {lesson}",
    why: `The later review check was below ${THRESHOLDS.retentionLow}%, so some facts may have been forgotten. A brief review a few days apart helps them stick.`,
  },
  mastery_low_prerequisite_practice: {
    action: "Watch {lesson} again with the picture groups",
    why: `The quiz right after the lesson was below ${THRESHOLDS.masteryLow}%. Seeing the groups again before moving on usually helps.`,
  },
  delayed_review_due: {
    action: "A gentle review of {lesson} is ready",
    why: "A few days have passed since the lesson. A quick check now shows what was remembered. It is optional, and skipping it is never scored as zero.",
  },
  ready_for_next_topic: {
    action: "Ready to move on from {lesson}",
    why: `Quiz results were ${THRESHOLDS.ready}% or more and the lesson was completed, so the next lesson is a good next step.`,
  },
};
