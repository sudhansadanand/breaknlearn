/**
 * Legacy localStorage compatibility (spec §10, M06; inventory F1).
 *
 * - `ensureLegacyBackup` copies every legacy key verbatim to `breaknlearn.legacy-backup.v1` before the
 *   new code writes anything, and never overwrites an existing backup (same shape as
 *   `ensureLegacyBackup` in @bnl/student-progress).
 * - `loadProfiles`/`serializeProfiles` reproduce the live app's view of `breaknlearn.profiles.v1`
 *   (filter `id && name && grade∈{2,6}`, first two) but, unlike the live app, the entries the filter
 *   hides are written back unchanged after the visible ones, so persisting never drops them (F1).
 */
import { canonicalJson, isArray, isObject, isoNow, parseJson, sha256Hex, type KeyValueStore } from "./util";

export const LEGACY_PROFILES_KEY = "breaknlearn.profiles.v1";
export const LEGACY_PROGRESS_KEYS = ["breaknlearn.progress.v1", "learnbreak-x3-v4-progress"];
export const LEGACY_BACKUP_KEY = "breaknlearn.legacy-backup.v1";
export const ALL_LEGACY_KEYS = [LEGACY_PROFILES_KEY].concat(LEGACY_PROGRESS_KEYS);

export interface LegacyBackup {
  version: 1;
  created_at: string;
  items: { [key: string]: string | null };
}

/**
 * Idempotent: if any value is already stored under the backup key (even one we cannot parse), it is
 * left untouched and the first-seen state stays preserved. Returns the backup in effect, or null when
 * an unreadable pre-existing backup was kept as is.
 */
export function ensureLegacyBackup(store: KeyValueStore, nowMs: number): LegacyBackup | null {
  const existing = store.getItem(LEGACY_BACKUP_KEY);
  if (existing !== null && existing !== "") {
    const parsed = parseJson(existing, null);
    if (isObject(parsed) && parsed.version === 1 && isObject(parsed.items)) return parsed as unknown as LegacyBackup;
    return null; // never overwrite, even if we do not understand it
  }
  const items: { [key: string]: string | null } = {};
  for (let i = 0; i < ALL_LEGACY_KEYS.length; i++) items[ALL_LEGACY_KEYS[i]] = store.getItem(ALL_LEGACY_KEYS[i]);
  const backup: LegacyBackup = { version: 1, created_at: isoNow(nowMs), items: items };
  store.setItem(LEGACY_BACKUP_KEY, JSON.stringify(backup));
  return backup;
}

export interface LessonEntry {
  topicId?: string;
  table?: number;
  slideId?: string;
  position?: number;
  complete?: boolean;
  updatedAt?: number;
  [extra: string]: unknown;
}

export interface LocalProfile {
  id: string;
  name: string;
  grade: number;
  avatar: string;
  lessons?: { [key: string]: LessonEntry };
  lastWorld?: string | null;
  lastTable?: number | null;
  musicEnabled?: boolean;
  [extra: string]: unknown;
}

export interface ProfilesState {
  /** Visible profiles exactly as the live app sees them (index = on-screen slot). May contain holes. */
  profiles: (LocalProfile | undefined)[];
  activeId: string | null;
  [extra: string]: unknown;
}

export interface LoadedProfiles {
  state: ProfilesState;
  /** Raw entries the live filter hides; written back unchanged (F1). */
  hidden: unknown[];
}

function visibleProfile(p: unknown): boolean {
  if (!isObject(p)) return false;
  return !!p.id && !!p.name && (p.grade === 2 || p.grade === 6);
}

/** Same reading rules as the live app's `read(STORE,…)` + filter + slice(0,2). */
export function loadProfiles(store: KeyValueStore): LoadedProfiles {
  const state = parseJson(store.getItem(LEGACY_PROFILES_KEY), null) as ProfilesState | null;
  if (!state || !isObject(state) || !isArray((state as { profiles?: unknown }).profiles)) {
    return { state: { profiles: [], activeId: null }, hidden: [] };
  }
  const raw = state.profiles as unknown[];
  const visible: LocalProfile[] = [];
  const hidden: unknown[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (visibleProfile(raw[i]) && visible.length < 2) visible.push(raw[i] as LocalProfile);
    else if (raw[i] !== null && raw[i] !== undefined) hidden.push(raw[i]);
  }
  state.profiles = visible;
  if (state.activeId === undefined) state.activeId = null;
  return { state: state, hidden: hidden };
}

/** The JSON text the app persists: visible profiles first, hidden legacy entries preserved after them. */
export function serializeProfiles(loaded: LoadedProfiles): string {
  const out: { [k: string]: unknown } = {};
  const s = loaded.state as unknown as { [k: string]: unknown };
  for (const k in s) if (Object.prototype.hasOwnProperty.call(s, k)) out[k] = s[k];
  const list: unknown[] = loaded.state.profiles.slice();
  for (let i = 0; i < loaded.hidden.length; i++) list.push(loaded.hidden[i]);
  out.profiles = list;
  return JSON.stringify(out);
}

export function persistProfiles(store: KeyValueStore, loaded: LoadedProfiles): void {
  try {
    store.setItem(LEGACY_PROFILES_KEY, serializeProfiles(loaded));
  } catch {
    /* storage full or blocked: keep playing (live behaviour) */
  }
}

export interface LegacySnapshot {
  "breaknlearn.profiles.v1": unknown;
  "breaknlearn.progress.v1": unknown;
  "learnbreak-x3-v4-progress": unknown;
}

/**
 * Snapshot for POST /progress/legacy-import: current values of the three legacy keys as parsed JSON
 * (missing/corrupt = null; a profiles root without a `profiles` array is sent as null because the
 * server contract cannot accept it; the verbatim text stays in the device backup).
 */
export function legacySnapshot(store: KeyValueStore): LegacySnapshot {
  const prof = parseJson(store.getItem(LEGACY_PROFILES_KEY), null);
  const snap: LegacySnapshot = {
    "breaknlearn.profiles.v1": isObject(prof) && isArray(prof.profiles) ? prof : null,
    "breaknlearn.progress.v1": parseJson(store.getItem(LEGACY_PROGRESS_KEYS[0]), null),
    "learnbreak-x3-v4-progress": parseJson(store.getItem(LEGACY_PROGRESS_KEYS[1]), null),
  };
  return snap;
}

/** Same as `legacyFingerprintInput` in @bnl/student-progress. */
export function legacyFingerprintInput(raw: { [k: string]: unknown }): string {
  const norm: { [k: string]: unknown } = {};
  for (let i = 0; i < ALL_LEGACY_KEYS.length; i++) {
    const k = ALL_LEGACY_KEYS[i];
    norm[k] = raw[k] === undefined || raw[k] === null ? null : raw[k];
  }
  return canonicalJson(norm);
}

/** Same value as `legacyFingerprint` in @bnl/student-progress, computed synchronously in pure JS. */
export function legacyFingerprint(raw: { [k: string]: unknown }): string {
  return sha256Hex(legacyFingerprintInput(raw));
}

/** Historical keys (×3 only, MIG-003) that hold at least one world-keyed entry. */
export function historicalEntryCount(snap: LegacySnapshot): number {
  const worlds = ["puppy", "candy", "unicorn", "school", "treat", "farm"];
  let n = 0;
  for (let i = 0; i < LEGACY_PROGRESS_KEYS.length; i++) {
    const v = (snap as unknown as { [k: string]: unknown })[LEGACY_PROGRESS_KEYS[i]];
    if (!isObject(v)) continue;
    for (const k in v) if (Object.prototype.hasOwnProperty.call(v, k) && isObject(v[k]) && worlds.indexOf(k) >= 0) n++;
  }
  return n;
}
