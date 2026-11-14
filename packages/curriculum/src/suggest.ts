/**
 * Deterministic chapter → canonical topic suggestions (spec M03). No model calls, no network:
 * normalised token overlap plus grade/subject agreement. Suggestions are only candidates for a
 * human decision; nothing here approves or publishes anything.
 */
import type { Grade } from "./types";

export interface CandidateNode {
  readonly id: string;
  readonly stableKey: string;
  readonly grade: Grade;
  readonly subjectKey: string;
  readonly title: string;
}

export interface ChapterInput {
  readonly title: string;
  readonly grade: Grade;
  readonly subjectKey: string;
}

export interface Suggestion {
  readonly curriculumNodeId: string;
  readonly stableKey: string;
  /** 0..1, rounded to 3 decimals. */
  readonly confidence: number;
}

export interface SuggestOptions {
  /** Minimum confidence to keep a suggestion (default 0.2). */
  readonly threshold?: number;
  /** Maximum suggestions per chapter (default 3). */
  readonly limit?: number;
  /** Extra canonical-term synonyms (stem → stem), merged over the defaults. */
  readonly synonyms?: Readonly<Record<string, string>>;
}

export const DEFAULT_THRESHOLD = 0.2;

const STOPWORDS = new Set(
  "a an and the of in on at to for with from by into our my your their its is are be as or about up down out over under we us you it this that these those chapter unit lesson part let lets let's fun learn learning".split(
    " ",
  ),
);

/** Small domain thesaurus applied after stemming: maps school-book wording onto canonical topic terms. */
export const DEFAULT_SYNONYMS: Readonly<Record<string, string>> = {
  shape: "geometry",
  solid: "geometry",
  angle: "geometry",
  line: "geometry",
  triangle: "geometry",
  circle: "geometry",
  symmetry: "geometry",
  length: "measurement",
  weight: "measurement",
  mass: "measurement",
  capacity: "measurement",
  measure: "measurement",
  time: "measurement",
  clock: "measurement",
  money: "measurement",
  graph: "data",
  chart: "data",
  pictograph: "data",
  table: "multiplication",
  times: "multiplication",
  multiply: "multiplication",
  addition: "number",
  add: "number",
  subtraction: "number",
  subtract: "number",
  numeral: "number",
  digit: "number",
  place: "number",
  division: "number",
  divide: "number",
  integer: "number",
  fraction: "number",
  decimal: "number",
  area: "mensuration",
  perimeter: "mensuration",
  volume: "mensuration",
  equation: "algebra",
  expression: "algebra",
  ratio: "ratio",
  proportion: "ratio",
  poem: "reading",
  story: "reading",
  comprehension: "reading",
  noun: "grammar",
  verb: "grammar",
  adjective: "grammar",
  pronoun: "grammar",
  tense: "grammar",
  composition: "writing",
  essay: "writing",
  letter: "writing",
  plant: "plant",
  animal: "animal",
};

/** Lower-case, strip accents and punctuation, drop stopwords and digits, light suffix stemming, synonyms. */
export function normalizeTokens(title: string, synonyms: Readonly<Record<string, string>> = DEFAULT_SYNONYMS): string[] {
  const words = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !STOPWORDS.has(w) && !/^\d+$/.test(w) && !/^[ivxlc]+$/.test(w));
  const out = new Set<string>();
  for (const w of words) {
    const s = stem(w);
    if (s.length < 2) continue;
    out.add(synonyms[s] ?? s);
  }
  return [...out];
}

/** Deliberately simple, deterministic English suffix stripping. */
export function stem(w: string): string {
  if (w.length <= 3) return w;
  const rules: [RegExp, string][] = [
    [/ies$/, "y"],
    [/(ss|sh|ch|x)es$/, "$1"],
    [/([^s])s$/, "$1"],
    [/ing$/, ""],
    [/ed$/, ""],
  ];
  for (const [re, rep] of rules) {
    if (re.test(w)) {
      const r = w.replace(re, rep);
      if (r.length >= 3) return r;
    }
  }
  return w;
}

/** Score in 0..1: mean of Dice overlap and coverage of the node's tokens, times a grade/subject factor. */
export function scorePair(chapterTokens: readonly string[], nodeTokens: readonly string[], sameSubject: boolean): number {
  if (chapterTokens.length === 0 || nodeTokens.length === 0) return 0;
  const a = new Set(chapterTokens);
  let overlap = 0;
  for (const t of new Set(nodeTokens)) if (a.has(t)) overlap++;
  if (overlap === 0) return 0;
  const dice = (2 * overlap) / (a.size + new Set(nodeTokens).size);
  const coverage = overlap / new Set(nodeTokens).size;
  const raw = 0.5 * dice + 0.5 * coverage;
  return raw * (sameSubject ? 1 : 0.5);
}

/**
 * Top-N suggestions for one chapter among same-grade candidate nodes (many-to-many allowed:
 * a chapter may get several topics, and a topic may be suggested for several chapters).
 * Ties break by stable_key, so output is fully deterministic.
 */
export function suggestForChapter(chapter: ChapterInput, nodes: readonly CandidateNode[], options: SuggestOptions = {}): Suggestion[] {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const limit = options.limit ?? 3;
  const synonyms = { ...DEFAULT_SYNONYMS, ...(options.synonyms ?? {}) };
  const ct = normalizeTokens(chapter.title.replace(/^'/, ""), synonyms);
  const scored: Suggestion[] = [];
  for (const n of nodes) {
    if (n.grade !== chapter.grade) continue;
    const confidence = Math.round(Math.min(1, scorePair(ct, normalizeTokens(n.title, synonyms), n.subjectKey === chapter.subjectKey)) * 1000) / 1000;
    if (confidence >= threshold && confidence > 0) scored.push({ curriculumNodeId: n.id, stableKey: n.stableKey, confidence });
  }
  scored.sort((x, y) => y.confidence - x.confidence || (x.stableKey < y.stableKey ? -1 : x.stableKey > y.stableKey ? 1 : 0));
  return scored.slice(0, limit);
}
