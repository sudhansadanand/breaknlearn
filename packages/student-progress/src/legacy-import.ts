/**
 * Legacy import planning (spec §10.3–10.4, MIG-002..004). Pure: the server supplies the guardian's
 * mapping, what it already stores and how attempt ids are derived; this returns the writes and the
 * receipt counts. Only learner_progress rows are ever produced: no sessions, events or quiz scores
 * are fabricated (MIG-010 / §10.3).
 */
import { LEGACY_PROFILES_KEY, LEGACY_PROGRESS_KEYS, type ThemeKey } from "@bnl/contracts";
import { canonicalJson, type LegacyConversion, type LegacyEntry } from "./legacy-convert";
import { mergeProgress, type IncomingProgress, type ServerProgress } from "./merge";

/** Receipt row id used for historical-key (×3, profile-less) entries a guardian explicitly assigned. */
export const HISTORICAL_LOCAL_PROFILE_ID = "legacy:historical";

/** Raw snapshot normalized to exactly the three legacy keys; a missing key is `null`. */
export function legacyFingerprintInput(raw: Readonly<Record<string, unknown>>): string {
  const norm: Record<string, unknown> = {};
  for (const k of [LEGACY_PROFILES_KEY, ...LEGACY_PROGRESS_KEYS]) norm[k] = raw[k] ?? null;
  return canonicalJson(norm);
}

/** sha256 hex of {@link legacyFingerprintInput}; WebCrypto, so it runs on the TV and on the server. */
export async function legacyFingerprint(raw: Readonly<Record<string, unknown>>): Promise<string> {
  const bytes = new TextEncoder().encode(legacyFingerprintInput(raw));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** "step-N" (or any id ending in digits) -> N; anything else -> 0 (orders before every real slide). */
export function slideIndexOf(slideId: string | null | undefined): number {
  const m = /(\d+)$/.exec(slideId ?? "");
  return m ? Number(m[1]) : 0;
}

export interface StoredProgressRow {
  readonly attempt_id: string;
  readonly slide_id: string | null;
  readonly position_seconds: number;
  readonly completed: boolean;
  readonly server_revision: number;
  readonly client_revision: number;
}

export interface ImportTarget {
  readonly learner_id: string;
  readonly lesson_id: string;
  readonly theme_key: ThemeKey;
}

export interface PlanInput {
  readonly conversion: LegacyConversion;
  /** Guardian-confirmed local_profile_id -> learner_id (already validated: one-to-one, in household). */
  readonly mapping: ReadonlyMap<string, string>;
  /** Learner the guardian explicitly assigned historical-key entries to; null = leave them unassigned. */
  readonly historicalLearnerId: string | null;
  readonly lessonIdForTable: (table: number) => string | null;
  readonly attemptIdFor: (t: ImportTarget) => string;
  /** Every stored row for the target (any attempt). */
  readonly existing: (t: ImportTarget) => readonly StoredProgressRow[];
}

export type PlannedWrite =
  | { readonly kind: "insert"; readonly target: ImportTarget; readonly attempt_id: string; readonly slide_id: string; readonly position_seconds: number; readonly completed: boolean }
  | { readonly kind: "update"; readonly target: ImportTarget; readonly attempt_id: string; readonly slide_id: string | null; readonly position_seconds: number; readonly completed: boolean; readonly expected_server_revision: number };

export interface ProfileCounts {
  readonly local_profile_id: string;
  readonly learner_id: string;
  entries_imported: number;
  entries_skipped_newer_on_server: number;
  entries_unrecognized: number;
}

export interface ImportPlan {
  readonly writes: PlannedWrite[];
  readonly per_profile: ProfileCounts[];
  readonly historical: { entries_found: number; entries_pending_assignment: number; entries_unrecognized: number };
}

interface Group {
  readonly target: ImportTarget;
  readonly owners: { readonly local_profile_id: string; readonly entry: LegacyEntry }[];
}

/** Does stored progress already cover the incoming legacy state? */
function covers(row: StoredProgressRow, inc: { slide_index: number; position_seconds: number; completed: boolean }): boolean {
  if (row.completed) return true;
  if (inc.completed) return false;
  const idx = slideIndexOf(row.slide_id);
  return idx > inc.slide_index || (idx === inc.slide_index && row.position_seconds >= inc.position_seconds);
}

export function planLegacyImport(input: PlanInput): ImportPlan {
  const counts = new Map<string, ProfileCounts>();
  const groups = new Map<string, Group>();
  const unrecognizedFor = (id: string) => input.conversion.unrecognized.filter((u) => u.source === LEGACY_PROFILES_KEY && u.key.startsWith(`${id}.`)).length;

  const owned: { local_profile_id: string; learner_id: string; entries: readonly LegacyEntry[] }[] = [];
  for (const p of input.conversion.profiles) {
    const learner = input.mapping.get(p.local_profile_id);
    if (learner) owned.push({ local_profile_id: p.local_profile_id, learner_id: learner, entries: p.entries });
  }
  if (input.historicalLearnerId && input.conversion.unassigned.length > 0) {
    owned.push({ local_profile_id: HISTORICAL_LOCAL_PROFILE_ID, learner_id: input.historicalLearnerId, entries: input.conversion.unassigned });
  }
  const historicalUnrecognized = input.conversion.unrecognized.filter((u) => u.source !== LEGACY_PROFILES_KEY).length;

  for (const o of owned) {
    const c: ProfileCounts = {
      local_profile_id: o.local_profile_id,
      learner_id: o.learner_id,
      entries_imported: 0,
      entries_skipped_newer_on_server: 0,
      entries_unrecognized: o.local_profile_id === HISTORICAL_LOCAL_PROFILE_ID ? historicalUnrecognized : unrecognizedFor(o.local_profile_id),
    };
    counts.set(o.local_profile_id, c);
    for (const entry of o.entries) {
      const lesson = input.lessonIdForTable(entry.table);
      if (!lesson) {
        c.entries_unrecognized++;
        continue;
      }
      const target: ImportTarget = { learner_id: o.learner_id, lesson_id: lesson, theme_key: entry.theme_key };
      const key = `${target.learner_id}|${target.lesson_id}|${target.theme_key}`;
      const g = groups.get(key) ?? { target, owners: [] };
      g.owners.push({ local_profile_id: o.local_profile_id, entry });
      groups.set(key, g);
    }
  }

  const writes: PlannedWrite[] = [];
  for (const g of groups.values()) {
    // Several legacy entries for one (learner, lesson, theme) fold into one state: furthest slide, completion sticky.
    let folded: ServerProgress | null = null;
    for (const { entry } of g.owners) {
      const inc: IncomingProgress = { slide_index: slideIndexOf(entry.slide_id), position_seconds: entry.position_seconds, completed: entry.completed, client_revision: 0, base_server_revision: folded?.server_revision ?? null };
      folded = mergeProgress(folded, inc).next;
    }
    if (!folded) continue;
    const slideId = `step-${folded.slide_index}`;
    const attempt = input.attemptIdFor(g.target);
    const stored = input.existing(g.target);
    const legacyRow = stored.find((r) => r.attempt_id === attempt) ?? null;
    let written = false;
    if (legacyRow) {
      const cur: ServerProgress = { slide_index: slideIndexOf(legacyRow.slide_id), position_seconds: legacyRow.position_seconds, completed: legacyRow.completed, server_revision: legacyRow.server_revision, client_revision: legacyRow.client_revision };
      const r = mergeProgress(cur, { slide_index: folded.slide_index, position_seconds: folded.position_seconds, completed: folded.completed, client_revision: legacyRow.client_revision, base_server_revision: legacyRow.server_revision });
      if (r.outcome !== "stale_ignored") {
        const keepSlide = r.next.slide_index === cur.slide_index && r.next.position_seconds === cur.position_seconds;
        writes.push({ kind: "update", target: g.target, attempt_id: attempt, slide_id: keepSlide ? legacyRow.slide_id : `step-${r.next.slide_index}`, position_seconds: r.next.position_seconds, completed: r.next.completed, expected_server_revision: legacyRow.server_revision });
        written = true;
      }
    } else if (!stored.some((r) => covers(r, folded))) {
      writes.push({ kind: "insert", target: g.target, attempt_id: attempt, slide_id: slideId, position_seconds: folded.position_seconds, completed: folded.completed });
      written = true;
    }
    for (const { local_profile_id } of g.owners) {
      const c = counts.get(local_profile_id);
      if (!c) continue;
      if (written) c.entries_imported++;
      else c.entries_skipped_newer_on_server++;
    }
  }

  const historicalAssigned = input.historicalLearnerId !== null && input.conversion.unassigned.length > 0;
  return {
    writes,
    per_profile: [...counts.values()],
    historical: {
      entries_found: input.conversion.unassigned.length,
      entries_pending_assignment: historicalAssigned ? 0 : input.conversion.unassigned.length,
      entries_unrecognized: historicalUnrecognized,
    },
  };
}
