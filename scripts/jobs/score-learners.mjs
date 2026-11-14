#!/usr/bin/env node
/**
 * ELS scoring job (spec M10). Writes per-lesson and per-topic mastery_snapshots with evidence flags and
 * refreshes recommendations, in the `bnl_job` role. Idempotent per (learner, topic, lesson, as-of day,
 * weights version); deterministic (evidence after the end of the as-of day is ignored).
 *
 *   BNL_JOB_DB_URL=postgres://bnl_app:...@host/db node scripts/jobs/score-learners.mjs --as-of 2026-11-14
 *   ... node scripts/jobs/score-learners.mjs --learners <uuid>[,<uuid>...]   (on-demand re-score)
 *   (no --as-of: yesterday in UTC)
 *
 * Prints one JSON line with the run metrics. Exit code 1 on failure, 2 on configuration errors.
 * The connection URL must be the bnl_app login (never a superuser); BNL_APP_DB_URL is used as a fallback.
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

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--as-of") out.asOf = argv[++i];
    else if (a === "--learners") out.learnerIds = (argv[++i] ?? "").split(",").filter(Boolean);
    else throw new Error(`unknown argument: ${a}`);
  }
  out.asOf ??= new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  return out;
}

const url = process.env.BNL_JOB_DB_URL ?? process.env.BNL_APP_DB_URL;
if (!url) {
  console.error("score-learners: set BNL_JOB_DB_URL (bnl_app login URL)");
  process.exit(2);
}
const scope = parseArgs(process.argv.slice(2));
const adminRoot = new URL("../../apps/admin/", import.meta.url);
const { createDb, withDbContext } = await import(new URL("../../packages/db/src/index.ts", import.meta.url).href);
const { scoreLearners } = await import(new URL("src/server/analytics/score-job.ts", adminRoot).href);
const db = createDb(url, { max: 1, prepare: process.env.BNL_DB_PREPARE === "true" });
let code = 0;
try {
  const result = await scoreLearners((ctx, fn) => withDbContext(db, ctx, fn), scope, { log: (entry) => console.error(JSON.stringify(entry)) });
  console.log(JSON.stringify(result));
} catch (err) {
  console.error(JSON.stringify({ level: "error", job: "score_learners", error: err instanceof Error ? err.message : String(err) }));
  code = 1;
} finally {
  await db.end();
}
process.exit(code);
