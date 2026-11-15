#!/usr/bin/env node
/**
 * OPS-005 deletion job: executes every queued guardian deletion request (bnl.data_deletion_requests) in the `bnl_job`
 * role through the audited SECURITY DEFINER bnl.process_deletion_request, after removing a deleted household's
 * school-syllabi objects through the storage port (same driver config as the portal: BNL_STORAGE_DRIVER,
 * SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, or the local driver outside production). Idempotent; safe to re-run.
 * Target: run nightly (the documented promise is "next nightly run, at most 7 days").
 *
 *   BNL_JOB_DB_URL=postgres://bnl_app:...@host/db node scripts/jobs/process-deletion-requests.mjs [--limit N]
 *
 * Exit 0: every request processed (or none queued); 1: at least one request failed (retried next run); 2: config.
 */
import { spawnSync } from "node:child_process";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

if (process.env.BNL_JOB_CHILD !== "1") {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, BNL_JOB_CHILD: "1" },
  });
  process.exit(r.status ?? 1);
}

register(pathToFileURL(`${here}ts-resolve-hook.mjs`));

const fail = (msg, code = 2) => {
  console.error(JSON.stringify({ level: "error", job: "process_deletion_requests", error: msg }));
  process.exit(code);
};

const url = process.env.BNL_JOB_DB_URL ?? process.env.BNL_APP_DB_URL;
if (!url) fail("set BNL_JOB_DB_URL (bnl_app login URL)");
const limitArg = process.argv.indexOf("--limit");
const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) : 100;
if (!Number.isInteger(limit) || limit < 1 || limit > 1000) fail("--limit must be a whole number between 1 and 1000");

const adminRoot = new URL("../../apps/admin/", import.meta.url);
const { createDb, withDbContext } = await import(new URL("../../packages/db/src/index.ts", import.meta.url).href);
const { buildStorage } = await import(new URL("src/server/curriculum/deps.ts", adminRoot).href);
const { runDeletionRequests } = await import(new URL("src/server/privacy/deletion-job.ts", adminRoot).href);

// Storage is only needed for household-scope requests. Without a usable storage config those requests fail (and are
// retried next run, exit 1) while learner/telemetry requests still complete.
let storage;
try {
  storage = buildStorage(process.env).storage;
} catch (err) {
  const reason = err instanceof Error ? err.message : String(err);
  const unavailable = async () => {
    throw new Error(`storage is not configured: ${reason}`);
  };
  storage = { put: unavailable, get: unavailable, signedUrl: unavailable, remove: unavailable };
}
const db = createDb(url, { max: 1, prepare: process.env.BNL_DB_PREPARE === "true" });
let code = 0;
try {
  const result = await runDeletionRequests((ctx, fn) => withDbContext(db, ctx, fn), storage, {
    limit,
    log: (e) => console.error(JSON.stringify(e)),
  });
  console.log(JSON.stringify(result));
  if (result.failed > 0) code = 1;
} catch (err) {
  console.error(JSON.stringify({ level: "error", job: "process_deletion_requests", error: err instanceof Error ? err.message : String(err) }));
  code = 1;
} finally {
  await db.end();
}
process.exit(code);
