#!/usr/bin/env node
/**
 * Session aggregation job (M07 reducer, OPS-004). Recomputes learning_sessions time totals from the
 * stored, deduplicated events. Idempotent: re-running the same job key writes identical totals and
 * bumps job_runs.attempts. Runs in the `bnl_job` database role via @bnl/db withDbContext.
 *
 *   BNL_JOB_DB_URL=postgres://bnl_app:...@host/db node scripts/jobs/aggregate-sessions.mjs --date 2026-11-14
 *   ... node scripts/jobs/aggregate-sessions.mjs --sessions <uuid>[,<uuid>...]
 *   (no args: yesterday in UTC)
 *
 * Prints one JSON line with the run metrics (sessions, events, totals, ingest lag). Exit code 1 on failure.
 * The connection URL must be the bnl_app login (never a superuser); BNL_APP_DB_URL is used as a fallback.
 */
import { spawnSync } from "node:child_process";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

// TypeScript workspace sources need type transformation (parameter properties) and the resolve hook.
if (process.env.BNL_JOB_CHILD !== "1") {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, BNL_JOB_CHILD: "1" },
  });
  process.exit(r.status ?? 1);
}

register(pathToFileURL(`${here}ts-resolve-hook.mjs`));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--date") out.date = argv[++i];
    else if (a === "--sessions") out.sessionIds = (argv[++i] ?? "").split(",").filter(Boolean);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.date && !out.sessionIds) out.date = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  return out.sessionIds ? { sessionIds: out.sessionIds } : { date: out.date };
}

const url = process.env.BNL_JOB_DB_URL ?? process.env.BNL_APP_DB_URL;
if (!url) {
  console.error("aggregate-sessions: set BNL_JOB_DB_URL (bnl_app login URL)");
  process.exit(2);
}
const scope = parseArgs(process.argv.slice(2));
const adminRoot = new URL("../../apps/admin/", import.meta.url);
const { createDb, withDbContext } = await import(new URL("../../packages/db/src/index.ts", import.meta.url).href);
const { aggregateSessions } = await import(new URL("src/server/learning/aggregate.ts", adminRoot).href);
const db = createDb(url, { max: 1, prepare: process.env.BNL_DB_PREPARE === "true" });
let code = 0;
try {
  const result = await aggregateSessions((ctx, fn) => withDbContext(db, ctx, fn), scope, {
    log: (entry) => console.error(JSON.stringify(entry)),
  });
  console.log(JSON.stringify(result));
} catch (err) {
  console.error(JSON.stringify({ level: "error", job: "aggregate_sessions", error: err instanceof Error ? err.message : String(err) }));
  code = 1;
} finally {
  await db.end();
}
process.exit(code);
