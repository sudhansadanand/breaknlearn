/**
 * Server-side scoring rules (TEL-005). In production the database function `bnl.score_answer` holds the
 * answer key and records the response; these pure helpers define the same rules for the BFF (feedback, totals)
 * and for tests. Devices only ever send `selected_option_id`.
 */
export type FeedbackCode = "amazing" | "good_try";

export const feedbackFor = (correct: boolean): FeedbackCode => (correct ? "amazing" : "good_try");

export interface KeyedItem {
  readonly question_version_key: string;
  readonly options: readonly { readonly id: string }[];
  readonly correct_option_id: string;
}

export type ScoreOutcome =
  | { readonly kind: "scored"; readonly correct: boolean; readonly correct_option_id: string }
  | { readonly kind: "unknown_option" };

/** Correctness of one selection against the server-held key. */
export function scoreSelection(item: KeyedItem, selectedOptionId: string): ScoreOutcome {
  if (!item.options.some((o) => o.id === selectedOptionId)) return { kind: "unknown_option" };
  return { kind: "scored", correct: selectedOptionId === item.correct_option_id, correct_option_id: item.correct_option_id };
}

/**
 * Attempt totals: `total` = questions presented, `correct` = correct answers among them. Unanswered questions
 * count as presented but not correct here; the ELS adapter uses answered questions only.
 */
export function tallyAttempt(questionKeys: readonly string[], responses: readonly { question_version_key: string; correct: boolean }[]): { total: number; correct: number } {
  const keys = new Set(questionKeys);
  const correct = new Set(responses.filter((r) => r.correct && keys.has(r.question_version_key)).map((r) => r.question_version_key));
  return { total: keys.size, correct: correct.size };
}
