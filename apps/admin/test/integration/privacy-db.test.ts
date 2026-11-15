/**
 * A9-PRIV-01 / OPS-005 end to end against the real schema, roles and RLS (bnl_app login), with the REAL consent gate:
 *   consent API → enforcement on a device endpoint and on pairing approval → withdrawal stops ingestion;
 *   guardian export (own rows only, no secrets, no other household's ids, audited);
 *   owner deletion request → nightly job (bnl_job) with a local filesystem storage → rows and syllabus objects gone,
 *   idempotent re-run, the other household untouched.
 * SYNTHETIC data only; throwaway database of scripts/db/test-db.mjs.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError, PairingCodeResponse } from "@bnl/contracts";
import { LocalFsStorage } from "@bnl/storage";
import { SYLLABI_BUCKET } from "../../src/server/curriculum/deps";
import { CONSENT_VERSION } from "../../src/server/privacy/consent-text";
import { runDeletionRequests } from "../../src/server/privacy/deletion-job";
import { allowAllConsentGate, setConsentGateForTesting } from "../../src/server/privacy/gate";
import * as deletionRoute from "../../src/app/api/v1/admin/privacy/deletion-requests/route";
import * as exportRoute from "../../src/app/api/v1/admin/privacy/export/route";
import { req } from "../fakes";
import { deviceRequest, makeEvent } from "../learning/builders";
import { freshHousehold, openDbEnv, type DbEnv, type Household } from "../learning/db-env";
import { learningRoutes } from "../learning/routes";
import { routes } from "../routes";

let env: DbEnv;
let storageDir: string;
let storage: LocalFsStorage;

beforeAll(() => {
  env = openDbEnv();
  setConsentGateForTesting(null); // the real SQL gate (bnl.household_has_consent / consent_records under RLS)
  storageDir = mkdtempSync(join(tmpdir(), "bnl-privacy-storage-"));
  storage = new LocalFsStorage(storageDir, { signingKey: randomBytes(32), baseUrl: "/local-object" });
  process.env.FEATURE_TELEMETRY = "true";
});
afterAll(async () => {
  setConsentGateForTesting(allowAllConsentGate);
  delete process.env.FEATURE_TELEMETRY;
  rmSync(storageDir, { recursive: true, force: true });
  await env.close();
});

const owner = (h: Household) => env.auth.sessionFor({ userId: h.ownerUserId, email: `owner-${h.householdId.slice(0, 8)}@bnl.test` });
const consent = (h: Household, decision: "grant" | "revoke", scopes: string[]) =>
  routes.consent.POST(req("POST", "/api/v1/admin/consent", { session: owner(h), body: { consent_version: CONSENT_VERSION, decision, scopes } }));
const tele = (h: Household) => {
  const ctx = { deviceId: h.deviceId, learnerId: h.learners[0], sessionId: randomUUID(), base: Date.now() - 60_000 };
  return learningRoutes.telemetryBatch.POST(deviceRequest("POST", "/api/v1/telemetry/batch", { bearer: h.token, body: { events: [makeEvent(ctx, "app_opened", 0)] } }));
};
const count = async (sql: string, id: string) => Number((await env.admin.unsafe<{ n: number }[]>(sql, [id]))[0]!.n);
const events = (h: Household) => count("select count(*)::int as n from bnl.learning_events where household_id = $1", h.householdId);
const code = async (r: Response) => ApiError.parse(await r.json()).error.code;

describe("consent enforcement with the real gate", () => {
  it("telemetry: 403 without consent, accepted after consent, 403 again on the very next batch after withdrawal", async () => {
    const h = await freshHousehold(env);
    const r0 = await tele(h);
    expect(r0.status).toBe(403);
    expect(await code(r0)).toBe("consent_required");
    expect(await events(h)).toBe(0);

    expect((await consent(h, "grant", ["learning_data", "telemetry"])).status).toBe(200);
    expect((await tele(h)).status).toBe(200);
    expect(await events(h)).toBe(1);

    expect((await consent(h, "revoke", ["telemetry"])).status).toBe(200);
    const r2 = await tele(h);
    expect(r2.status).toBe(403);
    expect(await code(r2)).toBe("consent_required");
    // Data already collected is kept until the parent asks for deletion.
    expect(await events(h)).toBe(1);
    const audit = await env.admin<{ action: string; metadata: Record<string, unknown> }[]>`
      select action, metadata from bnl.audit_logs where household_id = ${h.householdId} and action like 'consent.%' order by created_at`;
    expect(audit.map((a) => a.action)).toEqual(["consent.granted", "consent.revoked"]);
    expect(audit[1]!.metadata).toMatchObject({ scopes: ["telemetry"], changed_scopes: ["telemetry"] });
  });

  it("another household's consent never opens ingestion for this one", async () => {
    const a = await freshHousehold(env);
    const b = await freshHousehold(env);
    await consent(b, "grant", ["learning_data", "telemetry"]);
    expect((await tele(a)).status).toBe(403);
    expect((await tele(b)).status).toBe(200);
  });

  it("pairing approval: 403 consent_required (no device created) until learning_data is granted", async () => {
    const h = await freshHousehold(env);
    const newCode = async () => PairingCodeResponse.parse(await (await routes.pairingCode.POST(req("POST", "/api/v1/devices/pairing-code", { csrf: false, ip: `198.51.100.${Math.floor(Math.random() * 200)}` }))).json());
    const approve = (c: string) => routes.pair.POST(req("POST", "/api/v1/devices/pair", { session: owner(h), body: { code: c, device_label: "SYNTHETIC privacy TV" } }));
    const c1 = await newCode();
    const before = await count("select count(*)::int as n from bnl.paired_devices where household_id = $1", h.householdId);
    const denied = await approve(c1.code);
    expect(denied.status).toBe(403);
    expect(await code(denied)).toBe("consent_required");
    expect(await count("select count(*)::int as n from bnl.paired_devices where household_id = $1", h.householdId)).toBe(before);
    await consent(h, "grant", ["learning_data"]);
    expect((await approve(c1.code)).status).toBe(200);
    expect(await count("select count(*)::int as n from bnl.paired_devices where household_id = $1", h.householdId)).toBe(before + 1);
  });
});

async function addUpload(h: Household): Promise<string> {
  const plan = randomUUID();
  const key = `${h.householdId}/${randomUUID()}`;
  await env.admin`insert into bnl.school_plans (id, household_id, grade, subject_key, academic_year) values (${plan}, ${h.householdId}, 2, 'math', '2026-27')`;
  await env.admin`insert into bnl.syllabus_uploads (household_id, school_plan_id, object_key, sha256, original_filename, mime_type, size_bytes)
    values (${h.householdId}, ${plan}, ${key}, ${"a".repeat(64)}, 'synthetic-toc.csv', 'text/csv', 10)`;
  await storage.put(SYLLABI_BUCKET, key, new TextEncoder().encode("1,Numbers"), "text/csv");
  return key;
}

describe("guardian export (real DB)", () => {
  it("returns only the household's rows, no secret columns, no other household's ids; audited", async () => {
    const a = await freshHousehold(env);
    const b = await freshHousehold(env);
    await env.admin`update bnl.paired_devices set refresh_token_hash = ${"f".repeat(64)} where id = ${a.deviceId}`;
    await consent(a, "grant", ["learning_data", "telemetry"]);
    await consent(b, "grant", ["learning_data", "telemetry"]);
    await tele(a);
    await tele(b);
    await addUpload(a);
    const res = await exportRoute.GET(req("GET", "/api/v1/admin/privacy/export", { session: owner(a) }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="breaknlearn-export-\d{4}-\d{2}-\d{2}\.json"$/);
    const body = (await res.json()) as { household_id: string; tables: Record<string, Record<string, unknown>[]> };
    expect(body.household_id).toBe(a.householdId);
    const text = JSON.stringify(body);
    for (const id of [b.householdId, b.deviceId, b.ownerUserId, ...b.learners]) expect(text).not.toContain(id);
    expect(text).not.toContain("f".repeat(64));
    const columns = new Set(Object.values(body.tables).flatMap((rows) => rows.flatMap((r) => Object.keys(r))));
    expect([...columns].filter((k) => /token|secret|hash|password/.test(k))).toEqual([]);
    expect(body.tables.learner_profiles!.map((p) => p.id).sort()).toEqual([...a.learners].sort());
    expect(body.tables.learning_events).toHaveLength(1);
    expect(body.tables.consent_records!.map((c) => c.scope).sort()).toEqual(["learning_data", "telemetry"]);
    expect(body.tables.syllabus_uploads).toHaveLength(1);
    const [audit] = await env.admin<{ metadata: Record<string, unknown> }[]>`
      select metadata from bnl.audit_logs where household_id = ${a.householdId} and action = 'privacy.exported'`;
    expect(audit!.metadata).toMatchObject({ role: "owner" });
    expect(JSON.stringify(audit!.metadata)).not.toMatch(/Synthetic/);
  });
});

describe("deletion request → nightly job (real DB, local storage)", () => {
  const request = (h: Household, body: Record<string, unknown>) =>
    deletionRoute.POST(req("POST", "/api/v1/admin/privacy/deletion-requests", { session: owner(h), body: { confirmation: "DELETE", ...body } }));

  it("learner, telemetry_only and household scopes; objects removed; idempotent re-run; other household untouched", async () => {
    const a = await freshHousehold(env);
    const b = await freshHousehold(env);
    for (const h of [a, b]) {
      await consent(h, "grant", ["learning_data", "telemetry"]);
      await tele(h);
    }
    const keyA = await addUpload(a);
    const keyB = await addUpload(b);
    const bEvents = await events(b);

    expect((await request(a, { scope: "telemetry_only" })).status).toBe(202);
    expect((await request(a, { scope: "learner", learner_id: a.learners[1] })).status).toBe(202);
    const listed = (await (await deletionRoute.GET(req("GET", "/api/v1/admin/privacy/deletion-requests", { session: owner(a) }))).json()) as { items: { status: string }[] };
    expect(listed.items.map((i) => i.status)).toEqual(["requested", "requested"]);

    const logs: Record<string, unknown>[] = [];
    const r1 = await runDeletionRequests(env.runner, storage, { log: (e) => logs.push(e) });
    expect(r1.failed).toBe(0);
    expect(await events(a)).toBe(0);
    expect(await count("select count(*)::int as n from bnl.learner_profiles where household_id = $1", a.householdId)).toBe(1);
    const done = (await (await deletionRoute.GET(req("GET", "/api/v1/admin/privacy/deletion-requests", { session: owner(a) }))).json()) as { items: { status: string; completed_at: string | null }[] };
    expect(done.items.every((i) => i.status === "completed" && i.completed_at !== null)).toBe(true);

    // Household scope: the syllabus object goes from Storage, then every row.
    const created = await request(a, { scope: "household" });
    expect(created.status).toBe(202);
    const { deletion_request } = (await created.json()) as { deletion_request: { id: string } };
    expect(await storage.get(SYLLABI_BUCKET, keyA)).not.toBeNull();
    const r2 = await runDeletionRequests(env.runner, storage);
    const mine = r2.outcomes.find((o) => o.id === deletion_request.id)!;
    expect(mine).toMatchObject({ status: "completed", storage_objects_removed: 1 });
    expect(mine.counts).toMatchObject({ households: 1, storage_objects_removed: 1, object_keys_removed: [keyA] });
    expect(mine.counts).not.toHaveProperty("object_keys_to_remove");
    expect(await storage.get(SYLLABI_BUCKET, keyA)).toBeNull();
    expect(await count("select count(*)::int as n from bnl.households where id = $1", a.householdId)).toBe(0);
    const [audit] = await env.admin<{ household_id: string | null; actor_type: string; metadata: unknown }[]>`
      select household_id, actor_type, metadata from bnl.audit_logs where action = 'privacy.deletion_completed' and target_id = ${deletion_request.id}`;
    expect(audit).toMatchObject({ household_id: null, actor_type: "job" });
    expect(JSON.stringify(audit!.metadata)).not.toMatch(/Synthetic|synthetic-toc/);

    // Idempotent: nothing of household A is left to process; B is untouched (rows and its object).
    const r3 = await runDeletionRequests(env.runner, storage);
    expect(r3.outcomes.filter((o) => o.id === deletion_request.id)).toEqual([]);
    expect(r3.failed).toBe(0);
    expect(await events(b)).toBe(bEvents);
    expect(await storage.get(SYLLABI_BUCKET, keyB)).not.toBeNull();
    const runs = await env.admin<{ status: string }[]>`select status from bnl.job_runs where job_name = 'process_deletion_requests'`;
    expect(runs.length).toBeGreaterThanOrEqual(3);
    expect(logs.some((l) => JSON.stringify(l).includes("Synthetic"))).toBe(false);
  });

  it("a crash after the storage step is safe: the next run completes the request (objects already gone is a no-op)", async () => {
    const h = await freshHousehold(env);
    const key = await addUpload(h);
    expect((await request(h, { scope: "household" })).status).toBe(202);
    await storage.remove(SYLLABI_BUCKET, key); // as if a previous run removed it and then died
    const r = await runDeletionRequests(env.runner, storage);
    expect(r.failed).toBe(0);
    expect(await count("select count(*)::int as n from bnl.households where id = $1", h.householdId)).toBe(0);
  });

  it("the request login cannot run the deletion function as an adult or device", async () => {
    const h = await freshHousehold(env);
    expect((await request(h, { scope: "telemetry_only" })).status).toBe(202);
    const [row] = await env.admin<{ id: string }[]>`select id from bnl.data_deletion_requests where household_id = ${h.householdId}`;
    for (const ctx of [{ kind: "adult", userId: h.ownerUserId }, { kind: "device", householdId: h.householdId, deviceId: h.deviceId }] as const) {
      await expect(env.runner(ctx, (sql) => sql`select bnl.process_deletion_request(${row!.id}::uuid, 0)`)).rejects.toMatchObject({ code: "42501" });
    }
    await env.admin`delete from bnl.data_deletion_requests where id = ${row!.id}`;
  });
});
