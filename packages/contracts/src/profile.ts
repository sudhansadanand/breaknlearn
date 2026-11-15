import { z } from "zod";
import { Grade, IsoDateTime, Uuid } from "./common";
import { AvatarId, ThemeKey } from "./catalog";

export const DisplayName = z
  .string()
  .trim()
  .min(1)
  .max(30)
  // No markup or control characters; names are rendered as text only.
  // eslint-disable-next-line no-control-regex -- intentionally rejecting control characters
  .regex(/^[^<>\u0000-\u001f\u007f]+$/u, "display_name contains disallowed characters");

export const ProfilePreferences = z.object({
  music_enabled: z.boolean().default(true),
  last_theme_key: ThemeKey.nullable().default(null),
  last_table: z.number().int().min(1).max(10).nullable().default(null),
});

export const Profile = z.object({
  id: Uuid,
  slot: z.union([z.literal(1), z.literal(2)]),
  display_name: DisplayName,
  grade: Grade,
  avatar_id: AvatarId,
  preferences: ProfilePreferences.optional(),
  updated_at: IsoDateTime.optional(),
});
export type Profile = z.infer<typeof Profile>;

export const ProfileList = z.object({ profiles: z.array(Profile).max(2) });

export const ProfileUpsert = Profile.omit({ updated_at: true });
