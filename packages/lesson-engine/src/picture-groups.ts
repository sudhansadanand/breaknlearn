import { PictureGroupsConfig, WORLDS, type ThemeKey } from "@bnl/contracts";
import { hashSeed, mulberry32, shuffled } from "./random";

const COUNT_WORDS = ["ones", "twos", "threes", "fours", "fives", "sixes", "sevens", "eights", "nines", "tens"] as const;

export interface PictureSlide {
  readonly slide_id: string; // "step-N" — same ids as the live app (ADR-0004)
  readonly index: number;
  readonly headline: string; // "7 × 3 = 21"
  readonly title: string; // "Count in sevens!"
  readonly caption: string; // "3 groups of 7 puppies"
  readonly group_count: number;
  readonly objects_per_group: number;
  readonly total_objects: number;
  readonly icon: string;
  readonly alt: string;
}

export function theme(key: ThemeKey) {
  const w = WORLDS.find((x) => x.key === key);
  if (!w) throw new RangeError(`unknown theme ${key}`);
  return w;
}

/** Renders the slides for one table in one world, exactly matching the live app's wording. */
export function renderPictureGroups(rawConfig: unknown, themeKey: ThemeKey): PictureSlide[] {
  const config = PictureGroupsConfig.parse(rawConfig);
  if (!config.themes.includes(themeKey)) throw new RangeError(`theme ${themeKey} not enabled for this lesson`);
  const w = theme(themeKey);
  const f = config.factor;
  const slides: PictureSlide[] = [];
  for (let n = config.count_from; n <= config.count_to; n++) {
    slides.push({
      slide_id: `step-${n}`,
      index: n,
      headline: `${f} × ${n} = ${f * n}`,
      title: `Count in ${COUNT_WORDS[f - 1]}!`,
      caption: `${n} group${n === 1 ? "" : "s"} of ${f} ${w.plural}`,
      group_count: n,
      objects_per_group: f,
      total_objects: f * n,
      icon: w.icon,
      alt: `${n} groups of ${f} ${w.plural}`,
    });
  }
  return slides;
}

export interface GeneratedItem {
  readonly question_version_key: string;
  readonly multiplier: number;
  readonly prompt: string;
  readonly options: readonly { id: string; label: string }[];
  readonly correct_option_id: string;
}

/** Stable key for "factor × n" in a given lesson version; distinct items per fact (TEL-006). */
export const multiplicationItemKey = (lessonVersionId: string, factor: number, n: number): string =>
  `${lessonVersionId}:mult-${factor}x${n}`;

/**
 * One item per fact. Options follow the live app's distractor scheme (±f, ±2f, ±3f, ±1),
 * always 4 unique positive values with exactly one correct; order is seeded, not Math.random.
 */
export function multiplicationItem(lessonVersionId: string, factor: number, n: number, seed: string): GeneratedItem {
  const correct = factor * n;
  const rand = mulberry32(hashSeed(`${seed}|${factor}x${n}`));
  const values = [correct];
  for (const d of shuffled([-factor * 3, -factor * 2, -factor, factor, factor * 2, factor * 3, 1, -1], rand)) {
    const v = correct + d;
    if (values.length < 4 && v > 0 && !values.includes(v)) values.push(v);
  }
  for (let z = 1; values.length < 4; z++) if (!values.includes(correct + z)) values.push(correct + z);
  const options = shuffled(values, rand).map((v) => ({ id: `opt-${v}`, label: String(v) }));
  return {
    question_version_key: multiplicationItemKey(lessonVersionId, factor, n),
    multiplier: n,
    prompt: `How many? ${n} groups of ${factor}`,
    options,
    correct_option_id: `opt-${correct}`,
  };
}

/**
 * Picks `count` items for an attempt, excluding keys already used in earlier stages
 * for this learner (baseline/immediate/delayed use different questions by default).
 * Returns fewer than `count` when the bank is exhausted — callers must report
 * `insufficient_items` rather than reuse silently.
 */
export function pickItems(allKeys: readonly string[], excludeKeys: ReadonlySet<string>, count: number, seed: string): string[] {
  const pool = allKeys.filter((k) => !excludeKeys.has(k));
  return shuffled(pool, mulberry32(hashSeed(seed))).slice(0, count);
}
