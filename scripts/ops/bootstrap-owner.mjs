#!/usr/bin/env node
/**
 * OWNER BOOTSTRAP (operator-run, once per environment). Creates the household owner's admin account with a
 * generated ONE-TIME password and the forced-change flag, then the household and the `owner` membership.
 *
 *   SUPABASE_URL=https://<project>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... BNL_MIGRATION_DB_URL=postgres://postgres:...@<direct-host>/postgres \
 *     node scripts/ops/bootstrap-owner.mjs --email <owner email> [--household-name "Our family"] [--dry-run] [--allow-insecure-local]
 *
 * The owner's email is NEVER committed: pass it with --email or BNL_OWNER_EMAIL at run time.
 *
 * Auth (Supabase GoTrue admin API, service-role key, server-side only):
 *   - no user with that email      → create it: email_confirm=true, random password, app_metadata.bnl_must_change_password=true;
 *   - exists, has never signed in  → reset it the same way (a lost one-time password is recovered by re-running);
 *   - exists and has signed in     → leave the account alone (no password is generated or printed).
 * Database (BNL_MIGRATION_DB_URL, the migration/owner login; never bnl_app): in one transaction under an advisory lock,
 *   if the user holds no active owner membership, `bnl.create_household(label)` creates the household + owner
 *   membership + audit row (as in DEPLOYMENT_RUNBOOK.md §5). Re-running is a no-op.
 *
 * Secrets: the one-time password is written to STDOUT exactly once, at the very end, and nowhere else (no file, no
 * log line, no error message). Every other message goes to STDERR and contains no secret. Store the password in a
 * password manager, give it to the owner out of band, and clear the terminal. At first sign-in the portal forces
 * the owner to choose their own password (POST /api/v1/auth/password); until then every other adult API is 403.
 *
 * Exit codes: 0 ok (including no-op), 1 failure, 2 bad arguments/configuration.
 */
import { randomInt } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const MUST_CHANGE_PASSWORD_CLAIM = "bnl_must_change_password";
export const DEFAULT_HOUSEHOLD_NAME = "Our family";
export const PASSWORD_LENGTH = 24;
/** No look-alikes (0/O, 1/l/I) so it can be read aloud or retyped from a password manager. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.!";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const PAGE_SIZE = 200;
const MAX_PAGES = 50;

export class UsageError extends Error {
  name = "UsageError";
}

/** Uniform random password (crypto.randomInt has no modulo bias). ~142 bits at the default length. */
export function generatePassword(length = PASSWORD_LENGTH, pick = (n) => randomInt(n)) {
  if (!Number.isInteger(length) || length < 20) throw new UsageError("one-time password length must be ≥ 20");
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[pick(ALPHABET.length)];
  return out;
}

export function parseArgs(argv, env = {}) {
  const opts = { email: env.BNL_OWNER_EMAIL ?? "", householdName: DEFAULT_HOUSEHOLD_NAME, dryRun: false, allowInsecureLocal: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} needs a value`);
      return v;
    };
    if (a === "--email") opts.email = value();
    else if (a.startsWith("--email=")) opts.email = a.slice("--email=".length);
    else if (a === "--household-name") opts.householdName = value();
    else if (a.startsWith("--household-name=")) opts.householdName = a.slice("--household-name=".length);
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--allow-insecure-local") opts.allowInsecureLocal = true;
    else throw new UsageError(`unknown argument: ${a.split("=")[0]}`);
  }
  opts.email = opts.email.trim().toLowerCase();
  opts.householdName = opts.householdName.trim();
  if (!EMAIL.test(opts.email) || opts.email.length > 254) throw new UsageError("--email (or BNL_OWNER_EMAIL) must be a valid email address");
  if (opts.householdName.length < 1 || opts.householdName.length > 60) throw new UsageError("--household-name must be 1–60 characters (no child names)");
  return opts;
}

/** https only; plain http solely for a local Supabase and only with --allow-insecure-local. */
export function checkSupabaseUrl(raw, allowInsecureLocal) {
  let url;
  try {
    url = new URL(raw ?? "");
  } catch {
    throw new UsageError("SUPABASE_URL is not set or not a valid URL");
  }
  if (url.username || url.password) throw new UsageError("SUPABASE_URL must not contain credentials");
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && allowInsecureLocal && LOCAL_HOSTS.has(url.hostname)) return url.origin;
  throw new UsageError(
    url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname)
      ? "refusing plain-http SUPABASE_URL; pass --allow-insecure-local for a local Supabase"
      : "refusing non-https SUPABASE_URL (the service-role key and a password would travel in clear)",
  );
}

/** Masks an email for operator messages: o***@example.com. */
export function maskEmail(email) {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

function adminApi(base, serviceRoleKey, fetchImpl) {
  const headers = { apikey: serviceRoleKey, authorization: `Bearer ${serviceRoleKey}` };
  const call = async (method, path, body) => {
    const res = await fetchImpl(`${base}/auth/v1/admin${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // Status only: response bodies can echo the request (and so the password).
    if (!res.ok) throw new Error(`Supabase admin API ${method} ${path.split("?")[0].replace(/[0-9a-f-]{36}/, "{id}")} responded ${res.status}`);
    return res.json();
  };
  return {
    async findByEmail(email) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const body = await call("GET", `/users?page=${page}&per_page=${PAGE_SIZE}`);
        const users = Array.isArray(body?.users) ? body.users : [];
        const hit = users.find((u) => typeof u?.email === "string" && u.email.toLowerCase() === email);
        if (hit) return hit;
        if (users.length < PAGE_SIZE) return null;
      }
      throw new Error(`more than ${PAGE_SIZE * MAX_PAGES} auth users; refusing to guess`);
    },
    create: (email, password) =>
      call("POST", "/users", { email, password, email_confirm: true, app_metadata: { [MUST_CHANGE_PASSWORD_CLAIM]: true } }),
    reset: (id, password) =>
      call("PUT", `/users/${encodeURIComponent(id)}`, { password, email_confirm: true, app_metadata: { [MUST_CHANGE_PASSWORD_CLAIM]: true } }),
  };
}

const ACTIVE_OWNER = (tx, userId) =>
  tx`select household_id from bnl.household_memberships
      where auth_user_id = ${userId} and role = 'owner' and active and revoked_at is null`;

/**
 * Idempotent: one transaction, serialised by an advisory lock; acts as bnl_owner (owner_all policies, FORCE RLS)
 * and creates the household through the audited bnl.create_household with the owner as actor.
 */
export async function ensureOwnerHousehold(sql, userId, label) {
  return sql.begin(async (tx) => {
    await tx`set local role bnl_owner`;
    await tx`select pg_advisory_xact_lock(hashtext('bnl.bootstrap_owner'))`;
    const existing = await ACTIVE_OWNER(tx, userId);
    if (existing.length > 0) return { created: false, householdId: existing[0].household_id };
    await tx`select set_config('bnl.actor_id', ${userId}, true)`;
    const [row] = await tx`select bnl.create_household(${label}, 'Asia/Kolkata') as id`;
    return { created: true, householdId: row.id };
  });
}

/**
 * Core logic with injected I/O (tests pass a fake GoTrue `fetch` and a throwaway-Postgres `sql`).
 * `stdout` receives only the one-time password block; `stderr` receives progress without secrets.
 */
export async function bootstrapOwner({
  email,
  householdName = DEFAULT_HOUSEHOLD_NAME,
  dryRun = false,
  allowInsecureLocal = false,
  supabaseUrl,
  serviceRoleKey,
  fetch: fetchImpl,
  sql,
  stdout,
  stderr,
  newPassword = () => generatePassword(),
}) {
  const base = checkSupabaseUrl(supabaseUrl, allowInsecureLocal);
  if (!serviceRoleKey || /^replace-with/i.test(serviceRoleKey)) throw new UsageError("SUPABASE_SERVICE_ROLE_KEY is not set");
  if (!sql) throw new UsageError("BNL_MIGRATION_DB_URL is not set");
  const say = (msg) => stderr(`[bootstrap-owner] ${msg}\n`);
  const api = adminApi(base, serviceRoleKey, fetchImpl);

  const existing = await api.findByEmail(email);
  const signedIn = Boolean(existing?.last_sign_in_at);
  const authAction = !existing ? "create" : signedIn ? "keep" : "reset";
  say(`owner ${maskEmail(email)}: auth user ${existing ? `exists (${signedIn ? "has signed in" : "never signed in"})` : "does not exist"} → ${authAction}`);

  if (dryRun) {
    let household = "unknown (user not created yet)";
    if (existing?.id) {
      const rows = await sql.begin(async (tx) => {
        await tx`set local role bnl_owner`;
        return ACTIVE_OWNER(tx, existing.id);
      });
      household = rows.length > 0 ? "owner membership exists → keep" : `none → would create "${householdName}"`;
    }
    say(`household: ${household}`);
    say("dry run: nothing was changed and no password was generated");
    return { dryRun: true, authAction, householdCreated: false, userId: existing?.id ?? null, passwordIssued: false };
  }

  let password = null;
  let userId = existing?.id ?? null;
  if (authAction === "create") {
    password = newPassword();
    const created = await api.create(email, password);
    userId = typeof created?.id === "string" ? created.id : (created?.user?.id ?? null);
  } else if (authAction === "reset") {
    password = newPassword();
    await api.reset(userId, password);
  } else {
    say("the owner has already signed in: account left unchanged (use the normal password-reset flow if needed)");
  }
  if (typeof userId !== "string" || !/^[0-9a-f-]{36}$/i.test(userId)) throw new Error("Supabase admin API returned no user id");

  const household = await ensureOwnerHousehold(sql, userId.toLowerCase(), householdName);
  say(household.created ? `household created (${household.householdId}) with the owner membership` : `owner membership already present (${household.householdId}) → unchanged`);
  say(`auth user id: ${userId}`);

  if (password !== null) {
    stdout(
      "\nONE-TIME OWNER PASSWORD — shown once. Store it in a password manager now, hand it to the owner out of band,\n" +
        "then clear this terminal. The owner must replace it at first sign-in.\n" +
        `${password}\n\n`,
    );
  }
  return { dryRun: false, authAction, householdCreated: household.created, householdId: household.householdId, userId, passwordIssued: password !== null };
}

async function main() {
  const stderr = (s) => process.stderr.write(s);
  let sql = null;
  try {
    const opts = parseArgs(process.argv.slice(2), process.env);
    const dbUrl = process.env.BNL_MIGRATION_DB_URL;
    if (dbUrl) {
      // postgres is a dependency of @bnl/db; resolve it from there (the repo root has no node_modules entry for it).
      const require = createRequire(new URL("../../packages/db/package.json", import.meta.url));
      const postgres = require("postgres");
      sql = postgres(dbUrl, { max: 1, prepare: false, onnotice: () => undefined, connection: { application_name: "bnl-bootstrap-owner" } });
    }
    await bootstrapOwner({
      ...opts,
      supabaseUrl: process.env.SUPABASE_URL,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      fetch: globalThis.fetch,
      sql,
      stdout: (s) => process.stdout.write(s),
      stderr,
    });
    process.exitCode = 0;
  } catch (err) {
    // Messages are built above without secrets; never print a stack (it could include argument values).
    stderr(`[bootstrap-owner] error: ${err instanceof Error ? err.message : "failed"}\n`);
    process.exitCode = err instanceof UsageError ? 2 : 1;
  } finally {
    if (sql) await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
