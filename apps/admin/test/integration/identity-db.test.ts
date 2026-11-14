/**
 * Cross-agent integration (A1 × A2): the identity handlers running against the real schema,
 * roles and RLS in a throwaway Postgres (scripts/db/test-db.mjs). No fakes for SQL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { MemoryRateLimiter, deriveServerKeys } from "@bnl/auth";
import { DeviceTokenResponse, PairingCodeResponse, ProfileList } from "@bnl/contracts";
import { createDb, withDbContext, type Db } from "@bnl/db";
import { setDepsForTesting, type AppDeps } from "../../src/server/deps";
import { sqlRepos } from "../../src/server/repos";
import { FakeAdultAuth, ORIGIN, OUTSIDER, OWNER_A, req } from "../fakes";
import { revokeDevice, routes } from "../routes";

const HH_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const HH_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const LEARNER_B1 = "c0000000-0000-4000-8000-0000000000b1";

const url = process.env.BNL_TEST_DB_URL;
const adminUrl = process.env.BNL_TEST_ADMIN_URL;
if (!url || !adminUrl) throw new Error("run via: pnpm --filter @bnl/admin test:integration");

let db: Db;
let admin: Db;
let auth: FakeAdultAuth;

beforeAll(() => {
  db = createDb(url, { max: 4 });
  admin = createDb(adminUrl, { max: 2 });
});
afterAll(async () => {
  setDepsForTesting(null);
  await db.end();
  await admin.end();
});
beforeEach(() => {
  auth = new FakeAdultAuth();
  const deps: AppDeps = {
    db: (ctx, fn) => withDbContext(db, ctx, fn),
    repos: sqlRepos,
    adultAuth: auth,
    keys: deriveServerKeys(new TextEncoder().encode(`integration-${randomUUID()}-0123456789abcdef`)),
    rateLimiter: new MemoryRateLimiter(() => new Date()),
    adminOrigin: ORIGIN,
    secureCookies: false,
    now: () => new Date(),
    uuid: randomUUID,
    log: (e) => console.error("app-log", JSON.stringify(e)), // already redacted by handlers
  };
  setDepsForTesting(deps);
});

async function pairNewDevice(session: string) {
  const codeRes = await routes.pairingCode.POST(req("POST", "/api/v1/devices/pairing-code", { csrf: false, ip: `198.51.100.${Math.floor(Math.random() * 200)}` }));
  expect(codeRes.status).toBe(201);
  const code = PairingCodeResponse.parse(await codeRes.json());
  const poll = () => routes.token.POST(req("POST", "/api/v1/devices/token", { csrf: false, body: { pairing_id: code.pairing_id, poll_secret: code.poll_secret } }));
  expect((await poll()).status).toBe(202);
  const approved = await routes.pair.POST(req("POST", "/api/v1/devices/pair", { session, body: { code: code.code, device_label: "Integration TV" } }));
  return { code, poll, approved };
}

describe("pairing against real RLS", () => {
  it("owner pairs a TV; token is issued once; only hashes are stored; audit written", async () => {
    const owner = auth.sessionFor(OWNER_A);
    const { code, poll, approved } = await pairNewDevice(owner);
    expect(approved.status).toBe(200);
    const issued = await poll();
    expect(issued.status).toBe(200);
    const cred = DeviceTokenResponse.parse(await issued.json());
    expect(cred.household_id).toBe(HH_A);
    expect((await poll()).status).toBe(410);

    const [row] = await admin`select code_hash, poll_secret_hash from bnl.device_pairing_codes where pairing_id = ${code.pairing_id}`;
    expect(JSON.stringify(row)).not.toContain(code.code);
    expect(JSON.stringify(row)).not.toContain(code.poll_secret);
    const audits = await admin`select action from bnl.audit_logs where household_id = ${HH_A} and target_id = ${cred.device_id}`;
    expect(audits.map((a) => a.action)).toContain("device.pair_approved");
  });

  it("an adult with no household cannot claim a code", async () => {
    const { approved } = await pairNewDevice(auth.sessionFor(OUTSIDER));
    expect([403, 404]).toContain(approved.status);
  });
});

describe("device scope against real RLS", () => {
  async function device() {
    const { poll, approved } = await pairNewDevice(auth.sessionFor(OWNER_A));
    expect(approved.status).toBe(200);
    return DeviceTokenResponse.parse(await (await poll()).json());
  }

  it("lists only its own household's profiles", async () => {
    const cred = await device();
    const res = await routes.profiles.GET(req("GET", "/api/v1/profiles", { bearer: cred.access_token }));
    expect(res.status).toBe(200);
    const { profiles } = ProfileList.parse(await res.json());
    const ids = profiles.map((p) => p.id);
    const counted = await admin`select count(*)::int as n from bnl.learner_profiles where household_id = ${HH_A}`;
    expect(ids).toHaveLength(Number(counted[0]?.n));
    expect(ids).not.toContain(LEARNER_B1);
  });

  it("SEC-003: writing household B's learner id is refused and B's row is untouched", async () => {
    const cred = await device();
    const [before] = await admin`select display_name, updated_at from bnl.learner_profiles where id = ${LEARNER_B1}`;
    const res = await routes.profiles.POST(req("POST", "/api/v1/profiles", { bearer: cred.access_token, csrf: false, body: { id: LEARNER_B1, slot: 1, display_name: "Hijack", grade: 2, avatar_id: "fox" } }));
    expect([403, 422]).toContain(res.status);
    const [after] = await admin`select display_name, updated_at from bnl.learner_profiles where id = ${LEARNER_B1}`;
    expect(after).toEqual(before);
    expect(HH_B).not.toBe(cred.household_id);
  });

  it("SEC-004: revoked device is refused immediately", async () => {
    const owner = auth.sessionFor(OWNER_A);
    const cred = await device();
    expect((await revokeDevice(req("POST", `/api/v1/devices/${cred.device_id}/revoke`, { session: owner }), cred.device_id)).status).toBe(200);
    expect((await routes.profiles.GET(req("GET", "/api/v1/profiles", { bearer: cred.access_token }))).status).toBe(401);
    expect((await routes.refresh.POST(req("POST", "/api/v1/devices/token/refresh", { csrf: false, body: { refresh_token: cred.refresh_token } }))).status).toBe(401);
  });

  it("refresh rotation and reuse detection persist in the database", async () => {
    const cred = await device();
    const rotated = await routes.refresh.POST(req("POST", "/api/v1/devices/token/refresh", { csrf: false, body: { refresh_token: cred.refresh_token } }));
    expect(rotated.status).toBe(200);
    const reuse = await routes.refresh.POST(req("POST", "/api/v1/devices/token/refresh", { csrf: false, body: { refresh_token: cred.refresh_token } }));
    expect(reuse.status).toBe(401);
    const [dev] = await admin`select revoked_at, token_version from bnl.paired_devices where id = ${cred.device_id}`;
    expect(dev?.revoked_at).not.toBeNull();
    expect(dev?.token_version).toBe(2);
  });
});
