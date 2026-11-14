/**
 * Canonical catalog constants extracted verbatim from the live app snapshot
 * (legacy/live-snapshot-2026-11-14/index.html). Order is significant and is
 * covered by CAT-001/CAT-002 regression tests. Do not reorder.
 */
import { z } from "zod";

export interface SubjectDef {
  readonly key: string;
  readonly label: string;
  readonly icon: string;
  /** CISCE subjects vs. family enrichment subjects (spec M02). */
  readonly authority: "cisce" | "local_enrichment";
}

export const GRADE_SUBJECTS: Readonly<Record<2 | 6, readonly SubjectDef[]>> = {
  2: [
    { key: "english", label: "English", icon: "📖", authority: "cisce" },
    { key: "math", label: "Math", icon: "🔢", authority: "cisce" },
    { key: "tamil", label: "Tamil", icon: "🔤", authority: "cisce" },
    { key: "hindi", label: "Hindi", icon: "🪷", authority: "cisce" },
    { key: "science", label: "Science", icon: "🔬", authority: "cisce" },
    { key: "aadritha", label: "Aadritha", icon: "🪔", authority: "local_enrichment" },
    { key: "music", label: "Music", icon: "🎵", authority: "local_enrichment" },
  ],
  6: [
    { key: "english", label: "English", icon: "📖", authority: "cisce" },
    { key: "math", label: "Math", icon: "🔢", authority: "cisce" },
    { key: "tamil", label: "Tamil", icon: "🔤", authority: "cisce" },
    { key: "hindi", label: "Hindi", icon: "🪷", authority: "cisce" },
    { key: "physics", label: "Physics", icon: "🪐", authority: "cisce" },
    { key: "chemistry", label: "Chemistry", icon: "⚗️", authority: "cisce" },
    { key: "biology", label: "Biology", icon: "🧬", authority: "cisce" },
    { key: "history_civics", label: "History & Civics", icon: "🏛️", authority: "cisce" },
    { key: "geography", label: "Geography", icon: "🌎", authority: "cisce" },
    { key: "western_violin", label: "Western Violin", icon: "🎻", authority: "local_enrichment" },
    { key: "carnatic_violin", label: "Carnatic Violin", icon: "🎼", authority: "local_enrichment" },
    { key: "aadritha", label: "Aadritha", icon: "🪔", authority: "local_enrichment" },
  ],
};

export const SubjectKey = z.enum([
  "english", "math", "tamil", "hindi", "science", "aadritha", "music",
  "physics", "chemistry", "biology", "history_civics", "geography",
  "western_violin", "carnatic_violin",
]);
export type SubjectKey = z.infer<typeof SubjectKey>;

export interface WorldDef {
  readonly key: string;
  readonly name: string;
  readonly icon: string;
  readonly plural: string;
  readonly color: string;
}

/** The six picture worlds, in live order. */
export const WORLDS: readonly WorldDef[] = [
  { key: "puppy", name: "Puppy Park", icon: "🐶", plural: "puppies", color: "#6633a8" },
  { key: "candy", name: "Candy Land", icon: "🍬", plural: "candies", color: "#a64487" },
  { key: "unicorn", name: "Unicorn Sky", icon: "🦄", plural: "unicorns", color: "#5546b8" },
  { key: "school", name: "School Box", icon: "✏️", plural: "pencils", color: "#287ba1" },
  { key: "treat", name: "Treat Time", icon: "🍦", plural: "ice creams", color: "#986034" },
  { key: "farm", name: "Animal Farm", icon: "🐴", plural: "horses", color: "#4d8a60" },
];

export const ThemeKey = z.enum(["puppy", "candy", "unicorn", "school", "treat", "farm"]);
export type ThemeKey = z.infer<typeof ThemeKey>;

/** Live avatar emoji list (order preserved) mapped to stable avatar_id values. */
export const AVATARS: readonly { readonly id: string; readonly emoji: string }[] = [
  { id: "fox", emoji: "🦊" },
  { id: "dragon", emoji: "🐉" },
  { id: "unicorn", emoji: "🦄" },
  { id: "rocket", emoji: "🚀" },
  { id: "panda", emoji: "🐼" },
  { id: "lion", emoji: "🦁" },
  { id: "robot", emoji: "🤖" },
  { id: "superhero", emoji: "🦸" },
  { id: "tiger", emoji: "🐯" },
  { id: "astronaut", emoji: "🧑‍🚀" },
  { id: "butterfly", emoji: "🦋" },
  { id: "penguin", emoji: "🐧" },
];

export const AvatarId = z.enum([
  "fox", "dragon", "unicorn", "rocket", "panda", "lion",
  "robot", "superhero", "tiger", "astronaut", "butterfly", "penguin",
]);
export type AvatarId = z.infer<typeof AvatarId>;

export function avatarIdFromEmoji(emoji: string): AvatarId | null {
  const hit = AVATARS.find((a) => a.emoji === emoji);
  return hit ? (hit.id as AvatarId) : null;
}

/** Live lesson timing and quiz constants (TV-003, CAT-003). */
export const SECONDS_PER_SLIDE = 7;
export const FACTS_PER_TABLE = 10;
export const QUIZ_QUESTION_COUNT = 3;
export const QUIZ_OPTION_COUNT = 4;
export const MAX_PROFILES_PER_DEVICE = 2;

/** The ONLY lessons published at launch (CAT-005). */
export const MULTIPLICATION_TOPIC_KEY = "grade2.math.multiplication";
export const multiplicationLessonKey = (table: number): string =>
  `${MULTIPLICATION_TOPIC_KEY}.table-${table}`;
export const INITIAL_PUBLISHED_LESSON_KEYS: readonly string[] = Array.from(
  { length: 10 },
  (_, i) => multiplicationLessonKey(i + 1),
);

/**
 * Fixed ids (UUIDv5, namespace 6f1d2a0e-6b1e-4a35-9a4e-2f6c3b8d9e10, name = stable key)
 * so seeds, the student fallback catalog and legacy migration agree without a lookup.
 */
export const UUID_NAMESPACE = "6f1d2a0e-6b1e-4a35-9a4e-2f6c3b8d9e10";
export const MULTIPLICATION_TOPIC_ID = "58be84d6-b23e-5332-80a7-f7460dd3933f";
export const MULTIPLICATION_LESSON_IDS: Readonly<Record<number, string>> = {
  1: "02402664-c8e7-5408-ab92-292f6e20a308",
  2: "6a7999d7-caba-5778-87b0-34529b85fdb4",
  3: "f95143b0-7b4c-5452-8a3f-71096a538dff",
  4: "6dcc8a5d-23c4-5a87-8871-17db135101c5",
  5: "e13f93ea-9d02-5a12-bf91-b4fc6554f5a9",
  6: "34ed2bc4-a121-5847-998d-d5d7c227252a",
  7: "2b0028d9-dd24-5020-84f7-c75af77b7b39",
  8: "e2e6e8a9-7da3-540b-a802-346b53f12270",
  9: "a43a1ef5-01d2-5b95-bb56-868c672e70a0",
  10: "c888722d-7b0f-5dc2-b371-41b47d542367",
};
