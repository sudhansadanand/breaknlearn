import { z } from "zod";
import { IsoDateTime, Uuid } from "./common";

export const ELS_WEIGHTS_VERSION = "els-v1";
export const ELS_WEIGHTS = { M: 0.4, R: 0.3, I: 0.2, C: 0.1 } as const;
/** Stable topic mastery needs at least this many distinct questions (ELS-005). */
export const ELS_MIN_DISTINCT_QUESTIONS = 5;

export const ScoreStatus = z.enum(["provisional", "evidence_sufficient", "insufficient_evidence"]);

export const LearningScore = z.object({
  learner_id: Uuid,
  topic_id: Uuid.nullable(),
  score: z.number().min(0).max(100).nullable(),
  status: ScoreStatus,
  confidence: z.enum(["low", "adequate"]),
  components: z.object({
    M: z.number().min(0).max(100).nullable(),
    R: z.number().min(0).max(100).nullable(),
    I: z.number().min(0).max(100).nullable(),
    C: z.number().min(0).max(100).nullable(),
  }),
  /** Share (0..100) of the maximum weight backed by evidence. */
  coverage_pct: z.number().min(0).max(100),
  weights_version: z.string(),
  questions_count: z.number().int().min(0),
  confidence_note: z.string(),
  limitation: z.string(),
  computed_at: IsoDateTime,
});
export type LearningScore = z.infer<typeof LearningScore>;

export const RecommendationReason = z.enum([
  "retention_low_spaced_recall",
  "mastery_low_prerequisite_practice",
  "ready_for_next_topic",
  "delayed_review_due",
  "insufficient_evidence_take_quiz",
]);

export const Recommendation = z.object({
  id: Uuid,
  learner_id: Uuid,
  topic_id: Uuid.nullable(),
  reason_code: RecommendationReason,
  suggested_lesson_id: Uuid.nullable(),
  computed_at: IsoDateTime,
  dismissed_at: IsoDateTime.nullable(),
});
