#!/usr/bin/env node
/**
 * Local BACKUP/RESTORE REHEARSAL (A9, OPS-002, spec M13 "restore rehearsal"). Runs entirely inside the throwaway
 * cluster of scripts/db/test-db.mjs; never touches Supabase or any real database.
 *
 *   node scripts/ops/rehearse-backup-restore.mjs
 *
 * 1. pg_dump -Fc of the migrated + seeded database (schema bnl, data, grants, RLS policies, function owners);
 * 2. pg_restore into a NEW database in the same cluster (cluster roles already exist, as they would on a
 *    Supabase project after migration 0001; see docs/ops/BACKUP_RESTORE.md for a fresh cluster);
 * 3. verifies: identical row counts per table, RLS enabled+forced everywhere, identical policies, table ACLs,
 *    function owners/ACLs, SECURITY DEFINER search_path, and a functional RLS check through the bnl_app login
 *    (a device context of household A sees only household A's learners);
 * 4. prints one JSON line with sizes and timings (the evidence recorded in BACKUP_RESTORE.md).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
if (!process.env.BNL_TEST_ADMIN_URL) {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts/db/test-db.mjs"), "--", process.execPath, fileURLToPath(import.meta.url)], { stdio: "inherit", cwd: ROOT });
  process.exit(r.status ?? 1);
}

const PG_BIN = process.env.BNL_PG_BIN ?? "/usr/lib/postgresql/16/bin";
const adminUrl = new URL(process.env.BNL_TEST_ADMIN_URL);
const appUrl = new URL(process.env.BNL_TEST_DB_URL);
const SOURCE = adminUrl.pathname.slice(1);
const TARGET = "bnl_restore_rehearsal";
const urlFor = (u, db) => { const x = new URL(u); x.pathname = `/${db}`; return x.toString(); };
const log = (m) => console.error(`[rehearse-backup] ${m}`);

function run(bin, args, { input } = {}) {
  const r = spawnSync(join(PG_BIN, bin), args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${bin} ${args.filter((a) => !a.startsWith("postgres")).join(" ")} failed:\n${r.stderr}`);
  return r.stdout;
}
const psql = (url, sql) => run("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d", url, "-c", sql]).trim();

/** Everything that defines the security posture, as one comparable JSON document. */
function fingerprint(url) {
  return JSON.parse(psql(url, `select json_build_object(
    'rows', (select json_object_agg(relname, n order by relname) from (
        select c.relname, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from bnl.%I', c.relname), false, true, '')))[1]::text::int as n
        from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'bnl' and c.relkind = 'r' order by 1) t),
    'rls', (select json_object_agg(c.relname, c.relrowsecurity::text || '/' || c.relforcerowsecurity::text order by c.relname)
        from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'bnl' and c.relkind = 'r'),
    'policies', (select json_agg(tablename || '.' || policyname || ':' || permissive || ':' || roles::text || ':' || coalesce(qual, '') || ':' || coalesce(with_check, '') order by tablename, policyname)
        from pg_policies where schemaname = 'bnl'),
    'table_acl', (select json_object_agg(c.relname, coalesce(c.relacl::text, '') order by c.relname) from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'bnl'),
    'column_acl', (select json_agg(c.relname || '.' || a.attname || '=' || a.attacl::text order by c.relname, a.attname) from pg_attribute a join pg_class c on c.oid = a.attrelid
        join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'bnl' and a.attacl is not null),
    'functions', (select json_object_agg(p.oid::regprocedure::text, pg_get_userbyid(p.proowner) || ':' || p.prosecdef::text || ':' || coalesce(p.proacl::text, '') || ':' || coalesce(array_to_string(p.proconfig, ','), '') order by p.oid::regprocedure::text)
        from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'bnl'),
    'schema_acl', (select nspacl::text from pg_namespace where nspname = 'bnl')
  )`));
}

const work = mkdtempSync(join(tmpdir(), "bnl-backup-"));
const dumpFile = join(work, "bnl.dump");
let ok = false;
const t0 = Date.now();
try {
  const before = fingerprint(adminUrl.toString());
  log(`dumping ${SOURCE}`);
  run("pg_dump", ["-Fc", "--no-password", "-d", adminUrl.toString(), "-f", dumpFile]);
  const tDump = Date.now() - t0;
  const size = statSync(dumpFile).size;
  // Only the bnl schema + extensions matter; listing proves what the archive contains.
  const toc = run("pg_restore", ["-l", dumpFile]);
  if (!/SCHEMA - bnl/.test(toc) || !/POLICY bnl /.test(toc) || !/ACL bnl /.test(toc)) throw new Error("archive is missing schema, policies or ACLs");

  psql(urlFor(adminUrl, "postgres"), `drop database if exists ${TARGET}`);
  psql(urlFor(adminUrl, "postgres"), `create database ${TARGET}`);
  const t1 = Date.now();
  run("pg_restore", ["--exit-on-error", "--no-password", "-d", urlFor(adminUrl, TARGET), dumpFile]);
  const tRestore = Date.now() - t1;
  const after = fingerprint(urlFor(adminUrl, TARGET));

  const diffs = Object.keys(before).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  if (diffs.length) throw new Error(`restored database differs in: ${diffs.join(", ")}`);
  const forcedEverywhere = Object.values(after.rls).every((v) => v === "true/true");
  if (!forcedEverywhere) throw new Error("RLS not enabled+forced on every restored table");

  // Functional check through the request login: household A's device sees only household A.
  const appRestored = urlFor(appUrl, TARGET);
  const seen = psql(appRestored, `begin;
    set local role bnl_device;
    select set_config('bnl.household_id', 'aaaaaaaa-0000-4000-8000-00000000000a', true), set_config('bnl.device_id', 'd0000000-0000-4000-8000-0000000000a1', true);
    select string_agg(distinct household_id::text, ',') from bnl.learner_profiles;
    commit;`).split("\n").filter(Boolean).pop();
  if (seen !== "aaaaaaaa-0000-4000-8000-00000000000a") throw new Error(`restored RLS check failed: device A saw ${seen}`);
  const denied = spawnSync(join(PG_BIN, "psql"), ["-X", "-q", "-d", appRestored, "-c", "select count(*) from bnl.learner_profiles"], { encoding: "utf8" });
  if (denied.status === 0) throw new Error("bnl_app could read bnl.learner_profiles without a request role after restore");

  const totalRows = Object.values(after.rows).reduce((a, b) => a + b, 0);
  console.log(JSON.stringify({ rehearsal: "backup_restore", ok: true, source: SOURCE, target: TARGET, dump_bytes: size, tables: Object.keys(after.rows).length, rows: totalRows,
    policies: after.policies.length, functions: Object.keys(after.functions).length, dump_ms: tDump, restore_ms: tRestore }));
  ok = true;
} catch (err) {
  log(err instanceof Error ? err.message : String(err));
  console.log(JSON.stringify({ rehearsal: "backup_restore", ok: false }));
} finally {
  try { psql(urlFor(adminUrl, "postgres"), `drop database if exists ${TARGET}`); } catch { /* cluster is thrown away anyway */ }
  rmSync(work, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
