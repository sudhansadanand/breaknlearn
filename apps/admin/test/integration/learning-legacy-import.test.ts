/** MIG-002/003/004 through POST /progress/legacy-import with the tests/fixtures/legacy snapshots (real DB). */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ApiError, MULTIPLICATION_LESSON_IDS } from "@bnl/contracts";
import { LegacyImportReceiptV1A } from "../../src/server/learning/legacy-import";
import { legacyAttemptId } from "../../src/server/learning/uuid";
import { deviceRequest, legacyBody, legacyFixture } from "../learning/builders";
import { freshHousehold, openDbEnv, revoke, type DbEnv, type Household } from "../learning/db-env";
import { learningRoutes } from "../learning/routes";

let env: DbEnv;
let hh: Household;
let other: Household;

beforeAll(() => {
  env = openDbEnv();
});
afterAll(() => env.close());
beforeEach(async () => {
  hh = await freshHousehold(env);
  other = await freshHousehold(env);
});

const post = async (b: unknown, o: { key?: string; bearer?: string } = {}) => {
  const res = await learningRoutes.legacyImport.POST(deviceRequest("POST", "/api/v1/progress/legacy-import", { bearer: o.bearer ?? hh.token, body: b, ...(o.key ? { idempotencyKey: o.key } : {}) }));
  return { status: res.status, json: (await res.json()) as unknown };
};
const progressRows = async (learner: string) =>
  env.admin`select lesson_id, theme_key, slide_id, position_seconds::float8 as pos, completed, attempt_id from bnl.learner_progress where learner_id = ${learner} order by lesson_id, theme_key`;
const T = (n: number) => MULTIPLICATION_LESSON_IDS[n]!;

describe("legacy import (real DB)", () => {
  it("MIG-002: two profiles keep per-table/per-world progress; receipt counts; aliases + run recorded; nothing fabricated", async () => {
    const raw = legacyFixture("profiles-v1-two-children.json");
    const req = await legacyBody(raw, [
      { local_profile_id: "child-1", learner_id: hh.learners[0] },
      { local_profile_id: "child-2", learner_id: hh.learners[1] },
    ]);
    const res = await post(req);
    expect(res.status).toBe(200);
    const receipt = LegacyImportReceiptV1A.parse(res.json);
    expect(receipt).toEqual({
      migration_run_id: req.migration_run_id,
      outcome: "imported",
      per_profile: [
        { local_profile_id: "child-1", learner_id: hh.learners[0], entries_imported: 3, entries_skipped_newer_on_server: 0, entries_unrecognized: 0 },
        { local_profile_id: "child-2", learner_id: hh.learners[1], entries_imported: 1, entries_skipped_newer_on_server: 0, entries_unrecognized: 0 },
      ],
      historical: { entries_found: 0, entries_pending_assignment: 0, entries_unrecognized: 0 },
    });
    const asha = await progressRows(hh.learners[0]);
    const byKey = Object.fromEntries(asha.map((r) => [`${r.lesson_id}:${r.theme_key}`, r]));
    expect(byKey[`${T(1)}:puppy`]).toMatchObject({ slide_id: "step-10", completed: true, attempt_id: legacyAttemptId(hh.learners[0], T(1), "puppy") });
    expect(byKey[`${T(3)}:candy`]).toMatchObject({ slide_id: "step-4", pos: 3.2, completed: false });
    expect(byKey[`${T(3)}:farm`]).toMatchObject({ slide_id: "step-6", pos: 2, completed: false }); // bare world → ×3 only
    expect(asha).toHaveLength(3);
    expect(await progressRows(hh.learners[1])).toEqual([expect.objectContaining({ lesson_id: T(3), theme_key: "unicorn", slide_id: "step-7", pos: 6.9 })]);

    const aliases = await env.admin`select local_profile_id, learner_id from bnl.migration_aliases where device_id = ${hh.deviceId} order by local_profile_id`;
    expect(aliases).toEqual([{ local_profile_id: "child-1", learner_id: hh.learners[0] }, { local_profile_id: "child-2", learner_id: hh.learners[1] }]);
    const runs = await env.admin`select legacy_fingerprint, receipt from bnl.migration_runs where household_id = ${hh.householdId}`;
    expect(runs).toHaveLength(1);
    expect(runs[0]!.legacy_fingerprint).toBe(req.legacy_fingerprint);
    for (const t of ["learning_sessions", "learning_events", "assessment_attempts", "question_responses"]) {
      expect(await env.admin`select 1 from ${env.admin(`bnl.${t}`)} where household_id = ${hh.householdId}`, t).toHaveLength(0);
    }
    const audit = await env.admin`select actor_type, metadata::text as m from bnl.audit_logs where household_id = ${hh.householdId} and action = 'progress.legacy_imported'`;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor_type).toBe("device");
    expect(audit[0]!.m).not.toMatch(/Asha|Ravi/);
  });

  it("MIG-004: same run+fingerprint → already_imported with identical receipt; a new run id is a no-op; newer server completion is kept", async () => {
    const raw = legacyFixture("profiles-v1-two-children.json");
    const mapping = [{ local_profile_id: "child-1", learner_id: hh.learners[0] }, { local_profile_id: "child-2", learner_id: hh.learners[1] }];
    const req = await legacyBody(raw, mapping);
    const first = LegacyImportReceiptV1A.parse((await post(req)).json);
    const before = await progressRows(hh.learners[0]);

    const again = await post(req); // new Idempotency-Key, same run + fingerprint
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ ...first, outcome: "already_imported" });

    // Server progress moves on (child finished ×3 candy on the new app) …
    await env.admin`update bnl.learner_progress set completed = true, slide_id = 'step-10' where learner_id = ${hh.learners[0]} and lesson_id = ${T(3)} and theme_key = 'candy'`;
    // … then the same snapshot is imported under a new run id.
    const rerun = LegacyImportReceiptV1A.parse((await post({ ...req, migration_run_id: randomUUID() })).json);
    expect(rerun.outcome).toBe("imported");
    expect(rerun.per_profile.map((p) => [p.entries_imported, p.entries_skipped_newer_on_server])).toEqual([[0, 3], [0, 1]]);
    const after = await progressRows(hh.learners[0]);
    expect(after).toHaveLength(before.length);
    expect(after.find((r) => r.theme_key === "candy")).toMatchObject({ completed: true, slide_id: "step-10" });
  });

  it("MIG-004: a live-app attempt that is already further wins; legacy entry is reported as skipped", async () => {
    await env.admin`insert into bnl.learner_progress (household_id, learner_id, lesson_id, theme_key, attempt_id, slide_id, completed)
      values (${hh.householdId}, ${hh.learners[1]}, ${T(3)}, 'unicorn', ${randomUUID()}, 'step-10', true)`;
    const raw = legacyFixture("profiles-v1-two-children.json");
    const receipt = LegacyImportReceiptV1A.parse((await post(await legacyBody(raw, [
      { local_profile_id: "child-1", learner_id: hh.learners[0] },
      { local_profile_id: "child-2", learner_id: hh.learners[1] },
    ]))).json);
    expect(receipt.per_profile[1]).toMatchObject({ entries_imported: 0, entries_skipped_newer_on_server: 1 });
    expect(await progressRows(hh.learners[1])).toHaveLength(1);
  });

  it("MIG-003: historical keys map only to ×3 and stay unassigned unless the guardian assigns them", async () => {
    const raw = legacyFixture("historical-x3-keys.json");
    const pending = LegacyImportReceiptV1A.parse((await post(await legacyBody(raw, []))).json);
    expect(pending).toMatchObject({ per_profile: [], historical: { entries_found: 2, entries_pending_assignment: 2, entries_unrecognized: 0 } });
    expect(await env.admin`select 1 from bnl.learner_progress where household_id = ${hh.householdId}`).toHaveLength(0);

    const assigned = LegacyImportReceiptV1A.parse((await post(await legacyBody(raw, [], { historical_learner_id: hh.learners[0] }))).json);
    expect(assigned.per_profile).toEqual([
      { local_profile_id: "legacy:historical", learner_id: hh.learners[0], entries_imported: 2, entries_skipped_newer_on_server: 0, entries_unrecognized: 0 },
    ]);
    expect(assigned.historical.entries_pending_assignment).toBe(0);
    const rows = await progressRows(hh.learners[0]);
    expect(rows.map((r) => [r.lesson_id, r.theme_key, r.slide_id, r.completed])).toEqual(
      expect.arrayContaining([[T(3), "puppy", "step-5", false], [T(3), "school", "step-10", true]]),
    );
    expect(rows.every((r) => r.lesson_id === T(3))).toBe(true);
  });

  it("rejects: fingerprint mismatch (422), missing/unknown mapping (422), other household's learner (403), remapped alias (409), revoked device (401)", async () => {
    const raw = legacyFixture("profiles-v1-two-children.json");
    const mapping = [{ local_profile_id: "child-1", learner_id: hh.learners[0] }, { local_profile_id: "child-2", learner_id: hh.learners[1] }];
    const good = await legacyBody(raw, mapping);
    const tampered = await post({ ...good, legacy_fingerprint: "0".repeat(64) });
    expect(tampered.status).toBe(422);
    expect(ApiError.parse(tampered.json).error.details).toMatchObject({ issues: [{ path: "legacy_fingerprint", code: "fingerprint_mismatch" }] });
    expect((await post({ ...good, profile_mapping: [mapping[0]] })).status).toBe(422);
    expect((await post({ ...good, profile_mapping: [{ local_profile_id: "child-9", learner_id: hh.learners[0] }, mapping[1]] })).status).toBe(422);
    expect((await post({ ...good, profile_mapping: [mapping[0], { local_profile_id: "child-2", learner_id: hh.learners[0] }] })).status).toBe(422);
    const foreign = await post({ ...good, profile_mapping: [mapping[0], { local_profile_id: "child-2", learner_id: other.learners[0] }] });
    expect(foreign.status).toBe(403);
    expect((await post(await legacyBody(legacyFixture("historical-x3-keys.json"), [], { historical_learner_id: other.learners[1] }))).status).toBe(403);
    expect(await env.admin`select 1 from bnl.learner_progress where household_id = any(${env.admin.array([hh.householdId, other.householdId])}::uuid[])`).toHaveLength(0);

    expect((await post(good)).status).toBe(200);
    const swapped = await post({ ...good, migration_run_id: randomUUID(), profile_mapping: [{ local_profile_id: "child-1", learner_id: hh.learners[1] }, { local_profile_id: "child-2", learner_id: hh.learners[0] }] });
    expect(swapped.status).toBe(409);

    await revoke(env, hh.deviceId);
    expect((await post({ ...good, migration_run_id: randomUUID() })).status).toBe(401);
  });
});
