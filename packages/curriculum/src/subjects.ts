import { GRADE_SUBJECTS, type SubjectKey } from "@bnl/contracts";
import type { Grade } from "./types";

const ALIASES: Readonly<Record<string, string>> = {
  maths: "math",
  mathematics: "math",
  "history and civics": "history_civics",
  "history & civics": "history_civics",
  history: "history_civics",
  "western violin": "western_violin",
  "carnatic violin": "carnatic_violin",
};

/** Maps a CSV subject cell (key, label or common alias, any case) to the grade's SubjectKey, or null. */
export function subjectKeyFor(grade: Grade, raw: string): SubjectKey | null {
  const v = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!v) return null;
  const aliased = ALIASES[v] ?? v;
  const found = GRADE_SUBJECTS[grade].find((s) => s.key === aliased || s.label.toLowerCase() === aliased || s.key === aliased.replace(/ /g, "_"));
  return found ? (found.key as SubjectKey) : null;
}

export function isSubjectOfGrade(grade: Grade, key: string): key is SubjectKey {
  return GRADE_SUBJECTS[grade].some((s) => s.key === key);
}
