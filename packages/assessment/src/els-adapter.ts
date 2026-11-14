/**
 * Builds ELS inputs (`@bnl/intelligence` ElsInput) from stored assessment attempts and server-scored responses.
 *
 * Absence is never zero: a stage with no usable evidence becomes `null` (→ component null, provisional or
 * insufficient_evidence score), and the reason is reported per stage. In particular a missing, too-early or
 * non-fresh delayed check yields retention `insufficient_evidence`, never R = 0 (spec M08/M10, ELS-002/004).
 *
 * Rules (per lesson, then summed per topic):
 * - usable attempt: finished, or its answer window has passed (answers already given are server-scored evidence);
 * - each question identity counts once per stage, by its FIRST answer (first-attempt correctness);
 * - baseline: only attempts started before the learner's first exposure to the lesson (first immediate attempt
 *   or `exposureByLesson`); later "baselines" are excluded (`baseline_after_exposure`);
 * - delayed: only attempts started at or after local midnight of (first exposure + DELAYED_REVIEW_MIN_DAYS) in
 *   the household timezone, and only items the learner did not see in baseline/immediate of that lesson.
 */
import { DELAYED_REVIEW_MIN_DAYS } from "@bnl/contracts";
import type { ElsInput, StageResult } from "@bnl/intelligence";
import { ANSWER_WINDOW_MS, DEFAULT_TIMEZONE, type Stage } from "./policy";
import { startOfLocalDay } from "./scheduler";
import { itemIdentity } from "./selection";

export interface ResponseEvidence {
  readonly questionVersionKey: string;
  readonly correct: boolean;
  readonly answeredAt: Date;
}

export interface AttemptEvidence {
  readonly attemptId: string;
  readonly lessonId: string;
  readonly topicId: string | null;
  readonly stage: Stage;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly questionKeys: readonly string[];
  readonly responses: readonly ResponseEvidence[];
}

export type EvidenceReason =
  | "no_attempt"
  | "no_answers"
  | "baseline_after_exposure"
  | "no_exposure_reference"
  | "delayed_check_too_early"
  | "delayed_items_not_fresh";

export interface StageEvidence {
  readonly status: "observed" | "insufficient_evidence";
  /** Why the stage has no usable evidence (null when observed). */
  readonly reason: EvidenceReason | null;
  readonly questions: number;
}

export interface TopicEls {
  readonly topicId: string | null;
  readonly lessonIds: string[];
  readonly input: ElsInput;
  readonly evidence: { readonly baseline: StageEvidence; readonly immediate: StageEvidence; readonly retention: StageEvidence };
}

interface Tally { total: number; correct: number; keys: string[] }

const usable = (a: AttemptEvidence, now: Date) => a.finishedAt !== null || now.getTime() - a.startedAt.getTime() >= ANSWER_WINDOW_MS;

/** First answer per question identity across `attempts`, restricted to `allow`. */
function firstAnswers(attempts: readonly AttemptEvidence[], allow: (identity: string) => boolean = () => true): Tally {
  const first = new Map<string, ResponseEvidence>();
  for (const a of attempts) {
    const presented = new Set(a.questionKeys);
    for (const r of a.responses) {
      if (!presented.has(r.questionVersionKey)) continue;
      const id = itemIdentity(r.questionVersionKey);
      if (!allow(id)) continue;
      const prev = first.get(id);
      if (!prev || r.answeredAt.getTime() < prev.answeredAt.getTime()) first.set(id, r);
    }
  }
  return { total: first.size, correct: [...first.values()].filter((r) => r.correct).length, keys: [...first.keys()].sort() };
}

const presentedIdentities = (attempts: readonly AttemptEvidence[]) =>
  new Set(attempts.flatMap((a) => a.questionKeys.map(itemIdentity)));

interface LessonOutcome {
  baseline: Tally | null;
  immediate: Tally | null;
  delayed: Tally | null;
  reasons: { baseline: EvidenceReason | null; immediate: EvidenceReason | null; retention: EvidenceReason | null };
}

function lessonOutcome(all: readonly AttemptEvidence[], now: Date, tz: string, exposureAt: Date | undefined): LessonOutcome {
  const byStage = (s: Stage) => all.filter((a) => a.stage === s).sort((x, y) => x.startedAt.getTime() - y.startedAt.getTime());
  const baselines = byStage("baseline");
  const immediates = byStage("immediate");
  const delayeds = byStage("delayed");
  const firstImmediate = immediates[0]?.startedAt;
  const exposure = [firstImmediate, exposureAt].filter((d): d is Date => d instanceof Date).sort((a, b) => a.getTime() - b.getTime())[0];

  // Baseline (pre-test): only before the first exposure.
  let baseline: Tally | null = null;
  let baselineReason: EvidenceReason | null = null;
  const preExposure = baselines.filter((a) => usable(a, now) && (!exposure || a.startedAt.getTime() < exposure.getTime()));
  if (baselines.length === 0) baselineReason = "no_attempt";
  else if (preExposure.length === 0) baselineReason = baselines.some((a) => usable(a, now)) ? "baseline_after_exposure" : "no_answers";
  else {
    const t = firstAnswers(preExposure);
    if (t.total > 0) baseline = t;
    else baselineReason = "no_answers";
  }

  // Immediate (mastery).
  let immediate: Tally | null = null;
  let immediateReason: EvidenceReason | null = null;
  const usableImmediates = immediates.filter((a) => usable(a, now));
  if (immediates.length === 0) immediateReason = "no_attempt";
  else {
    const t = firstAnswers(usableImmediates);
    if (t.total > 0) immediate = t;
    else immediateReason = "no_answers";
  }

  // Delayed (retention): after the minimum interval, fresh items only.
  let delayed: Tally | null = null;
  let retentionReason: EvidenceReason | null = null;
  const usableDelayed = delayeds.filter((a) => usable(a, now));
  if (delayeds.length === 0) retentionReason = "no_attempt";
  else if (!exposure) retentionReason = "no_exposure_reference";
  else {
    const earliest = startOfLocalDay(exposure, DELAYED_REVIEW_MIN_DAYS, tz);
    const onTime = usableDelayed.filter((a) => a.startedAt.getTime() >= earliest.getTime());
    if (usableDelayed.length === 0) retentionReason = "no_answers";
    else if (onTime.length === 0) retentionReason = "delayed_check_too_early";
    else {
      const seenBefore = presentedIdentities([...baselines, ...immediates]);
      const all = firstAnswers(onTime);
      const fresh = firstAnswers(onTime, (id) => !seenBefore.has(id));
      if (fresh.total > 0) delayed = fresh;
      else retentionReason = all.total > 0 ? "delayed_items_not_fresh" : "no_answers";
    }
  }
  return { baseline, immediate, delayed, reasons: { baseline: baselineReason, immediate: immediateReason, retention: retentionReason } };
}

const REASON_ORDER: readonly EvidenceReason[] = [
  "delayed_items_not_fresh", "delayed_check_too_early", "baseline_after_exposure", "no_answers", "no_exposure_reference", "no_attempt",
];

function merge(tallies: readonly (Tally | null)[]): StageResult | null {
  const present = tallies.filter((t): t is Tally => t !== null);
  if (present.length === 0) return null;
  return {
    total: present.reduce((s, t) => s + t.total, 0),
    correct: present.reduce((s, t) => s + t.correct, 0),
    questionKeys: [...new Set(present.flatMap((t) => t.keys))].sort(),
  };
}

function stageEvidence(result: StageResult | null, reasons: readonly (EvidenceReason | null)[]): StageEvidence {
  if (result) return { status: "observed", reason: null, questions: result.questionKeys.length };
  const reason = REASON_ORDER.find((r) => reasons.includes(r)) ?? "no_attempt";
  return { status: "insufficient_evidence", reason, questions: 0 };
}

/**
 * One ElsInput per topic for one learner. `attempts` must all belong to `learnerId` (callers load them under
 * household-scoped RLS). Topics with no attempts at all are not returned.
 */
export function buildElsInputs(p: {
  learnerId: string;
  attempts: readonly AttemptEvidence[];
  now: Date;
  timezone?: string;
  /** Verified slide completion per topic (from progress); omitted → C is not measured. */
  completionByTopic?: ReadonlyMap<string | null, { completedSlides: number; assignedSlides: number }>;
  /** Earliest lesson exposure known from progress/telemetry, per lesson. */
  exposureByLesson?: ReadonlyMap<string, Date>;
}): TopicEls[] {
  const tz = p.timezone ?? DEFAULT_TIMEZONE;
  const byLesson = new Map<string, AttemptEvidence[]>();
  for (const a of p.attempts) byLesson.set(a.lessonId, [...(byLesson.get(a.lessonId) ?? []), a]);

  const byTopic = new Map<string | null, { lessonIds: string[]; outcomes: LessonOutcome[] }>();
  for (const [lessonId, list] of [...byLesson].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const topicId = list[0]?.topicId ?? null;
    const entry = byTopic.get(topicId) ?? { lessonIds: [], outcomes: [] };
    entry.lessonIds.push(lessonId);
    entry.outcomes.push(lessonOutcome(list, p.now, tz, p.exposureByLesson?.get(lessonId)));
    byTopic.set(topicId, entry);
  }

  return [...byTopic].map(([topicId, { lessonIds, outcomes }]) => {
    const baseline = merge(outcomes.map((o) => o.baseline));
    const immediate = merge(outcomes.map((o) => o.immediate));
    const delayed = merge(outcomes.map((o) => o.delayed));
    return {
      topicId,
      lessonIds,
      input: {
        learnerId: p.learnerId,
        topicId,
        baseline,
        immediate,
        delayed,
        completion: p.completionByTopic?.get(topicId) ?? null,
        computedAt: p.now,
      },
      evidence: {
        baseline: stageEvidence(baseline, outcomes.map((o) => o.reasons.baseline)),
        immediate: stageEvidence(immediate, outcomes.map((o) => o.reasons.immediate)),
        retention: stageEvidence(delayed, outcomes.map((o) => o.reasons.retention)),
      },
    };
  });
}
