/**
 * Real-DB harness for the learning integration tests: app deps on the bnl_app login (RLS enforced),
 * a superuser connection for setup/assertions only, and a fresh SYNTHETIC household per test.
 */
import { randomUUID } from "node:crypto";
import { MemoryRateLimiter, deriveServerKeys, signDeviceAccessToken } from "@bnl/auth";
import { createDb, withDbContext, type Db } from "@bnl/db";
import type { DbRunner } from "../../src/server/db-port";
import { setDepsForTesting, type AppDeps } from "../../src/server/deps";
import { sqlRepos } from "../../src/server/repos";
import { FakeAdultAuth, ORIGIN } from "../fakes";

export interface DbEnv {
  db: Db;
  admin: Db;
  runner: DbRunner;
  deps: AppDeps;
  auth: FakeAdultAuth;
  close(): Promise<void>;
}

export function openDbEnv(): DbEnv {
  const url = process.env.BNL_TEST_DB_URL;
  const adminUrl = process.env.BNL_TEST_ADMIN_URL;
  if (!url || !adminUrl) throw new Error("run via: pnpm --filter @bnl/admin test:integration");
  const db = createDb(url, { max: 4 });
  const admin = createDb(adminUrl, { max: 2 });
  const runner: DbRunner = (ctx, fn) => withDbContext(db, ctx, fn);
  const auth = new FakeAdultAuth();
  const deps: AppDeps = {
    db: runner,
    repos: sqlRepos,
    adultAuth: auth,
    keys: deriveServerKeys(new TextEncoder().encode(`learning-${randomUUID()}-0123456789abcdef`)),
    rateLimiter: new MemoryRateLimiter(() => new Date()),
    adminOrigin: ORIGIN,
    secureCookies: false,
    now: () => new Date(),
    uuid: randomUUID,
    log: (e) => console.error("app-log", JSON.stringify(e)),
  };
  setDepsForTesting(deps);
  return {
    db, admin, runner, deps, auth,
    async close() {
      setDepsForTesting(null);
      await db.end();
      await admin.end();
    },
  };
}

export interface Household {
  householdId: string;
  deviceId: string;
  learners: [string, string];
  ownerUserId: string;
  token: string;
}

/** A new SYNTHETIC household with one paired device, two learners and an owner. */
export async function freshHousehold(env: DbEnv): Promise<Household> {
  const householdId = randomUUID();
  const deviceId = randomUUID();
  const learners: [string, string] = [randomUUID(), randomUUID()];
  const ownerUserId = randomUUID();
  await env.admin`insert into bnl.households (id, label) values (${householdId}, ${`SYNTHETIC A6 ${householdId.slice(0, 8)}`})`;
  await env.admin`insert into bnl.household_memberships (household_id, auth_user_id, role) values (${householdId}, ${ownerUserId}, 'owner')`;
  await env.admin`insert into bnl.paired_devices (id, household_id, label, token_version) values (${deviceId}, ${householdId}, 'SYNTHETIC A6 TV', 1)`;
  await env.admin`insert into bnl.learner_profiles (id, household_id, slot, display_name, grade, avatar_id) values
    (${learners[0]}, ${householdId}, 1, 'Synthetic One', 2, 'fox'), (${learners[1]}, ${householdId}, 2, 'Synthetic Two', 6, 'rocket')`;
  const token = (await signDeviceAccessToken(env.deps.keys.deviceToken, { deviceId, householdId, tokenVersion: 1 }, new Date())).token;
  return { householdId, deviceId, learners, ownerUserId, token };
}

/** Revokes like the adult revoke endpoint does: revoked_at + token_version bump. */
export async function revoke(env: DbEnv, deviceId: string): Promise<void> {
  await env.admin`update bnl.paired_devices set revoked_at = now(), token_version = token_version + 1 where id = ${deviceId}`;
}
