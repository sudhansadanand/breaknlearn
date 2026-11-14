import { ThemeKey } from "@bnl/contracts";

/** Editable fields of a picture_groups_v1 lesson, kept as plain form state. */
export interface FormState {
  title: string;
  factor: number;
  themes: ThemeKey[];
  secondsPerSlide: number;
  quizCount: number;
  outcomeKeys: string;
  rightsType: "original_generated_content" | "licensed" | "public_domain" | "owner_supplied";
  rightsReviewed: boolean;
  attribution: string;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

export function defaultContent(stableKey: string, factor: number, title: string): Obj {
  return {
    contract_version: 1, stable_key: stableKey, grade: 2, subject_key: "math", topic_key: "grade2.math.multiplication",
    title, template: "picture_groups_v1",
    config: { factor, count_from: 1, count_to: 10, themes: [...ThemeKey.options], seconds_per_slide: 7, quiz_question_count: 3 },
    learning_outcome_keys: ["grade2.math.multiplication"], rights: { type: "original_generated_content", reviewed: false },
  };
}

export function toForm(content: unknown): FormState {
  const c = obj(content);
  const cfg = obj(c.config);
  const rights = obj(c.rights);
  const themes = Array.isArray(cfg.themes) ? cfg.themes.filter((t): t is ThemeKey => ThemeKey.safeParse(t).success) : [];
  const rt = rights.type;
  return {
    title: typeof c.title === "string" ? c.title : "",
    factor: num(cfg.factor, 1),
    themes,
    secondsPerSlide: num(cfg.seconds_per_slide, 7),
    quizCount: num(cfg.quiz_question_count, 3),
    outcomeKeys: Array.isArray(c.learning_outcome_keys) ? c.learning_outcome_keys.filter((k) => typeof k === "string").join("\n") : "",
    rightsType: rt === "licensed" || rt === "public_domain" || rt === "owner_supplied" ? rt : "original_generated_content",
    rightsReviewed: rights.reviewed === true,
    attribution: typeof rights.attribution === "string" ? rights.attribution : "",
  };
}

/** Applies form state onto the base content, keeping identity fields and any config it does not edit. */
export function fromForm(base: unknown, f: FormState): Obj {
  const c = obj(base);
  const cfg = obj(c.config);
  const ordered = ThemeKey.options.filter((t) => f.themes.includes(t));
  return {
    ...c,
    title: f.title,
    config: { ...cfg, factor: f.factor, themes: ordered, seconds_per_slide: f.secondsPerSlide, quiz_question_count: f.quizCount },
    learning_outcome_keys: f.outcomeKeys.split(/[\s,]+/).map((k) => k.trim()).filter(Boolean),
    rights: { type: f.rightsType, reviewed: f.rightsReviewed, ...(f.attribution.trim() ? { attribution: f.attribution.trim() } : {}) },
  };
}
