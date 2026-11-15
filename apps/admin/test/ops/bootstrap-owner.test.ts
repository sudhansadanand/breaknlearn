/**
 * scripts/ops/bootstrap-owner.mjs unit tests (no DB: a small fake `sql`; the real-schema run is in
 * test/integration/bootstrap-owner-db.test.ts). Synthetic email only — the owner's real email is never committed.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain .mjs operator script without type declarations
import * as script from "../../../../scripts/ops/bootstrap-owner.mjs";
import { fakeGoTrue } from "./fake-gotrue";

type Bootstrap = (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
const { bootstrapOwner, parseArgs, generatePassword, checkSupabaseUrl, maskEmail, UsageError } = script as {
  bootstrapOwner: Bootstrap;
  parseArgs: (argv: string[], env?: Record<string, string>) => { email: string; householdName: string; dryRun: boolean; allowInsecureLocal: boolean };
  generatePassword: (length?: number) => string;
  checkSupabaseUrl: (url: string | undefined, allowInsecureLocal: boolean) => string;
  maskEmail: (email: string) => string;
  UsageError: new (m: string) => Error;
};

const SCRIPT = fileURLToPath(new URL("../../../../scripts/ops/bootstrap-owner.mjs", import.meta.url));
const BASE = "https://project.supabase.example";
const KEY = "test-service-role-key-not-real";
const EMAIL = "owner@example.test";

/** Minimal stand-in for postgres.js: enough for ensureOwnerHousehold's statements. */
function fakeSql() {
  const memberships: { household_id: string; auth_user_id: string; label: string }[] = [];
  const statements: string[] = [];
  let actor: string | null = null;
  let n = 0;
  const tx = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("$").replace(/\s+/g, " ").trim();
    statements.push(text);
    if (text.includes("set_config('bnl.actor_id'")) actor = String(values[0]);
    if (text.includes("from bnl.household_memberships")) return memberships.filter((m) => m.auth_user_id === values[0]).map((m) => ({ household_id: m.household_id }));
    if (text.includes("bnl.create_household")) {
      const id = `aaaaaaaa-0000-4000-8000-${String(++n).padStart(12, "0")}`;
      memberships.push({ household_id: id, auth_user_id: actor!, label: String(values[0]) });
      return [{ id }];
    }
    return [];
  };
  return { memberships, statements, sql: { begin: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx) } };
}

function harness(overrides: Record<string, unknown> = {}) {
  const gotrue = fakeGoTrue(BASE, KEY);
  const db = fakeSql();
  const out: string[] = [];
  const err: string[] = [];
  const run = (extra: Record<string, unknown> = {}) =>
    bootstrapOwner({
      email: EMAIL,
      supabaseUrl: BASE,
      serviceRoleKey: KEY,
      fetch: gotrue.fetch,
      sql: db.sql,
      stdout: (s: string) => out.push(s),
      stderr: (s: string) => err.push(s),
      ...overrides,
      ...extra,
    });
  return { gotrue, db, out, err, run };
}

const count = (hay: string, needle: string) => hay.split(needle).length - 1;

describe("bootstrap-owner: core", () => {
  it("creates the user with a one-time password + must-change flag, then the household; prints the password exactly once", async () => {
    const h = harness();
    const res = await h.run();
    expect(res).toMatchObject({ authAction: "create", householdCreated: true, passwordIssued: true });
    const [user] = h.gotrue.users;
    expect(user).toMatchObject({ email: EMAIL, email_confirmed: true, app_metadata: { bnl_must_change_password: true }, last_sign_in_at: null });
    expect(user!.password).toMatch(/^[A-Za-z0-9\-_.!]{24}$/);
    expect(h.db.memberships).toEqual([{ household_id: expect.any(String), auth_user_id: user!.id, label: "Our family" }]);
    // Acts as bnl_owner, serialised, through the audited function with the owner as actor.
    expect(h.db.statements[0]).toBe("set local role bnl_owner");
    expect(h.db.statements.some((s) => s.includes("pg_advisory_xact_lock"))).toBe(true);

    const stdout = h.out.join("");
    const stderr = h.err.join("");
    expect(count(stdout, user!.password)).toBe(1);
    expect(stdout).toMatch(/password manager/);
    expect(stderr).not.toContain(user!.password);
    expect(stderr).not.toContain(KEY);
    expect(stderr).not.toContain(EMAIL); // masked
    expect(stderr).toContain(maskEmail(EMAIL));
    // Only the create call carries the password; the key only travels in the Authorization header.
    expect(h.gotrue.requests.filter((r) => r.body.includes(user!.password)).map((r) => r.method)).toEqual(["POST"]);
  });

  it("is idempotent: a re-run before first sign-in resets the password (new one, printed once) and keeps one household", async () => {
    const h = harness();
    await h.run();
    const first = h.gotrue.users[0]!.password;
    h.out.length = 0;
    const res = await h.run();
    expect(res).toMatchObject({ authAction: "reset", householdCreated: false, passwordIssued: true });
    expect(h.gotrue.users).toHaveLength(1);
    const second = h.gotrue.users[0]!.password;
    expect(second).not.toBe(first);
    expect(h.gotrue.users[0]!.app_metadata.bnl_must_change_password).toBe(true);
    expect(h.db.memberships).toHaveLength(1);
    expect(count(h.out.join(""), second)).toBe(1);
    expect(h.out.join("")).not.toContain(first);
  });

  it("never touches an account that has already signed in, and prints no password", async () => {
    const h = harness();
    await h.run();
    const user = h.gotrue.users[0]!;
    user.last_sign_in_at = "2026-11-15T09:00:00Z";
    user.app_metadata.bnl_must_change_password = false;
    const before = user.password;
    h.out.length = 0;
    const res = await h.run();
    expect(res).toMatchObject({ authAction: "keep", householdCreated: false, passwordIssued: false });
    expect(user.password).toBe(before);
    expect(user.app_metadata.bnl_must_change_password).toBe(false);
    expect(h.gotrue.requests.filter((r) => r.method !== "GET").length).toBe(1); // only the original create
    expect(h.out.join("")).toBe("");
  });

  it("finds an existing user beyond the first page", async () => {
    const h = harness();
    for (let i = 0; i < 250; i++) await h.gotrue.fetch(`${BASE}/auth/v1/admin/users`, { method: "POST", headers: { apikey: KEY, authorization: `Bearer ${KEY}` }, body: JSON.stringify({ email: `u${i}@example.test`, password: "x" }) });
    await h.gotrue.fetch(`${BASE}/auth/v1/admin/users`, { method: "POST", headers: { apikey: KEY, authorization: `Bearer ${KEY}` }, body: JSON.stringify({ email: EMAIL, password: "x" }) });
    const res = await h.run();
    expect(res.authAction).toBe("reset");
    expect(h.gotrue.users).toHaveLength(251);
  });

  it("dry run changes nothing, generates no password and prints nothing to stdout", async () => {
    const h = harness();
    let generated = 0;
    const res = await h.run({ dryRun: true, newPassword: () => (generated++, "x".repeat(24)) });
    expect(res).toMatchObject({ dryRun: true, authAction: "create", passwordIssued: false });
    expect(generated).toBe(0);
    expect(h.gotrue.users).toHaveLength(0);
    expect(h.gotrue.requests.every((r) => r.method === "GET")).toBe(true);
    expect(h.db.memberships).toHaveLength(0);
    expect(h.out.join("")).toBe("");
    expect(h.err.join("")).toMatch(/dry run: nothing was changed/);
  });

  it("refuses non-https Supabase URLs unless --allow-insecure-local on a loopback host", async () => {
    for (const url of ["http://project.supabase.example", "http://10.0.0.5:54321", "ftp://x", "not a url", undefined]) {
      const h = harness({ supabaseUrl: url });
      await expect(h.run()).rejects.toBeInstanceOf(UsageError);
      await expect(h.run({ allowInsecureLocal: true })).rejects.toBeInstanceOf(UsageError);
      expect(h.gotrue.requests).toHaveLength(0);
    }
    expect(() => checkSupabaseUrl("http://127.0.0.1:54321", false)).toThrow(/allow-insecure-local/);
    expect(checkSupabaseUrl("http://127.0.0.1:54321", true)).toBe("http://127.0.0.1:54321");
    expect(checkSupabaseUrl("https://x.example/", false)).toBe("https://x.example");
    expect(() => checkSupabaseUrl("https://user:pw@x.example", false)).toThrow(/credentials/);
  });

  it("refuses a missing/placeholder service key or DB URL before calling anything", async () => {
    for (const o of [{ serviceRoleKey: "" }, { serviceRoleKey: "replace-with-local-service-role-key" }, { sql: null }]) {
      const h = harness(o);
      await expect(h.run()).rejects.toBeInstanceOf(UsageError);
      expect(h.gotrue.requests).toHaveLength(0);
    }
  });

  it("an API failure reports the status only (no body, no password) and prints no password", async () => {
    const h = harness();
    const failing = async (url: string, init?: { method?: string }) =>
      init?.method === "POST" ? new Response(JSON.stringify({ echoed: "secret-ish" }), { status: 500 }) : h.gotrue.fetch(url, init);
    const err = await h.run({ fetch: failing }).catch((e: Error) => e);
    expect(String(err)).toMatch(/POST \/users responded 500/);
    expect(String(err)).not.toContain("secret-ish");
    expect(h.out.join("")).toBe("");
    expect(h.db.memberships).toHaveLength(0);
  });
});

describe("bootstrap-owner: arguments and password", () => {
  it("parses flags, env fallback and defaults; rejects bad input", () => {
    expect(parseArgs(["--email", " Owner@Example.TEST "])).toEqual({ email: EMAIL, householdName: "Our family", dryRun: false, allowInsecureLocal: false });
    expect(parseArgs(["--household-name=Home", "--dry-run", "--allow-insecure-local"], { BNL_OWNER_EMAIL: EMAIL })).toEqual({
      email: EMAIL, householdName: "Home", dryRun: true, allowInsecureLocal: true,
    });
    expect(() => parseArgs([])).toThrow(/--email/);
    expect(() => parseArgs(["--email", "nope"])).toThrow(/valid email/);
    expect(() => parseArgs(["--email", EMAIL, "--household-name", "x".repeat(61)])).toThrow(/1–60/);
    expect(() => parseArgs(["--email", EMAIL, "--password", "x"])).toThrow(/unknown argument: --password/);
    expect(() => parseArgs(["--email"])).toThrow(/needs a value/);
  });

  it("generates long, varied passwords from the unambiguous alphabet", () => {
    const seen = new Set(Array.from({ length: 50 }, () => generatePassword()));
    expect(seen.size).toBe(50);
    for (const p of seen) expect(p).toMatch(/^[A-HJ-NP-Za-km-z2-9\-_.!]{24}$/);
    expect(() => generatePassword(12)).toThrow();
  });

  it("CLI: refuses an insecure URL with exit 2, prints nothing on stdout, never echoes the key", () => {
    const r = spawnSync(process.execPath, [SCRIPT, "--email", EMAIL], {
      env: { NODE_ENV: "test", PATH: process.env.PATH, SUPABASE_URL: "http://project.supabase.example", SUPABASE_SERVICE_ROLE_KEY: KEY, BNL_MIGRATION_DB_URL: "" },
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/refusing non-https SUPABASE_URL/);
    expect(r.stderr).not.toContain(KEY);
  });

  it("CLI: bad arguments exit 2", () => {
    const r = spawnSync(process.execPath, [SCRIPT, "--nope"], { env: { NODE_ENV: "test", PATH: process.env.PATH }, encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
  });
});
