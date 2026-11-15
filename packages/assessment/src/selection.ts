/**
 * Seeded, deterministic question selection for one attempt (spec M08, TEL-006). No Math.random: the same
 * (items, stage, prior attempts, seeds) always yields the same questions and option order.
 *
 * Rules
 * - Only items whose `stage_eligibility` includes the stage are candidates.
 * - Different stages use different questions by default: an item the learner already saw in ANOTHER stage of
 *   this lesson is used only when nothing fresher is left (reported in `reused_across_stages`).
 * - A per-learner "delayed reserve" (the first `count` delayed-eligible items of a learner-seeded order) is kept
 *   out of baseline/immediate while other items remain, so a fresh delayed check exists even after several
 *   repeats of the 3-question post-lesson quiz.
 * - Items are compared by identity (`question_version_key` without its `.v<N>` suffix), so the same fact in a
 *   newer lesson version is not "fresh".
 * - Fewer than MIN_ITEMS_PER_STAGE eligible items → `insufficient_items` (never a fabricated quiz).
 */
import { hashSeed, mulberry32, shuffled } from "@bnl/lesson-engine";
import { MIN_ITEMS_PER_STAGE, type Stage } from "./policy";

export interface PublicItem {
  readonly question_version_key: string;
  readonly outcome_key: string;
  readonly stage_eligibility: readonly string[];
  readonly prompt: string;
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly sort_order: number;
}

export interface PriorAttempt {
  readonly stage: Stage;
  readonly questionKeys: readonly string[];
}

export interface SelectedQuestion {
  readonly question_version_key: string;
  readonly prompt: string;
  readonly options: { id: string; label: string }[];
}

export interface Selection {
  readonly status: "ready" | "insufficient_items";
  readonly questions: SelectedQuestion[];
  /** Keys picked although the learner saw the same item in another stage (only when the bank ran out). */
  readonly reused_across_stages: string[];
}

/** `<stable_key>.fact-3.v2` → `<stable_key>.fact-3`; other keys are their own identity. */
export function itemIdentity(key: string): string {
  return key.replace(/\.v\d+$/, "");
}

const hex8 = (n: number) => (n >>> 0).toString(16).padStart(8, "0");

/** 32 hex chars derived from the client attempt id, version and stage (stored in assessment_attempts.seed). */
export function attemptSeed(p: { clientAttemptId: string; lessonVersionId: string; stage: Stage }): string {
  const base = `${p.clientAttemptId}|${p.lessonVersionId}|${p.stage}`;
  return [0, 1, 2, 3].map((i) => hex8(hashSeed(`${i}:${base}`))).join("");
}

/** Learner-level seed: stable for one learner and lesson version across all of their attempts. */
export const learnerSeed = (learnerId: string, lessonVersionId: string): string => `${learnerId}|${lessonVersionId}`;

const ranked = <T>(list: readonly T[], seed: string): T[] => shuffled(list, mulberry32(hashSeed(seed)));

/** Option order shown for one question of an attempt: a pure function of (attempt seed, question key). */
export function seededOptionOrder(options: readonly { readonly id: string; readonly label: string }[], seed: string, questionKey: string): { id: string; label: string }[] {
  return ranked(options, `${seed}|options|${questionKey}`).map((o) => ({ id: o.id, label: o.label }));
}

export function selectQuestions(p: {
  items: readonly PublicItem[];
  stage: Stage;
  count: number;
  seed: string;
  learnerSeed: string;
  prior: readonly PriorAttempt[];
}): Selection {
  const byKey = (a: PublicItem, b: PublicItem) => (a.question_version_key < b.question_version_key ? -1 : a.question_version_key > b.question_version_key ? 1 : 0);
  const eligible = p.items.filter((i) => i.stage_eligibility.includes(p.stage)).slice().sort(byKey);
  if (eligible.length < MIN_ITEMS_PER_STAGE || p.count < 1) return { status: "insufficient_items", questions: [], reused_across_stages: [] };

  const usedOther = new Set(p.prior.filter((a) => a.stage !== p.stage).flatMap((a) => a.questionKeys.map(itemIdentity)));
  const usedSame = new Set(p.prior.filter((a) => a.stage === p.stage).flatMap((a) => a.questionKeys.map(itemIdentity)));
  const delayedPool = p.items.filter((i) => i.stage_eligibility.includes("delayed")).slice().sort(byKey);
  const reserve = new Set(ranked(delayedPool, `${p.learnerSeed}|delayed-reserve`).slice(0, p.count).map((i) => itemIdentity(i.question_version_key)));

  const id = (i: PublicItem) => itemIdentity(i.question_version_key);
  const freshOther = (i: PublicItem) => !usedOther.has(id(i));
  const unseen = (i: PublicItem) => freshOther(i) && !usedSame.has(id(i));
  const tiers: ((i: PublicItem) => boolean)[] =
    p.stage === "delayed"
      ? [(i) => reserve.has(id(i)) && unseen(i), unseen, freshOther, () => true]
      : [(i) => unseen(i) && !reserve.has(id(i)), (i) => freshOther(i) && !reserve.has(id(i)), freshOther, () => true];

  const picked: PublicItem[] = [];
  const seen = new Set<string>();
  tiers.forEach((tier, n) => {
    for (const item of ranked(eligible.filter(tier), `${p.seed}|tier-${n}`)) {
      if (picked.length >= p.count) return;
      if (seen.has(id(item))) continue;
      seen.add(id(item));
      picked.push(item);
    }
  });

  return {
    status: "ready",
    questions: picked.map((i) => ({
      question_version_key: i.question_version_key,
      prompt: i.prompt,
      options: seededOptionOrder(i.options, p.seed, i.question_version_key),
    })),
    reused_across_stages: picked.filter((i) => usedOther.has(id(i))).map((i) => i.question_version_key),
  };
}
