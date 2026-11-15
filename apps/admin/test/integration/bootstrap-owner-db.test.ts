/**
 * scripts/ops/bootstrap-owner.mjs against the real schema in the throwaway Postgres (scripts/db/test-db.mjs) and a
 * fake GoTrue admin API served over loopback HTTP: the actual CLI process (postgres.js resolution, stdout/stderr
 * discipline, exit codes) plus the importable core under concurrency. Synthetic email only.
 */
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, withDbContext, type Db } from "@bnl/db";
// @ts-expect-error -- plain .mjs operator script without type declarations
import * as script from "../../../../scripts/ops/bootstrap-owner.mjs";
import { sqlRepos } from "../../src/server/repos";
import { fakeGoTrue, type FakeGoTrue } from "../ops/fake-gotrue";

const { ensureOwnerHousehold } = script as { ensureOwnerHousehold: (sql: Db, userId: string, label: string) => Promise<{ created: boolean; householdId: string }> };

const appUrl = process.env.BNL_TEST_DB_URL;
const adminUrl = process.env.BNL_TEST_ADMIN_URL;
if (!appUrl || !adminUrl) throw new Error("run via: pnpm --filter @bnl/admin test:integration");

const SCRIPT = fileURLToPath(new URL("../../../../scripts/ops/bootstrap-owner.mjs", import.meta.url));
const KEY = "integration-service-role-key-not-real";
const EMAIL = "bootstrap-owner@example.test";

let admin: Db;
let app: Db;
let server: Server;
let base: string;
let gotrue: FakeGoTrue;

beforeAll(async () => {
  admin = createDb(adminUrl, { max: 4 });
  app = createDb(appUrl, { max: 2 });
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
    const body = Buffer.concat(chunks).toString("utf8");
    const r = await gotrue.fetch(`${base}${req.url}`, { method: req.method ?? "GET", headers, ...(body ? { body } : {}) });
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(await r.text());
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  gotrue = fakeGoTrue(base, KEY);
});
afterAll(async () => {
  await new Promise((ok) => server.close(ok));
  await admin.end();
  await app.end();
});

function cli(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((ok) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", SUPABASE_URL: base, SUPABASE_SERVICE_ROLE_KEY: KEY, BNL_MIGRATION_DB_URL: adminUrl!, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => ok({ code, stdout, stderr }));
  });
}

async function ownerRows(userId: string) {
  return admin<{ household_id: string; role: string; label: string }[]>`
    select m.household_id, m.role, h.label from bnl.household_memberships m join bnl.households h on h.id = m.household_id
     where m.auth_user_id = ${userId} and m.revoked_at is null`;
}

describe("bootstrap-owner CLI against the real schema", () => {
  it("refuses plain http without --allow-insecure-local (nothing created)", async () => {
    const r = await cli(["--email", EMAIL]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(gotrue.requests).toHaveLength(0);
  });

  it("dry run: no user, no household, no password", async () => {
    const r = await cli(["--email", EMAIL, "--allow-insecure-local", "--dry-run"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe("");
    expect(gotrue.users).toHaveLength(0);
  });

  it("creates the flagged user, the household and the owner membership (audited); the password appears once on stdout only", async () => {
    const r = await cli(["--email", EMAIL, "--allow-insecure-local", "--household-name", "SYNTHETIC Bootstrap Home"], { BNL_OWNER_EMAIL: "ignored@example.test" });
    expect(r.code, r.stderr).toBe(0);
    const [user] = gotrue.users;
    expect(user).toMatchObject({ email: EMAIL, email_confirmed: true, app_metadata: { bnl_must_change_password: true } });
    expect(r.stdout.split(user!.password).length - 1).toBe(1);
    expect(r.stderr).not.toContain(user!.password);
    expect(r.stderr).not.toContain(KEY);
    expect(r.stderr).not.toContain(adminUrl!);

    const rows = await ownerRows(user!.id);
    expect(rows).toEqual([{ household_id: expect.any(String), role: "owner", label: "SYNTHETIC Bootstrap Home" }]);
    const audit = await admin`select actor_auth_id, action, metadata from bnl.audit_logs where household_id = ${rows[0]!.household_id}`;
    expect(audit).toEqual([{ actor_auth_id: user!.id, action: "household.create", metadata: {} }]);
    // Nothing anywhere in the DB holds the password.
    const leaks = await admin`select count(*)::int as n from bnl.audit_logs where metadata::text like ${"%" + user!.password + "%"}`;
    expect(leaks[0]!.n).toBe(0);

    // The owner sees exactly that household through the request role (RLS), like the portal will.
    const memberships = await withDbContext(app, { kind: "adult", userId: user!.id }, (sql) => sqlRepos.memberships.activeMemberships(sql, user!.id));
    expect(memberships).toEqual([{ householdId: rows[0]!.household_id, role: "owner" }]);
  });

  it("re-running is idempotent: same single household; before first sign-in the password is reset and reprinted once", async () => {
    const before = gotrue.users[0]!.password;
    const r = await cli(["--email", EMAIL, "--allow-insecure-local"]);
    expect(r.code, r.stderr).toBe(0);
    expect(gotrue.users).toHaveLength(1);
    const after = gotrue.users[0]!.password;
    expect(after).not.toBe(before);
    expect(r.stdout.split(after).length - 1).toBe(1);
    expect(r.stdout).not.toContain(before);
    expect(await ownerRows(gotrue.users[0]!.id)).toHaveLength(1);
  });

  it("after first sign-in: account untouched, nothing printed, still one household", async () => {
    const user = gotrue.users[0]!;
    user.last_sign_in_at = new Date().toISOString();
    const pw = user.password;
    const r = await cli(["--email", EMAIL, "--allow-insecure-local"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe("");
    expect(user.password).toBe(pw);
    expect(await ownerRows(user.id)).toHaveLength(1);
    const dry = await cli(["--email", EMAIL, "--allow-insecure-local", "--dry-run"]);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stderr).toMatch(/→ keep[\s\S]*owner membership exists → keep/);
    expect(dry.stdout).toBe("");
  });

  it("ensureOwnerHousehold is safe under concurrent runs (advisory lock): one household", async () => {
    const userId = "d1d1d1d1-0000-4000-8000-000000000001";
    const results = await Promise.all([1, 2, 3].map(() => ensureOwnerHousehold(admin, userId, "SYNTHETIC Concurrent")));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.householdId)).size).toBe(1);
    expect(await ownerRows(userId)).toHaveLength(1);
  });
});
