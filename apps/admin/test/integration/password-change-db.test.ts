/**
 * POST /api/v1/auth/password against the real schema/RLS: the audit row is written under the adult's own context
 * for a household member and under the job role for an adult without a household; neither holds the password.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryRateLimiter, deriveServerKeys, type AdultIdentity } from "@bnl/auth";
import { createDb, withDbContext, type Db } from "@bnl/db";
import * as password from "../../src/app/api/v1/auth/password/route";
import { setDepsForTesting, type AppDeps } from "../../src/server/deps";
import { sqlRepos } from "../../src/server/repos";
import { FakeAdultAuth, ORIGIN, OUTSIDER, OWNER_A, req } from "../fakes";
import { routes } from "../routes";

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
    log: () => undefined,
  };
  setDepsForTesting(deps);
});

const ONE_TIME = "one-time-PW-integration-01";
const NEW_PW = "integration passphrase of my own";

async function change(identity: AdultIdentity) {
  const flagged = { ...identity, mustChangePassword: true as const };
  auth.passwords.set(identity.email, { password: ONE_TIME, identity: flagged });
  const session = auth.sessionFor(flagged);
  // Gated first: a household read is refused while the flag is set.
  expect((await routes.devices.GET(req("GET", "/api/v1/devices", { session }))).status).toBe(403);
  const res = await password.POST(req("POST", "/api/v1/auth/password", { session, body: { current_password: ONE_TIME, new_password: NEW_PW } }));
  expect(res.status).toBe(200);
  return res;
}

describe("password change audit (real RLS)", () => {
  it("household owner: audited in their household as a user action", async () => {
    await change(OWNER_A);
    const rows = await admin`select actor_type, actor_auth_id, household_id, action, target_type, metadata from bnl.audit_logs
                              where action = 'auth.password_changed' and actor_auth_id = ${OWNER_A.userId}`;
    expect(rows).toEqual([
      { actor_type: "user", actor_auth_id: OWNER_A.userId, household_id: "aaaaaaaa-0000-4000-8000-00000000000a", action: "auth.password_changed", target_type: "auth_user", metadata: { forced: true } },
    ]);
  });

  it("adult without a household: audited by the job role with no household", async () => {
    await change(OUTSIDER);
    const rows = await admin`select actor_type, household_id, metadata::text as m from bnl.audit_logs
                              where action = 'auth.password_changed' and actor_auth_id = ${OUTSIDER.userId}`;
    expect(rows).toEqual([{ actor_type: "job", household_id: null, m: '{"forced": true}' }]);
    const leaks = await admin`select count(*)::int as n from bnl.audit_logs where metadata::text like ${"%" + NEW_PW + "%"} or metadata::text like ${"%" + ONE_TIME + "%"}`;
    expect(leaks[0]!.n).toBe(0);
  });
});
