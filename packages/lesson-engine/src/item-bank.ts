import { LessonContent, PictureGroupsConfig, WORLDS, type ThemeKey } from "@bnl/contracts";
import { renderPictureGroups, type PictureSlide } from "./picture-groups";

/**
 * Item bank for picture_groups_v1 versions (bnl.quiz_items rows).
 *
 * This is the SAME scheme as supabase/seed/0002_multiplication_lessons.sql and the SQL backstop
 * `bnl.generate_picture_groups_items` (0005): one item per fact `factor × m` for m in
 * count_from..count_to, four distinct positive options with ids a..d, exactly one correct.
 * The integration suite asserts byte-equality with the seeded rows.
 *
 * Note: {@link multiplicationItem} / `multiplicationItemKey` (`<versionId>:mult-FxN`, ids `opt-V`)
 * are a different, per-attempt scheme and are NOT used for bank rows.
 */
export interface BankItem {
  readonly question_version_key: string;
  readonly outcome_key: string;
  readonly stage_eligibility: readonly ("baseline" | "immediate" | "delayed")[];
  readonly prompt: string;
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly correct_option_id: string;
  readonly sort_order: number;
}

export type PublicBankItem = Omit<BankItem, "correct_option_id">;

const OPTION_IDS = ["a", "b", "c", "d"] as const;
export const MAX_QUESTION_KEY_LENGTH = 128;

/** `<stable_key>.fact-<m>.v<version_no>` — globally unique per version (seed format). */
export const bankItemKey = (stableKey: string, versionNo: number, m: number): string => `${stableKey}.fact-${m}.v${versionNo}`;

/** One fact, exactly as the seed builds it. */
export function bankMultiplicationItem(p: { stableKey: string; versionNo: number; outcomeKey: string; factor: number; m: number }): BankItem {
  const n = p.factor;
  const m = p.m;
  const a = n * m;
  const distractors: number[] = [];
  for (const cand of [a + n, a - n, a + 1, a - 1, a + 2, a - 2, a + n + 1, a + 3, a + 4, a + 5]) {
    if (cand > 0 && cand !== a && !distractors.includes(cand) && distractors.length < 3) distractors.push(cand);
  }
  const correctPos = ((n + m) % 4) + 1; // 1-based, as in SQL
  const values = [...distractors.slice(0, correctPos - 1), a, ...distractors.slice(correctPos - 1, 3)];
  const options = values.map((v, i) => ({ id: OPTION_IDS[i] as string, label: String(v) }));
  return {
    question_version_key: bankItemKey(p.stableKey, p.versionNo, m),
    outcome_key: p.outcomeKey,
    stage_eligibility: ["baseline", "immediate", "delayed"],
    prompt: `${n} × ${m} = ?`,
    options,
    correct_option_id: OPTION_IDS[correctPos - 1] as string,
    sort_order: m,
  };
}

/**
 * All bank items for a version's content, or `null` when the content is not a renderable
 * picture_groups_v1 lesson (invalid drafts have no items until fixed).
 */
export function bankItemsForContent(rawContent: unknown, versionNo: number): BankItem[] | null {
  const content = LessonContent.safeParse(rawContent);
  if (!content.success || content.data.template !== "picture_groups_v1") return null;
  const cfg = PictureGroupsConfig.safeParse(content.data.config);
  if (!cfg.success || cfg.data.count_from > cfg.data.count_to) return null;
  const outcomeKey = content.data.learning_outcome_keys[0] ?? content.data.topic_key;
  const items: BankItem[] = [];
  for (let m = cfg.data.count_from; m <= cfg.data.count_to; m++) {
    items.push(bankMultiplicationItem({ stableKey: content.data.stable_key, versionNo, outcomeKey, factor: cfg.data.factor, m }));
  }
  if (items.some((i) => i.question_version_key.length > MAX_QUESTION_KEY_LENGTH)) return null;
  return items;
}

/** Answer keys are server-only (ADR-0002 C3). */
export function withoutAnswerKey(item: BankItem): PublicBankItem {
  const { correct_option_id: _omit, ...rest } = item;
  return rest;
}

export interface ThemePreview {
  readonly theme_key: ThemeKey;
  readonly name: string;
  readonly icon: string;
  readonly color: string;
  readonly slides: PictureSlide[];
}

/** Slides for every enabled world, or `null` if the content cannot be rendered. */
export function previewPictureGroups(rawContent: unknown): ThemePreview[] | null {
  const content = LessonContent.safeParse(rawContent);
  if (!content.success || content.data.template !== "picture_groups_v1") return null;
  const cfg = PictureGroupsConfig.safeParse(content.data.config);
  if (!cfg.success || cfg.data.count_from > cfg.data.count_to) return null;
  const out: ThemePreview[] = [];
  for (const key of new Set(cfg.data.themes)) {
    const w = WORLDS.find((x) => x.key === key);
    if (!w) return null;
    out.push({ theme_key: key, name: w.name, icon: w.icon, color: w.color, slides: renderPictureGroups(cfg.data, key) });
  }
  return out;
}
