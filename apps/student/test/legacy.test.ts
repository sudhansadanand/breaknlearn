import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ensureLegacyBackup as pkgBackup, legacyFingerprint as pkgFingerprint } from "../../../packages/student-progress/src";
import { memoryStore } from "../src/util";
import { LEGACY_BACKUP_KEY, LEGACY_PROFILES_KEY, ensureLegacyBackup, legacyFingerprint, legacySnapshot, loadProfiles, persistProfiles, serializeProfiles } from "../src/legacy";
import { storeWith } from "./helpers";

const fixture = JSON.parse(readFileSync(new URL("../../../tests/fixtures/legacy/profiles-v1-two-children.json", import.meta.url), "utf8"));
const historical = JSON.parse(readFileSync(new URL("../../../tests/fixtures/legacy/historical-x3-keys.json", import.meta.url), "utf8"));
const PROFILES_TEXT = JSON.stringify(fixture[LEGACY_PROFILES_KEY]);
const HIST = { "breaknlearn.progress.v1": JSON.stringify(historical["breaknlearn.progress.v1"]), "learnbreak-x3-v4-progress": "not json {" };

/** What main.ts does on every launch before the UI writes: back up, load, persist once. */
function boot(store: ReturnType<typeof storeWith>, now: number) {
  ensureLegacyBackup(store, now);
  const loaded = loadProfiles(store);
  persistProfiles(store, loaded);
  return loaded;
}

describe("legacy backup (F1 safeguard)", () => {
  it("copies every legacy key verbatim (corrupt values included) in the @bnl/student-progress shape", () => {
    const store = storeWith({ [LEGACY_PROFILES_KEY]: PROFILES_TEXT, ...HIST });
    const b = ensureLegacyBackup(store, Date.UTC(2026, 10, 14));
    expect(b?.items).toEqual({ [LEGACY_PROFILES_KEY]: PROFILES_TEXT, ...HIST });
    const pkgStore = storeWith({ [LEGACY_PROFILES_KEY]: PROFILES_TEXT, ...HIST });
    const pb = pkgBackup(pkgStore, new Date(Date.UTC(2026, 10, 14)));
    expect(JSON.parse(store.getItem(LEGACY_BACKUP_KEY)!)).toEqual(pb);
  });

  it("never overwrites an existing backup, even an unreadable one", () => {
    const store = storeWith({ [LEGACY_PROFILES_KEY]: PROFILES_TEXT });
    ensureLegacyBackup(store, 1);
    const first = store.getItem(LEGACY_BACKUP_KEY);
    store.setItem(LEGACY_PROFILES_KEY, JSON.stringify({ profiles: [], activeId: null }));
    ensureLegacyBackup(store, 2);
    expect(store.getItem(LEGACY_BACKUP_KEY)).toBe(first);

    const corrupt = storeWith({ [LEGACY_BACKUP_KEY]: "{oops", [LEGACY_PROFILES_KEY]: PROFILES_TEXT });
    expect(ensureLegacyBackup(corrupt, 3)).toBeNull();
    expect(corrupt.getItem(LEGACY_BACKUP_KEY)).toBe("{oops");
  });

  it("records missing keys as null on a fresh device", () => {
    const store = storeWith({});
    expect(ensureLegacyBackup(store, 0)?.items).toEqual({ [LEGACY_PROFILES_KEY]: null, "breaknlearn.progress.v1": null, "learnbreak-x3-v4-progress": null });
  });
});

describe("profiles storage (live reading rules, F1 fix)", () => {
  it("shows exactly what the live filter shows", () => {
    const root = { profiles: [null, { id: "child-1", name: "", grade: 2, avatar: "🦊" }, fixture[LEGACY_PROFILES_KEY].profiles[0], { id: "x", name: "Old", grade: 3, avatar: "🐼" }, fixture[LEGACY_PROFILES_KEY].profiles[1], { id: "child-3", name: "Third", grade: 6, avatar: "🦁" }], activeId: "child-2", extraRoot: 1 };
    const loaded = loadProfiles(storeWith({ [LEGACY_PROFILES_KEY]: JSON.stringify(root) }));
    expect(loaded.state.profiles.map((p) => p?.name)).toEqual(["Asha", "Ravi"]);
    expect(loaded.hidden).toHaveLength(3);
    const written = JSON.parse(serializeProfiles(loaded));
    // F1: nothing the live filter hides is lost; visible ones first so the live app reads the same slots.
    expect(written.profiles.map((p: { name: string }) => p.name)).toEqual(["Asha", "Ravi", "", "Old", "Third"]);
    expect(written.extraRoot).toBe(1);
    expect(loadProfiles(storeWith({ [LEGACY_PROFILES_KEY]: JSON.stringify(written) })).state.profiles.map((p) => p?.name)).toEqual(["Asha", "Ravi"]);
  });

  it("falls back to an empty state for missing/corrupt roots, like the live app", () => {
    for (const v of [null, "nope", "null", "[]", '{"profiles":3}']) {
      const loaded = loadProfiles(storeWith({ [LEGACY_PROFILES_KEY]: v }));
      expect(loaded.state).toEqual({ profiles: [], activeId: null });
    }
  });
});

describe("migration idempotence (MIG-002/004)", () => {
  it("booting twice gives the same storage and an intact backup", () => {
    const store = storeWith({ [LEGACY_PROFILES_KEY]: PROFILES_TEXT, ...HIST });
    boot(store, 1000);
    const once = store.dump();
    boot(store, 2000);
    expect(store.dump()).toEqual(once);
    const backup = JSON.parse(once[LEGACY_BACKUP_KEY]!);
    expect(backup.items[LEGACY_PROFILES_KEY]).toBe(PROFILES_TEXT);
    expect(backup.items["learnbreak-x3-v4-progress"]).toBe("not json {");
    // historical keys are never modified by the app
    expect(once["breaknlearn.progress.v1"]).toBe(HIST["breaknlearn.progress.v1"]);
    expect(JSON.parse(once[LEGACY_PROFILES_KEY]!)).toEqual(fixture[LEGACY_PROFILES_KEY]);
  });

  it("legacy fingerprint equals @bnl/student-progress legacyFingerprint", async () => {
    const store = storeWith({ [LEGACY_PROFILES_KEY]: PROFILES_TEXT, ...HIST });
    const snap = legacySnapshot(store);
    expect(snap["learnbreak-x3-v4-progress"]).toBeNull();
    expect(legacyFingerprint(snap as unknown as Record<string, unknown>)).toBe(await pkgFingerprint(snap as unknown as Record<string, unknown>));
    const empty = legacySnapshot(memoryStore());
    expect(legacyFingerprint(empty as unknown as Record<string, unknown>)).toBe(await pkgFingerprint({}));
  });
});
