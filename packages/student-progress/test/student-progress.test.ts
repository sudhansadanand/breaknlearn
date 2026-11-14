import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LEGACY_BACKUP_KEY } from "@bnl/contracts";
import { canonicalJson, convertLegacy, ensureLegacyBackup, mergeProgress } from "../src";

const fx = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../tests/fixtures/legacy/${name}`, import.meta.url)), "utf8"));

describe("legacy conversion", () => {
  it("MIG-002: preserves both profiles, names, grades, avatars, prefs and per-table/per-world entries", () => {
    const c = convertLegacy(fx("profiles-v1-two-children.json"));
    expect(c.profiles.map((p) => [p.local_profile_id, p.slot, p.display_name, p.grade, p.avatar_id])).toEqual([
      ["child-1", 1, "Asha", 2, "fox"],
      ["child-2", 2, "Ravi", 6, "astronaut"],
    ]);
    expect(c.profiles[1]!.preferences).toEqual({ music_enabled: false, last_theme_key: "unicorn", last_table: 3 });
    const asha = Object.fromEntries(c.profiles[0]!.entries.map((e) => [e.source_key, e]));
    expect(asha["times-1:puppy"]).toMatchObject({ table: 1, theme_key: "puppy", slide_id: "step-10", completed: true });
    expect(asha["times-3:candy"]).toMatchObject({ table: 3, theme_key: "candy", slide_id: "step-4", position_seconds: 3.2, completed: false });
    expect(asha["farm"]).toMatchObject({ table: 3, theme_key: "farm", slide_id: "step-6" }); // "three-6" normalized, x3 only
    expect(c.unrecognized).toEqual([]);
  });

  it("MIG-003: historical keys map only to x3 and are not silently assigned to a child", () => {
    const c = convertLegacy(fx("historical-x3-keys.json"));
    expect(c.profiles).toEqual([]);
    expect(c.unassigned.map((e) => [e.source, e.table, e.theme_key, e.slide_id, e.completed])).toEqual([
      ["breaknlearn.progress.v1", 3, "puppy", "step-5", false],
      ["learnbreak-x3-v4-progress", 3, "school", "step-10", true],
    ]);
  });

  it("F1: invalid profiles and odd shapes are reported, never dropped silently or guessed", () => {
    const c = convertLegacy({
      "breaknlearn.profiles.v1": { profiles: [{ id: "child-1", name: "A", grade: 4, avatar: "🦊" }, { id: "child-2", name: "B", grade: 2, avatar: "👽", lessons: { "times-99:puppy": {}, "times-2:moon": {} } }], activeId: null },
      "breaknlearn.progress.v1": "corrupt",
      "learnbreak-x3-v4-progress": null,
    });
    expect(c.profiles).toHaveLength(1);
    expect(c.profiles[0]!.avatar_id).toBe("fox");
    expect(c.unrecognized.map((u) => u.reason)).toEqual(
      expect.arrayContaining(["invalid id/grade/name (kept in backup)", "key not recognized", "unknown world", "not an object", "unknown avatar, defaulted to fox"]),
    );
  });

  it("canonical JSON is key-order independent (stable fingerprint input)", () => {
    expect(canonicalJson({ b: 1, a: [{ y: 2, x: 1 }] })).toBe(canonicalJson({ a: [{ x: 1, y: 2 }], b: 1 }));
  });
});

describe("backup before write", () => {
  it("copies every legacy key verbatim once and never overwrites the first backup", () => {
    const data = new Map<string, string>([["breaknlearn.profiles.v1", '{"profiles":[],"activeId":null}']]);
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    const b1 = ensureLegacyBackup(store, new Date("2026-11-14T00:00:00Z"));
    data.set("breaknlearn.profiles.v1", "changed");
    const b2 = ensureLegacyBackup(store, new Date("2026-12-01T00:00:00Z"));
    expect(b2).toEqual(b1);
    expect(JSON.parse(data.get(LEGACY_BACKUP_KEY)!).items["breaknlearn.profiles.v1"]).toBe('{"profiles":[],"activeId":null}');
  });
});

describe("progress merge", () => {
  const inc = (slide: number, completed: boolean, client_revision: number, base: number | null) => ({ slide_index: slide, position_seconds: 0, completed, client_revision, base_server_revision: base });
  it("first write applies at revision 1", () => expect(mergeProgress(null, inc(3, false, 1, null))).toMatchObject({ outcome: "applied", next: { server_revision: 1, slide_index: 3 } }));
  it("forward progress on the current base applies", () => {
    const r = mergeProgress({ slide_index: 3, position_seconds: 0, completed: false, server_revision: 1, client_revision: 1 }, inc(5, false, 2, 1));
    expect(r).toMatchObject({ outcome: "applied", next: { slide_index: 5, server_revision: 2 } });
  });
  it("MIG-004 / MIG-006: stale or replayed older state never rolls back newer progress or completion", () => {
    const done = { slide_index: 10, position_seconds: 0, completed: true, server_revision: 4, client_revision: 7 };
    expect(mergeProgress(done, inc(2, false, 3, 1)).outcome).toBe("stale_ignored");
    expect(mergeProgress(done, inc(2, false, 9, 1)).next.completed).toBe(true);
    expect(mergeProgress(done, inc(10, true, 7, 4)).outcome).toBe("stale_ignored"); // identical replay
  });
  it("concurrent device with an old base merges to the furthest point", () => {
    const cur = { slide_index: 6, position_seconds: 0, completed: false, server_revision: 3, client_revision: 5 };
    expect(mergeProgress(cur, inc(8, false, 2, 1))).toMatchObject({ outcome: "merged", next: { slide_index: 8, server_revision: 4 } });
  });
});
