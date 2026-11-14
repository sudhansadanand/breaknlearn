#!/usr/bin/env node
/**
 * Retention purge (spec §9): raw telemetry RETENTION_RAW_TELEMETRY_DAYS (alias RETENTION_DAYS, default 90),
 * analytics aggregates RETENTION_AGGREGATE_DAYS (default 395 ≈ 13 months). Runs in the `bnl_job` role via the
 * audited SECURITY DEFINER functions bnl.purge_expired + bnl.purge_expired_analytics. Idempotent.
 * Scheduling (e.g. daily) is configured by the lead/ops; this script does one pass.
 *
 *   BNL_JOB_DB_URL=postgres://bnl_app:...@host/db node scripts/jobs/score-retention-purge.mjs
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

const url = process.env.BNL_JOB_DB_URL ?? process.env.BNL_APP_DB_URL;
if (!url) {
  console.error("score-retention-purge: set BNL_JOB_DB_URL (bnl_app login URL)");
  process.exit(2);
}
const adminRoot = new URL("../../apps/admin/", import.meta.url);
const { createDb, withDbContext } = await import(new URL("../../packages/db/src/index.ts", import.meta.url).href);
const { runRetentionPurge } = await import(new URL("src/server/analytics/retention-job.ts", adminRoot).href);
const { retentionFromEnv } = await import(new URL("../../packages/intelligence/src/retention.ts", import.meta.url).href);
let policy;
try {
  policy = retentionFromEnv(process.env);
} catch (err) {
  console.error(JSON.stringify({ level: "error", job: "retention_purge", error: err instanceof Error ? err.message : String(err) }));
  process.exit(2);
}
const db = createDb(url, { max: 1, prepare: process.env.BNL_DB_PREPARE === "true" });
let code = 0;
try {
  console.log(JSON.stringify(await runRetentionPurge((ctx, fn) => withDbContext(db, ctx, fn), policy)));
} catch (err) {
  console.error(JSON.stringify({ level: "error", job: "retention_purge", error: err instanceof Error ? err.message : String(err) }));
  code = 1;
} finally {
  await db.end();
}
process.exit(code);
