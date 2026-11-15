import { z } from "zod";
import { IsoDateTime, Uuid } from "./common";
import { ThemeKey } from "./catalog";
import { LegacyProfilesRoot } from "./legacy";

/** Progress identity is (learner, lesson, theme, attempt). A new attempt is an explicit restart. */
export const ProgressSyncRequest = z.object({
  learner_id: Uuid,
  lesson_id: Uuid,
  lesson_version_id: Uuid.optional(),
  theme_key: ThemeKey,
  attempt_id: Uuid,
  client_revision: z.number().int().min(0),
  base_server_revision: z.number().int().min(0).nullable(),
  slide_id: z.string().max(128).optional(),
  position_seconds: z.number().min(0).max(30).optional(),
  completed: z.boolean(),
  client_updated_at: IsoDateTime,
});
export type ProgressSyncRequest = z.infer<typeof ProgressSyncRequest>;

export const ProgressState = z.object({
  learner_id: Uuid,
  lesson_id: Uuid,
  lesson_version_id: Uuid.nullable(),
  theme_key: ThemeKey,
  attempt_id: Uuid,
  slide_id: z.string().nullable(),
  position_seconds: z.number(),
  completed: z.boolean(),
  server_revision: z.number().int().positive(),
  updated_at: IsoDateTime,
});
export type ProgressState = z.infer<typeof ProgressState>;

export const ProgressSyncResponse = z.object({
  outcome: z.enum(["applied", "merged", "stale_ignored"]),
  state: ProgressState,
});

/** Legacy import: device uploads the raw local snapshot; the server converts it idempotently. */
export const LegacyImportRequest = z.object({
  migration_run_id: Uuid,
  /** sha256 of the canonical JSON of `raw`, computed client-side, re-verified server-side. */
  legacy_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  raw: z.object({
    "breaknlearn.profiles.v1": LegacyProfilesRoot.nullable(),
    "breaknlearn.progress.v1": z.unknown().nullable(),
    "learnbreak-x3-v4-progress": z.unknown().nullable(),
  }),
  /** Guardian-confirmed mapping of local profile ids to server learner ids (ambiguity rule, M06). */
  profile_mapping: z.array(z.object({ local_profile_id: z.string().max(40), learner_id: Uuid })).max(2),
});
export type LegacyImportRequest = z.infer<typeof LegacyImportRequest>;

export const LegacyImportReceipt = z.object({
  migration_run_id: Uuid,
  outcome: z.enum(["imported", "already_imported"]),
  per_profile: z.array(
    z.object({
      local_profile_id: z.string(),
      learner_id: Uuid,
      entries_imported: z.number().int().min(0),
      entries_skipped_newer_on_server: z.number().int().min(0),
      entries_unrecognized: z.number().int().min(0),
    }),
  ),
});
