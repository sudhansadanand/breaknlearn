import { z } from "zod";
import { IsoDateTime, Uuid } from "./common";
import { QuizOption } from "./lesson";

export const AttemptStage = z.enum(["baseline", "immediate", "delayed"]);
export type AttemptStage = z.infer<typeof AttemptStage>;

export const StartAssessmentRequest = z.object({
  learner_id: Uuid,
  lesson_id: Uuid,
  stage: AttemptStage,
  client_attempt_id: Uuid,
});

/** Questions are sent WITHOUT answer keys. */
export const AssessmentQuestion = z.object({
  question_version_key: z.string(),
  prompt: z.string(),
  visual: z.object({ group_count: z.number().int(), objects_per_group: z.number().int(), theme_key: z.string() }).optional(),
  options: z.array(QuizOption),
});

export const StartAssessmentResponse = z.object({
  attempt_id: Uuid,
  stage: AttemptStage,
  lesson_version_id: Uuid,
  seed: z.string(),
  questions: z.array(AssessmentQuestion),
  status: z.enum(["ready", "insufficient_items"]),
});

export const SubmitAnswerRequest = z
  .object({ question_version_key: z.string().max(128), selected_option_id: z.string().max(128), response_ms: z.number().int().min(0).max(600_000).optional() })
  .strict(); // no is_correct accepted (TEL-005)

export const SubmitAnswerResponse = z.object({
  correct: z.boolean(),
  correct_option_id: z.string(),
  feedback_code: z.enum(["amazing", "good_try"]),
  already_answered: z.boolean(),
});

export const FinishAssessmentResponse = z.object({
  attempt_id: Uuid,
  total_questions: z.number().int(),
  correct_questions: z.number().int(),
  next_review_due_at: IsoDateTime.nullable(),
});

/** Delayed review window (M08): +3..+7 days. */
export const DELAYED_REVIEW_MIN_DAYS = 3;
export const DELAYED_REVIEW_MAX_DAYS = 7;
