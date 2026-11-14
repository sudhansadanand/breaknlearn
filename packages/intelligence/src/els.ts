/**
 * Effective Learning Score (spec M10, §8). Pure and deterministic.
 *
 *   ELS = 0.40·M + 0.30·R + 0.20·I + 0.10·C   (each 0..100)
 *   M = immediate quiz %, R = delayed quiz %, C = verified completed slides / assigned slides,
 *   I = 100·max(0, (post − pre) / (100 − pre)), clamped; not applicable when pre = 100.
 *
 * Missing evidence is never treated as zero: the score is computed from the observed
 * components with renormalised weights and labelled `provisional`, with coverage showing
 * how much of the possible weight is backed by evidence. Time spent and visit frequency
 * are deliberately NOT inputs (ELS-006).
 */
import { ELS_MIN_DISTINCT_QUESTIONS, ELS_WEIGHTS, ELS_WEIGHTS_VERSION, type LearningScore } from "@bnl/contracts";

export interface StageResult {
  /** Number of scored (server-validated) answers. */
  readonly total: number;
  readonly correct: number;
  /** Distinct question_version_keys answered in this stage. */
  readonly questionKeys: readonly string[];
}

export interface ElsInput {
  readonly learnerId: string;
  readonly topicId: string | null;
  readonly baseline: StageResult | null;
  readonly immediate: StageResult | null;
  readonly delayed: StageResult | null;
  readonly completion: { readonly completedSlides: number; readonly assignedSlides: number } | null;
  readonly computedAt: Date;
}

type Key = keyof typeof ELS_WEIGHTS;
const KEYS: readonly Key[] = ["M", "R", "I", "C"];

const round2 = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100;
const clamp = (x: number, lo = 0, hi = 100): number => Math.min(hi, Math.max(lo, x));

function assertStage(name: string, s: StageResult | null): void {
  if (!s) return;
  if (!Number.isInteger(s.total) || !Number.isInteger(s.correct) || s.total < 0 || s.correct < 0 || s.correct > s.total) {
    throw new RangeError(`invalid ${name} stage counts`);
  }
}

function pct(s: StageResult | null): number | null {
  return s && s.total > 0 ? (100 * s.correct) / s.total : null;
}

export function computeEls(input: ElsInput): LearningScore {
  assertStage("baseline", input.baseline);
  assertStage("immediate", input.immediate);
  assertStage("delayed", input.delayed);
  const comp = input.completion;
  if (comp && (comp.completedSlides < 0 || comp.assignedSlides < 0 || comp.completedSlides > comp.assignedSlides)) {
    throw new RangeError("invalid completion counts");
  }

  const pre = pct(input.baseline);
  const M = pct(input.immediate);
  const R = pct(input.delayed);
  const C = comp && comp.assignedSlides > 0 ? (100 * comp.completedSlides) / comp.assignedSlides : null;

  // Improvement: needs both pre and post; not applicable (excluded from the maximum) when pre = 100.
  const improvementNotApplicable = pre !== null && pre >= 100;
  const I = pre !== null && M !== null && !improvementNotApplicable ? clamp((100 * Math.max(0, M - pre)) / (100 - pre)) : null;

  const components: Record<Key, number | null> = { M, R, I, C };
  const maxWeight = KEYS.reduce((s, k) => s + (k === "I" && improvementNotApplicable ? 0 : ELS_WEIGHTS[k]), 0);
  const observed = KEYS.filter((k) => components[k] !== null);
  const observedWeight = observed.reduce((s, k) => s + ELS_WEIGHTS[k], 0);
  const coverage = maxWeight > 0 ? (100 * observedWeight) / maxWeight : 0;

  const questionKeys = new Set<string>([
    ...(input.baseline?.questionKeys ?? []),
    ...(input.immediate?.questionKeys ?? []),
    ...(input.delayed?.questionKeys ?? []),
  ]);
  const questionsCount = questionKeys.size;
  const confidence = questionsCount >= ELS_MIN_DISTINCT_QUESTIONS ? "adequate" : "low";

  let score: number | null = null;
  let status: LearningScore["status"];
  if (M === null) {
    // No mastery evidence: completion alone can't stand for learning (ELS-004/006).
    status = "insufficient_evidence";
  } else {
    score = round2(observed.reduce((s, k) => s + ELS_WEIGHTS[k] * (components[k] as number), 0) / observedWeight);
    const allApplicablePresent = KEYS.every((k) => components[k] !== null || (k === "I" && improvementNotApplicable));
    status = allApplicablePresent && confidence === "adequate" ? "evidence_sufficient" : "provisional";
  }

  const missing = KEYS.filter((k) => components[k] === null && !(k === "I" && improvementNotApplicable));
  const names: Record<Key, string> = { M: "immediate quiz", R: "delayed review", I: "baseline (before-lesson) check", C: "slide completion" };

  return {
    learner_id: input.learnerId,
    topic_id: input.topicId,
    score,
    status,
    confidence,
    components: { M: nullableRound(M), R: nullableRound(R), I: nullableRound(I), C: nullableRound(C) },
    coverage_pct: round2(coverage),
    weights_version: ELS_WEIGHTS_VERSION,
    questions_count: questionsCount,
    confidence_note:
      confidence === "low"
        ? `Based on ${questionsCount} distinct question${questionsCount === 1 ? "" : "s"}; at least ${ELS_MIN_DISTINCT_QUESTIONS} are needed for a stable estimate.`
        : `Based on ${questionsCount} distinct questions.`,
    limitation:
      (missing.length ? `Not yet measured: ${missing.map((k) => names[k]).join(", ")}. ` : "") +
      (improvementNotApplicable ? "Improvement not applicable (baseline already 100%). " : "") +
      "Observational quiz evidence only; time spent is not part of this score and it does not show cause and effect.",
    computed_at: input.computedAt.toISOString(),
  };
}

function nullableRound(x: number | null): number | null {
  return x === null ? null : round2(x);
}
