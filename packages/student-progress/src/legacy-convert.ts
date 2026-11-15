/**
 * Converts the live app's localStorage into normalized progress entries (spec §10, MIG-002..004).
 * Never fabricates sessions, scores or completions; unknown shapes are counted, not guessed.
 */
import {
  LEGACY_PROFILES_KEY,
  LEGACY_PROGRESS_KEYS,
  LegacyLessonEntry,
  LegacyProfile,
  LegacyProfilesRoot,
  ThemeKey,
  avatarIdFromEmoji,
  legacySlideNumber,
  parseLegacyLessonKey,
  type AvatarId,
} from "@bnl/contracts";

export interface LegacyEntry {
  readonly table: number;
  readonly theme_key: ThemeKey;
  readonly slide_id: string; // normalized "step-N"
  readonly position_seconds: number;
  readonly completed: boolean;
  /** Device clock; informational only. */
  readonly client_updated_at: string | null;
  readonly source_key: string;
  readonly source: "profiles.v1" | "breaknlearn.progress.v1" | "learnbreak-x3-v4-progress";
}

export interface LegacyProfileOut {
  readonly local_profile_id: string;
  readonly slot: 1 | 2;
  readonly display_name: string;
  readonly grade: 2 | 6;
  readonly avatar_id: AvatarId;
  readonly preferences: { music_enabled: boolean; last_theme_key: ThemeKey | null; last_table: number | null };
  readonly entries: LegacyEntry[];
}

export interface LegacyConversion {
  readonly profiles: LegacyProfileOut[];
  /** Entries from historical keys that belong to no profile; need guardian assignment (M06 ambiguity rule). */
  readonly unassigned: LegacyEntry[];
  readonly unrecognized: { readonly source: string; readonly key: string; readonly reason: string }[];
}

const themeOf = (w: string): ThemeKey | null => (ThemeKey.safeParse(w).success ? (w as ThemeKey) : null);

function toEntry(key: string, raw: unknown, source: LegacyEntry["source"], forceX3: boolean): LegacyEntry | string {
  const e = LegacyLessonEntry.safeParse(raw);
  if (!e.success) return "entry shape not recognized";
  const parsed = forceX3 ? (/^[a-z]+$/.test(key) ? { table: 3, world: key } : null) : parseLegacyLessonKey(key, e.data);
  if (!parsed) return "key not recognized";
  const theme = themeOf(parsed.world);
  if (!theme) return "unknown world";
  const pos = Number(e.data.position);
  return {
    table: parsed.table,
    theme_key: theme,
    slide_id: `step-${legacySlideNumber(e.data)}`,
    position_seconds: Number.isFinite(pos) ? Math.max(0, Math.min(7, pos)) : 0,
    completed: e.data.complete === true,
    client_updated_at: typeof e.data.updatedAt === "number" && Number.isFinite(e.data.updatedAt) ? new Date(e.data.updatedAt).toISOString() : null,
    source_key: key,
    source,
  };
}

export function convertLegacy(raw: Record<string, unknown>): LegacyConversion {
  const profiles: LegacyProfileOut[] = [];
  const unassigned: LegacyEntry[] = [];
  const unrecognized: { source: string; key: string; reason: string }[] = [];

  const root = LegacyProfilesRoot.safeParse(raw[LEGACY_PROFILES_KEY]);
  if (raw[LEGACY_PROFILES_KEY] != null && !root.success) unrecognized.push({ source: LEGACY_PROFILES_KEY, key: "(root)", reason: "root shape not recognized" });
  if (root.success) {
    root.data.profiles.forEach((p, i) => {
      const lp = LegacyProfile.safeParse(p);
      if (!lp.success) {
        unrecognized.push({ source: LEGACY_PROFILES_KEY, key: `profiles[${i}]`, reason: "profile shape not recognized" });
        return;
      }
      const slotMatch = /^child-([12])$/.exec(lp.data.id);
      const slot = slotMatch ? (Number(slotMatch[1]) as 1 | 2) : null;
      const grade = lp.data.grade === 2 || lp.data.grade === 6 ? lp.data.grade : null;
      const avatar = avatarIdFromEmoji(lp.data.avatar);
      // F1: the live app drops these on its next save; we keep them visible as unrecognized instead of losing them.
      if (!slot || !grade || !lp.data.name.trim()) {
        unrecognized.push({ source: LEGACY_PROFILES_KEY, key: `profiles[${i}]`, reason: "invalid id/grade/name (kept in backup)" });
        return;
      }
      const entries: LegacyEntry[] = [];
      for (const [k, v] of Object.entries(lp.data.lessons ?? {})) {
        const r = toEntry(k, v, "profiles.v1", false);
        if (typeof r === "string") unrecognized.push({ source: LEGACY_PROFILES_KEY, key: `${lp.data.id}.${k}`, reason: r });
        else entries.push(r);
      }
      profiles.push({
        local_profile_id: lp.data.id,
        slot,
        display_name: lp.data.name.trim().slice(0, 30),
        grade,
        avatar_id: avatar ?? "fox",
        preferences: {
          music_enabled: lp.data.musicEnabled !== false,
          last_theme_key: lp.data.lastWorld ? themeOf(lp.data.lastWorld) : null,
          last_table: typeof lp.data.lastTable === "number" && lp.data.lastTable >= 1 && lp.data.lastTable <= 10 ? lp.data.lastTable : null,
        },
        entries,
      });
      if (!avatar) unrecognized.push({ source: LEGACY_PROFILES_KEY, key: `${lp.data.id}.avatar`, reason: "unknown avatar, defaulted to fox" });
    });
  }

  for (const key of LEGACY_PROGRESS_KEYS) {
    const v = raw[key];
    if (v == null) continue;
    if (typeof v !== "object" || Array.isArray(v)) {
      unrecognized.push({ source: key, key: "(root)", reason: "not an object" });
      continue;
    }
    for (const [k, entry] of Object.entries(v as Record<string, unknown>)) {
      const r = toEntry(k, entry, key, true); // historical keys: ×3 only (MIG-003)
      if (typeof r === "string") unrecognized.push({ source: key, key: k, reason: r });
      else unassigned.push(r);
    }
  }
  return { profiles: profiles.sort((a, b) => a.slot - b.slot), unassigned, unrecognized };
}

/** Canonical JSON (sorted keys) used for the legacy fingerprint; sha256 is computed by the caller's crypto. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}
