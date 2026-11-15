/**
 * ADR-0007: the item-bank key stored in `bnl.quiz_items` (A4 scheme `<stable_key>.fact-<m>.v<version_no>`,
 * option ids a..d) is canonical. `@bnl/lesson-engine`'s per-attempt generator uses another format
 * (`multiplicationItemKey` = `<lessonVersionId>:mult-<F>x<N>`, option ids `opt-<value>`). These helpers map an
 * engine key/option onto the stored bank row, so lesson-engine does not need to change and the server never
 * trusts a client-generated key on its own: the mapped key must exist in the bank of the same version.
 */
import { bankItemKey } from "@bnl/lesson-engine";

const ENGINE_KEY = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):mult-(\d{1,2})x(\d{1,2})$/i;

export interface EngineItemRef {
  readonly lessonVersionId: string;
  readonly factor: number;
  readonly multiplier: number;
}

/** Parses a lesson-engine `multiplicationItemKey`; null for anything else (including bank keys). */
export function parseEngineItemKey(key: string): EngineItemRef | null {
  const m = ENGINE_KEY.exec(key);
  if (!m) return null;
  return { lessonVersionId: (m[1] as string).toLowerCase(), factor: Number(m[2]), multiplier: Number(m[3]) };
}

export interface BankVersionRef {
  readonly lessonVersionId: string;
  readonly stableKey: string;
  readonly versionNo: number;
  /** picture_groups_v1 `config.factor`. */
  readonly factor: number;
}

/**
 * The canonical bank key for an engine key of the SAME version and factor; null otherwise. Bank keys pass
 * through unchanged, so callers can map unconditionally.
 */
export function toBankItemKey(key: string, version: BankVersionRef): string | null {
  const ref = parseEngineItemKey(key);
  if (!ref) return key;
  if (ref.lessonVersionId !== version.lessonVersionId.toLowerCase() || ref.factor !== version.factor) return null;
  return bankItemKey(version.stableKey, version.versionNo, ref.multiplier);
}

/** Maps an engine option id `opt-<value>` to the bank option with that label; other ids pass through. */
export function toBankOptionId(optionId: string, bankOptions: readonly { readonly id: string; readonly label: string }[]): string | null {
  const m = /^opt-(-?\d+)$/.exec(optionId);
  if (!m) return optionId;
  return bankOptions.find((o) => o.label === m[1])?.id ?? null;
}
