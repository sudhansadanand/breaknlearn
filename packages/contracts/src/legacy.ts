/**
 * Shapes of data the live student app keeps in localStorage, as observed in
 * legacy/live-snapshot-2026-11-14/index.html. Parsers are deliberately lenient
 * (passthrough) because real devices may hold older variants; never throw away
 * unknown fields — the raw JSON is always backed up before migration.
 */
import { z } from "zod";

export const LEGACY_PROFILES_KEY = "breaknlearn.profiles.v1";
/** Historical keys named in the spec. The live code no longer reads them. */
export const LEGACY_PROGRESS_KEYS = ["breaknlearn.progress.v1", "learnbreak-x3-v4-progress"] as const;
/** Where the new client stores an untouched copy of every legacy key before migrating. */
export const LEGACY_BACKUP_KEY = "breaknlearn.legacy-backup.v1";

/** One lesson-progress entry. Key `times-<table>:<world>`; bare `<world>` = old ×3 format. */
export const LegacyLessonEntry = z
  .object({
    topicId: z.string().optional(),
    table: z.number().int().min(1).max(10).optional(),
    slideId: z.string().optional(), // "step-N" (current) or "three-N" (old ×3 app)
    position: z.number().optional(), // seconds into slide, 0..7
    complete: z.boolean().optional(),
    updatedAt: z.number().optional(), // epoch ms, device clock (untrusted)
  })
  .passthrough();
export type LegacyLessonEntry = z.infer<typeof LegacyLessonEntry>;

export const LegacyProfile = z
  .object({
    id: z.string(), // "child-1" | "child-2"
    name: z.string(),
    grade: z.number(),
    avatar: z.string(), // emoji
    lessons: z.record(LegacyLessonEntry).optional(),
    lastWorld: z.string().nullable().optional(),
    lastTable: z.number().nullable().optional(),
    musicEnabled: z.boolean().optional(),
  })
  .passthrough();
export type LegacyProfile = z.infer<typeof LegacyProfile>;

export const LegacyProfilesRoot = z
  .object({
    profiles: z.array(z.unknown()),
    activeId: z.string().nullable().optional(),
  })
  .passthrough();

/** Parse a lesson-progress key into table + world. Bare world keys are the old ×3 format. */
export function parseLegacyLessonKey(
  key: string,
  entry: LegacyLessonEntry,
): { table: number; world: string } | null {
  const m = /^times-(\d{1,2}):([a-z]+)$/.exec(key);
  if (m) {
    const table = Number(m[1]);
    return table >= 1 && table <= 10 ? { table, world: m[2] as string } : null;
  }
  if (/^[a-z]+$/.test(key)) {
    // MIG-003: bare world keys come from the ×3-only app. The live code reads them
    // only for table 3, so they map ONLY to ×3 regardless of any `table` field.
    void entry;
    return { table: 3, world: key };
  }
  return null;
}

/** Live `number()` logic: digits after any non-digit prefix, 1..10, else 1. */
export function legacySlideNumber(entry: LegacyLessonEntry | null | undefined): number {
  if (!entry) return 1;
  const n = parseInt(String(entry.slideId ?? "three-1").replace(/^[^0-9]*/, ""), 10);
  return n >= 1 && n <= 10 ? n : 1;
}
