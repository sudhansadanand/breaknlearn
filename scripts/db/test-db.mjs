#!/usr/bin/env node
// Throwaway PostgreSQL harness for BreakNLearn DB tests. Node built-ins only.
//
//   node scripts/db/test-db.mjs [--keep] [--] <command> [args...]
//
// 1. initdb a temporary cluster (scram auth, random passwords) and start it on a free localhost port;
// 2. create `bnl_test` and apply supabase/migrations/*.sql, supabase/seed/*.sql (core seeds) and
//    supabase/seed/dev_synthetic.sql (SYNTHETIC test data);
// 3. create `bnl_fresh_a` (migrated FIRST by a non-superuser CREATEROLE login, as on Supabase) and `bnl_fresh_b`
//    with migrations + core seeds, and re-apply the migrations to both (migrations must apply cleanly on fresh
//    databases in one cluster, without superuser, and be re-runnable);
// 4. set a random password for the LOGIN role bnl_app and export
//      BNL_TEST_DB_URL         postgres://bnl_app:...@127.0.0.1:<port>/bnl_test   (request-path role)
//      BNL_TEST_ADMIN_URL      postgres://postgres:...@127.0.0.1:<port>/bnl_test  (superuser, test setup only)
//      BNL_TEST_FRESH_DB_URLS  comma-separated superuser URLs of the fresh databases
// 5. run <command>, then stop the cluster and delete the directory (unless --keep).
//
// Env: BNL_PG_BIN (default /usr/lib/postgresql/16/bin). When run as root, server binaries run as the
// `postgres` OS user (initdb refuses root).
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chownSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PG_BIN = process.env.BNL_PG_BIN ?? "/usr/lib/postgresql/16/bin";
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");
const SEED_DIR = join(ROOT, "supabase", "seed");
const SYNTHETIC_SEED = "dev_synthetic.sql";

const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const rest = argv.filter((a) => a !== "--keep");
const command = rest[0] === "--" ? rest.slice(1) : rest;

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

function log(msg) {
  console.log(`[test-db] ${msg}`);
}

function run(cmd, args, { asPostgres = false, env = {}, input } = {}) {
  const full = asPostgres && isRoot ? ["runuser", ["-u", "postgres", "--", cmd, ...args]] : [cmd, args];
  const res = spawnSync(full[0], full[1], { env: { ...process.env, ...env }, encoding: "utf8", input });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${res.status}):\n${res.stdout ?? ""}${res.stderr ?? ""}`);
  }
  return res.stdout;
}

function freePort() {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.once("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === "object" && addr ? ok(addr.port) : fail(new Error("no port"))));
    });
  });
}

function sqlFiles(dir, filter) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && filter(f))
    .sort()
    .map((f) => join(dir, f));
}

const dir = mkdtempSync(join(tmpdir(), "bnl-pg-"));
const dataDir = join(dir, "data");
const superPassword = randomBytes(24).toString("hex");
const appPassword = randomBytes(24).toString("hex");
const migratorPassword = randomBytes(24).toString("hex");
let started = false;

function teardown() {
  if (started) {
    spawnSync(...(isRoot
      ? ["runuser", ["-u", "postgres", "--", join(PG_BIN, "pg_ctl"), "-D", dataDir, "-m", "immediate", "-w", "stop"]]
      : [join(PG_BIN, "pg_ctl"), ["-D", dataDir, "-m", "immediate", "-w", "stop"]]), { stdio: "ignore" });
    started = false;
  }
  if (!keep) rmSync(dir, { recursive: true, force: true });
  else log(`kept ${dir}`);
}

async function main() {
  const pwFile = join(dir, "pw");
  writeFileSync(pwFile, `${superPassword}\n`, { mode: 0o600 });
  if (isRoot) {
    const uid = Number(run("id", ["-u", "postgres"]).trim());
    const gid = Number(run("id", ["-g", "postgres"]).trim());
    chownSync(dir, uid, gid);
    chownSync(pwFile, uid, gid);
  }
  run(join(PG_BIN, "initdb"), ["-D", dataDir, "-U", "postgres", "--auth=scram-sha-256", `--pwfile=${pwFile}`,
    "-E", "UTF8", "--no-locale"], { asPostgres: true });

  const port = await freePort();
  run(join(PG_BIN, "pg_ctl"), ["-D", dataDir, "-l", join(dir, "server.log"), "-w", "-o",
    `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off`,
    "start"], { asPostgres: true });
  started = true;
  log(`postgres up on 127.0.0.1:${port} (${dir})`);

  const psqlEnv = { PGPASSWORD: superPassword, PGHOST: "127.0.0.1", PGPORT: String(port), PGUSER: "postgres" };
  const psql = (db, args) => run(join(PG_BIN, "psql"), ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", db, ...args], { env: psqlEnv });
  const applyFile = (db, file) => psql(db, ["-1", "-f", file]);

  const migrations = sqlFiles(MIGRATIONS_DIR, () => true);
  const coreSeeds = sqlFiles(SEED_DIR, (f) => f !== SYNTHETIC_SEED);

  // Supabase-like first: `bnl_fresh_a` is migrated by a NON-superuser CREATEROLE login (like Supabase's `postgres`)
  // while the cluster has no bnl roles yet, so it creates them and gets PostgreSQL 16+'s ADMIN-only self-grant.
  psql("postgres", ["-c", `create role supabase_like_migrator login createrole password '${migratorPassword}'`]);
  psql("postgres", ["-c", "create database bnl_fresh_a owner supabase_like_migrator"]);
  const migratorEnv = { ...psqlEnv, PGUSER: "supabase_like_migrator", PGPASSWORD: migratorPassword };
  const applyAsMigrator = (db, file) =>
    run(join(PG_BIN, "psql"), ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", db, "-1", "-f", file], { env: migratorEnv });
  for (const f of [...migrations, ...coreSeeds]) applyAsMigrator("bnl_fresh_a", f);
  for (const f of migrations) applyAsMigrator("bnl_fresh_a", f); // re-run as the non-superuser too

  for (const db of ["bnl_test", "bnl_fresh_b"]) {
    psql("postgres", ["-c", `create database ${db}`]);
    for (const f of [...migrations, ...coreSeeds]) applyFile(db, f);
  }
  for (const f of migrations) applyFile("bnl_fresh_b", f); // re-run on an existing schema
  applyFile("bnl_test", join(SEED_DIR, SYNTHETIC_SEED));
  log(`applied ${migrations.length} migrations, ${coreSeeds.length} core seeds, synthetic seed`);

  psql("postgres", ["-c", `alter role bnl_app with login password '${appPassword}'`]);

  const base = `127.0.0.1:${port}`;
  const env = {
    BNL_TEST_DB_URL: `postgres://bnl_app:${appPassword}@${base}/bnl_test`,
    BNL_TEST_ADMIN_URL: `postgres://postgres:${superPassword}@${base}/bnl_test`,
    BNL_TEST_FRESH_DB_URLS: ["bnl_fresh_a", "bnl_fresh_b"].map((d) => `postgres://postgres:${superPassword}@${base}/${d}`).join(","),
  };

  if (command.length === 0) {
    log("no command given; database setup verified");
    return 0;
  }
  log(`running: ${command.join(" ")}`);
  return await new Promise((ok) => {
    const child = spawn(command[0], command.slice(1), { stdio: "inherit", env: { ...process.env, ...env } });
    child.on("exit", (code, signal) => ok(code ?? (signal ? 1 : 0)));
    child.on("error", (err) => {
      console.error(err);
      ok(1);
    });
  });
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    teardown();
    process.exit(130);
  });
}

main().then(
  (code) => {
    teardown();
    process.exit(code);
  },
  (err) => {
    console.error(`[test-db] ${err instanceof Error ? err.message : String(err)}`);
    teardown();
    process.exit(1);
  },
);
