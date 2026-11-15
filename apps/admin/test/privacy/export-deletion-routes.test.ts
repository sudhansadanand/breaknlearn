/**
 * A9-PRIV-01 / OPS-005 guardian export and deletion-request routes with fakes (no database). The SQL export function,
 * RLS and the deletion job are proven against a real database in test/integration/privacy-db.test.ts.
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "@bnl/contracts";
import { setDepsForTesting } from "../../src/server/deps";
import { setPrivacyRepoForTesting } from "../../src/server/privacy/repo";
import * as deletion from "../../src/app/api/v1/admin/privacy/deletion-requests/route";
import * as exportRoute from "../../src/app/api/v1/admin/privacy/export/route";
import { GUARDIAN_A, HH_A, HH_B, OUTSIDER, OWNER_A, OWNER_B, bodyOf, makeTestEnv, req, type TestEnv } from "../fakes";
import { fakePrivacyRepo, type PrivacyFakeStore } from "./helpers";

const A1 = "c1000000-0000-4000-8000-0000000000a1";
const B1 = "c1000000-0000-4000-8000-0000000000b1";

let env: TestEnv;
let ps: PrivacyFakeStore;
beforeEach(() => {
  env = makeTestEnv();
  ps = { requests: [], exports: [] };
  setDepsForTesting(env.deps);
  setPrivacyRepoForTesting(fakePrivacyRepo(env.store, ps, () => env.clock.now));
  for (const [id, householdId] of [[A1, HH_A], [B1, HH_B]] as const) {
    env.store.profiles.push({ id, householdId, slot: 1, displayName: `Synthetic ${householdId.slice(0, 2)}`, grade: 2, avatarId: "fox", preferences: {}, updatedAt: env.clock.now });
  }
});
afterEach(() => {
  setDepsForTesting(null);
  setPrivacyRepoForTesting(null);
});

const sess = (who: { userId: string; email: string }) => env.auth.sessionFor(who);
const doExport = (session?: string) => exportRoute.GET(req("GET", "/api/v1/admin/privacy/export", session ? { session } : {}));
const request = (session: string | undefined, body: Record<string, unknown>, o: Parameters<typeof req>[2] = {}) =>
  deletion.POST(req("POST", "/api/v1/admin/privacy/deletion-requests", { ...(session ? { session } : {}), body, ...o }));
const list = (session?: string) => deletion.GET(req("GET", "/api/v1/admin/privacy/deletion-requests", session ? { session } : {}));

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = ApiError.parse(await res.json());
  expect(body.error.code).toBe(code);
  return body;
}

describe("GET /api/v1/admin/privacy/export", () => {
  it("401 without a session and 403 without a household; nothing exported or audited", async () => {
    await expectError(await doExport(), 401, "unauthorized");
    await expectError(await doExport(sess(OUTSIDER)), 403, "forbidden");
    expect(ps.exports).toEqual([]);
    expect(env.store.audit).toEqual([]);
  });

  it.each([["owner", OWNER_A], ["guardian", GUARDIAN_A]] as const)("%s downloads the own household as a no-store JSON attachment, audited with counts only", async (role, who) => {
    const res = await doExport(sess(who));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="breaknlearn-export-2026-11-14.json"');
    const body = await bodyOf(res);
    expect(body).toMatchObject({ format: "breaknlearn-household-export", format_version: 1, household_id: HH_A });
    expect(ps.exports).toEqual([HH_A]);
    expect(JSON.stringify(body)).not.toContain(HH_B);
    const audit = env.store.audit.at(-1)!;
    expect(audit).toMatchObject({ action: "privacy.exported", householdId: HH_A, actorAuthId: who.userId, metadata: { role, tables: 2, rows: 1 } });
    expect(JSON.stringify(audit)).not.toContain("Synthetic");
  });

  it("is rate limited per adult", async () => {
    const s = sess(OWNER_A);
    for (let i = 0; i < 10; i++) expect((await doExport(s)).status).toBe(200);
    await expectError(await doExport(s), 429, "rate_limited");
  });
});

describe("/api/v1/admin/privacy/deletion-requests", () => {
  const ok = { scope: "learner", learner_id: A1, confirmation: "DELETE" };

  it("401 without a session (GET and POST); CSRF is required for POST", async () => {
    await expectError(await list(), 401, "unauthorized");
    await expectError(await request(undefined, ok), 401, "unauthorized");
    await expectError(await request(sess(OWNER_A), ok, { origin: "https://evil.example" }), 403, "forbidden");
    await expectError(await request(sess(OWNER_A), ok, { csrfHeader: "A".repeat(43) }), 403, "forbidden");
    expect(ps.requests).toEqual([]);
  });

  it("only the owner may request deletion; a guardian gets 403", async () => {
    const body = await expectError(await request(sess(GUARDIAN_A), ok), 403, "forbidden");
    expect(body.error.message).toMatch(/owner/);
    expect(ps.requests).toEqual([]);
  });

  it("requires the explicit confirmation and a valid scope/learner combination", async () => {
    const s = sess(OWNER_A);
    await expectError(await request(s, { ...ok, confirmation: "delete" }), 422, "validation_failed");
    await expectError(await request(s, { scope: "learner", learner_id: A1 }), 422, "validation_failed");
    await expectError(await request(s, { scope: "learner", confirmation: "DELETE" }), 422, "validation_failed");
    await expectError(await request(s, { scope: "household", learner_id: A1, confirmation: "DELETE" }), 422, "validation_failed");
    await expectError(await request(s, { scope: "everything", confirmation: "DELETE" }), 422, "validation_failed");
    await expectError(await request(s, { ...ok, extra: 1 }), 422, "validation_failed");
    expect(ps.requests).toEqual([]);
  });

  it("refuses a learner of another household (404, no cross-tenant request)", async () => {
    await expectError(await request(sess(OWNER_A), { ...ok, learner_id: B1 }), 404, "not_found");
    await expectError(await request(sess(OWNER_A), { ...ok, learner_id: randomUUID() }), 404, "not_found");
    expect(ps.requests).toEqual([]);
  });

  it("queues a request (202), audits it without names, refuses a duplicate while open, and lists it", async () => {
    const s = sess(OWNER_A);
    const res = await request(s, ok);
    expect(res.status).toBe(202);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await bodyOf(res);
    const dr = body.deletion_request as Record<string, unknown>;
    expect(dr).toMatchObject({ scope: "learner", learner_id: A1, status: "requested", complete_by: "2026-11-21T10:00:00.000Z", completed_at: null });
    expect(body.processing).toMatch(/next nightly run, at most 7 days/);
    expect(ps.requests[0]).toMatchObject({ householdId: HH_A, requestedBy: OWNER_A.userId, scope: "learner", learnerId: A1 });
    const audit = env.store.audit.at(-1)!;
    expect(audit).toMatchObject({ action: "privacy.deletion_requested", householdId: HH_A, targetId: dr.id, metadata: { scope: "learner", learner_id: A1, role: "owner" } });
    expect(JSON.stringify(audit)).not.toContain("Synthetic");

    const dup = await expectError(await request(s, ok), 409, "conflict");
    expect(dup.error.details).toEqual({ deletion_request_id: dr.id });
    expect((await request(s, { scope: "telemetry_only", confirmation: "DELETE" })).status).toBe(202);

    for (const who of [OWNER_A, GUARDIAN_A]) {
      const items = (await bodyOf(await list(sess(who)))).items as { scope: string }[];
      expect(items.map((i) => i.scope).sort()).toEqual(["learner", "telemetry_only"]);
    }
    expect((await bodyOf(await list(sess(OWNER_B)))).items).toEqual([]);
  });
});
