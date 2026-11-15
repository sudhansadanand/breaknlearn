import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HISTORICAL_LOCAL_PROFILE_ID, convertLegacy, legacyFingerprint, legacyFingerprintInput, planLegacyImport, slideIndexOf, type StoredProgressRow } from "../src";

const fx = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../tests/fixtures/legacy/${name}`, import.meta.url)), "utf8"));
const L1 = "c0000000-0000-4000-8000-000000000001";
const L2 = "c0000000-0000-4000-8000-000000000002";
const lessonIdForTable = (t: number) => `lesson-${t}`;
const attemptIdFor = (t: { learner_id: string; lesson_id: string; theme_key: string }) => `att:${t.learner_id}:${t.lesson_id}:${t.theme_key}`;

describe("fingerprint", () => {
  it("is sha256 of canonical JSON over exactly the three keys (missing = null, key order irrelevant)", async () => {
    const raw = { "learnbreak-x3-v4-progress": null, "breaknlearn.profiles.v1": { activeId: null, profiles: [] } };
    const expected = createHash("sha256").update(legacyFingerprintInput(raw)).digest("hex");
    expect(await legacyFingerprint(raw)).toBe(expected);
    expect(await legacyFingerprint({ ...raw, "breaknlearn.progress.v1": null, _comment: "ignored" })).toBe(expected);
    expect(await legacyFingerprint({ ...raw, "breaknlearn.progress.v1": {} })).not.toBe(expected);
  });
});

describe("slideIndexOf", () => {
  it("parses trailing digits", () => {
    expect([slideIndexOf("step-10"), slideIndexOf("three-4"), slideIndexOf(null), slideIndexOf("intro")]).toEqual([10, 4, 0, 0]);
  });
});

describe("planLegacyImport", () => {
  const two = convertLegacy(fx("profiles-v1-two-children.json"));
  const mapping = new Map([["child-1", L1], ["child-2", L2]]);

  it("MIG-002: inserts one legacy attempt per (learner, lesson, theme) with counts per profile", () => {
    const plan = planLegacyImport({ conversion: two, mapping, historicalLearnerId: null, lessonIdForTable, attemptIdFor, existing: () => [] });
    expect(plan.writes).toHaveLength(4);
    expect(plan.writes.every((w) => w.kind === "insert")).toBe(true);
    expect(plan.per_profile.map((p) => [p.local_profile_id, p.entries_imported])).toEqual([["child-1", 3], ["child-2", 1]]);
  });

  it("MIG-004: stored legacy attempt with the same state → no writes, counted as skipped", () => {
    const stored = new Map<string, StoredProgressRow>();
    const first = planLegacyImport({ conversion: two, mapping, historicalLearnerId: null, lessonIdForTable, attemptIdFor, existing: () => [] });
    for (const w of first.writes) {
      if (w.kind !== "insert") continue;
      stored.set(attemptIdFor(w.target), { attempt_id: w.attempt_id, slide_id: w.slide_id, position_seconds: w.position_seconds, completed: w.completed, server_revision: 1, client_revision: 0 });
    }
    const again = planLegacyImport({ conversion: two, mapping, historicalLearnerId: null, lessonIdForTable, attemptIdFor, existing: (t) => { const r = stored.get(attemptIdFor(t)); return r ? [r] : []; } });
    expect(again.writes).toEqual([]);
    expect(again.per_profile.map((p) => p.entries_skipped_newer_on_server)).toEqual([3, 1]);
  });

  it("never regresses a completed server attempt, but advances an incomplete legacy attempt", () => {
    const done: StoredProgressRow = { attempt_id: "live", slide_id: "step-10", position_seconds: 0, completed: true, server_revision: 3, client_revision: 4 };
    const p1 = planLegacyImport({ conversion: two, mapping, historicalLearnerId: null, lessonIdForTable, attemptIdFor, existing: () => [done] });
    expect(p1.writes).toEqual([]);
    const behind = (t: { learner_id: string; lesson_id: string; theme_key: string }): StoredProgressRow[] => [{ attempt_id: attemptIdFor(t), slide_id: "step-1", position_seconds: 0, completed: false, server_revision: 2, client_revision: 0 }];
    const p2 = planLegacyImport({ conversion: two, mapping, historicalLearnerId: null, lessonIdForTable, attemptIdFor, existing: behind });
    expect(p2.writes.every((w) => w.kind === "update" && w.expected_server_revision === 2)).toBe(true);
    expect(p2.writes.find((w) => w.target.theme_key === "puppy")).toMatchObject({ completed: true, slide_id: "step-10" });
  });

  it("MIG-003: historical entries stay pending unless assigned; when assigned they fold into ×3 targets", () => {
    const hist = convertLegacy(fx("historical-x3-keys.json"));
    const pending = planLegacyImport({ conversion: hist, mapping: new Map(), historicalLearnerId: null, lessonIdForTable, attemptIdFor, existing: () => [] });
    expect(pending).toMatchObject({ writes: [], per_profile: [], historical: { entries_found: 2, entries_pending_assignment: 2 } });
    const assigned = planLegacyImport({ conversion: hist, mapping: new Map(), historicalLearnerId: L1, lessonIdForTable, attemptIdFor, existing: () => [] });
    expect(assigned.per_profile).toEqual([{ local_profile_id: HISTORICAL_LOCAL_PROFILE_ID, learner_id: L1, entries_imported: 2, entries_skipped_newer_on_server: 0, entries_unrecognized: 0 }]);
    expect(assigned.writes.map((w) => w.target.lesson_id)).toEqual(["lesson-3", "lesson-3"]);
  });

  it("two entries for one target fold: furthest slide wins, completion is sticky", () => {
    const c = convertLegacy({
      "breaknlearn.profiles.v1": { profiles: [{ id: "child-1", name: "A", grade: 2, avatar: "🦊", lessons: { "times-3:farm": { slideId: "step-2", complete: true } } }] },
      "breaknlearn.progress.v1": { farm: { slideId: "three-8" } },
      "learnbreak-x3-v4-progress": null,
    });
    const plan = planLegacyImport({ conversion: c, mapping: new Map([["child-1", L1]]), historicalLearnerId: L1, lessonIdForTable, attemptIdFor, existing: () => [] });
    expect(plan.writes).toEqual([expect.objectContaining({ kind: "insert", slide_id: "step-8", completed: true })]);
    expect(plan.per_profile.map((p) => p.entries_imported)).toEqual([1, 1]);
  });
});
