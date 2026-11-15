/**
 * Device-side safeguard (finding F1): copy every legacy key verbatim before any new code writes.
 * Idempotent: an existing backup is never overwritten, so the first-seen state is preserved.
 */
import { LEGACY_BACKUP_KEY, LEGACY_PROFILES_KEY, LEGACY_PROGRESS_KEYS } from "@bnl/contracts";

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface LegacyBackup {
  readonly version: 1;
  readonly created_at: string;
  readonly items: Record<string, string | null>;
}

export function ensureLegacyBackup(store: KeyValueStore, now: Date = new Date()): LegacyBackup {
  const existing = store.getItem(LEGACY_BACKUP_KEY);
  if (existing) {
    const parsed = JSON.parse(existing) as LegacyBackup;
    if (parsed && parsed.version === 1 && parsed.items) return parsed;
  }
  const items: Record<string, string | null> = {};
  for (const k of [LEGACY_PROFILES_KEY, ...LEGACY_PROGRESS_KEYS]) items[k] = store.getItem(k);
  const backup: LegacyBackup = { version: 1, created_at: now.toISOString(), items };
  store.setItem(LEGACY_BACKUP_KEY, JSON.stringify(backup));
  return backup;
}
