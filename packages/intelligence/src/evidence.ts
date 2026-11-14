/**
 * Evidence flags for stored score snapshots and parent-facing badges (spec §8, M10/M11).
 *
 * "Not measured" and "scored zero" are different facts and must stay different all the way to the screen:
 * a component that has no usable evidence is reported with a reason and the badge "Not enough evidence yet",
 * never as 0 %. Pure; no I/O.
 */
import type { LearningScore } from "@bnl/contracts";

/** Structural copy of `@bnl/assessment` StageEvidence (intelligence must not depend on assessment). */
export interface StageEvidenceLike {
  readonly status: "observed" | "insufficient_evidence";
  readonly reason: string | null;
  readonly questions: number;
}

export interface ScoreEvidence {
  readonly baseline: StageEvidenceLike;
  readonly immediate: StageEvidenceLike;
  readonly retention: StageEvidenceLike;
}

export type EvidenceFlag =
  | "provisional"
  | "insufficient_evidence"
  | "low_confidence"
  | "retention_not_measured"
  | "baseline_not_measured"
  | "completion_not_measured"
  | "improvement_not_applicable";

/** Stored with every snapshot (`mastery_snapshots.evidence`). */
export interface EvidenceRecord {
  readonly flags: EvidenceFlag[];
  readonly stages: ScoreEvidence;
  readonly lesson_ids: string[];
}

export const NO_STAGE_EVIDENCE: StageEvidenceLike = { status: "insufficient_evidence", reason: "no_attempt", questions: 0 };

export function evidenceFlags(score: LearningScore, stages: ScoreEvidence): EvidenceFlag[] {
  const flags: EvidenceFlag[] = [];
  if (score.status === "provisional") flags.push("provisional");
  if (score.status === "insufficient_evidence") flags.push("insufficient_evidence");
  if (score.confidence === "low") flags.push("low_confidence");
  if (score.components.R === null) flags.push("retention_not_measured");
  if (stages.baseline.status !== "observed") flags.push("baseline_not_measured");
  if (score.components.C === null) flags.push("completion_not_measured");
  if (stages.baseline.status === "observed" && score.components.I === null && score.components.M !== null) flags.push("improvement_not_applicable");
  return flags;
}

export function evidenceRecord(score: LearningScore, stages: ScoreEvidence, lessonIds: readonly string[]): EvidenceRecord {
  return { flags: evidenceFlags(score, stages), stages, lesson_ids: [...lessonIds].sort() };
}

/** Wording shown to guardians. Never a number when there is no evidence. */
export const NOT_ENOUGH_EVIDENCE = "Not enough evidence yet";

const STAGE_REASON_TEXT: Record<string, string> = {
  no_attempt: "No check taken yet",
  no_answers: "Check started but not answered",
  baseline_after_exposure: "Before-lesson check was taken after the lesson",
  no_exposure_reference: "Lesson not watched yet",
  delayed_check_too_early: "Review was taken too soon after the lesson to count",
  delayed_items_not_fresh: "Review reused questions already seen, so it cannot show memory",
};

export function stageReasonText(reason: string | null): string {
  return reason === null ? "" : (STAGE_REASON_TEXT[reason] ?? "Not measured yet");
}

export type BadgeTone = "measured" | "low" | "none";

export interface ComponentBadge {
  /** The visible text: a percentage or "Not enough evidence yet". */
  readonly text: string;
  /** null when not measured — never 0. */
  readonly value: number | null;
  readonly tone: BadgeTone;
  /** Why it is not measured (empty when measured). */
  readonly detail: string;
}

/** Badge for one component (M or R). `value === null` always renders as "Not enough evidence yet". */
export function componentBadge(value: number | null, stage: StageEvidenceLike | null, lowBelow: number): ComponentBadge {
  if (value === null) {
    return { text: NOT_ENOUGH_EVIDENCE, value: null, tone: "none", detail: stageReasonText(stage?.reason ?? "no_attempt") };
  }
  const rounded = Math.round(value);
  return { text: `${rounded}%`, value, tone: value < lowBelow ? "low" : "measured", detail: "" };
}

export const STATUS_TEXT: Record<LearningScore["status"], string> = {
  evidence_sufficient: "Enough evidence",
  provisional: "Provisional (partial evidence)",
  insufficient_evidence: NOT_ENOUGH_EVIDENCE,
};
