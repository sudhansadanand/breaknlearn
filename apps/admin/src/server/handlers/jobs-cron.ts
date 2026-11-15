import { createHash, timingSafeEqual } from "node:crypto";
import { HttpError } from "@bnl/auth";
import { retentionFromEnv } from "../analytics/intelligence";
import { runRetentionPurge } from "../analytics/retention-job";
import { scoreLearners } from "../analytics/score-job";
import { buildStorage } from "../curriculum/deps";
import type { DbRunner } from "../db-port";
import { json, type Ctx } from "../http";
import { aggregateSessions } from "../learning/aggregate";
import { runDeletionRequests } from "../privacy/deletion-job";
import type { StoragePort } from "@bnl/storage";

type Env = Record<string, string | undefined>;

/** The scheduled jobs of DEPLOYMENT_RUNBOOK.md §7, injectable for tests. */
export interface JobRunners {
  aggregate: (db: DbRunner, date: string) => Promise<unknown>;
  score: (db: DbRunner, date: string) => Promise<unknown>;
  purge: (db: DbRunner, env: Env) => Promise<unknown>;
  deletions: (db: DbRunner, env: Env) => Promise<{ readonly failed: number }>;
}

const log = (entry: Record<string, unknown>) => console.error(JSON.stringify(entry));

export const realJobRunners: JobRunners = {
  aggregate: (db, date) => aggregateSessions(db, { date }, { log }),
  score: (db, date) => scoreLearners(db, { asOf: date }, { log }),
  purge: (db, env) => runRetentionPurge(db, retentionFromEnv(env), { log }),
  deletions: (db, env) => {
    let storage: StoragePort;
    try {
      storage = buildStorage(env).storage;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const unavailable = async (): Promise<never> => {
        throw new Error(`storage is not configured: ${reason}`);
      };
      storage = { put: unavailable, get: unavailable, signedUrl: unavailable, remove: unavailable } as unknown as StoragePort;
    }
    return runDeletionRequests(db, storage, { limit: 100, log });
  },
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function sameSecret(given: string, expected: string): boolean {
  // Hash both sides so the comparison is constant-time regardless of length.
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * GET /api/v1/internal/jobs/nightly: Vercel Cron entry point for the data jobs (Vercel sends
 * `Authorization: Bearer $CRON_SECRET`). Without a ≥32-character CRON_SECRET the route does not exist (404).
 *
 * - no `date`: the nightly run. Aggregate and score yesterday (UTC), then the retention purge and the
 *   deletion requests.
 * - `?date=YYYY-MM-DD`: aggregate and score that day only (operators re-run a day or score "today so far").
 *
 * Every job is idempotent (OPS-004), so a retried or duplicated cron call is safe. Responds 500 when any job failed.
 */
export async function jobsCronHandler(req: Request, c: Ctx, env: Env = process.env, runners: JobRunners = realJobRunners, now: () => Date = () => new Date()): Promise<Response> {
  const secret = env.CRON_SECRET ?? "";
  if (secret.length < 32) throw new HttpError(404, "not_found", "Not found");
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ") || !sameSecret(auth.slice("Bearer ".length), secret)) {
    throw new HttpError(401, "unauthorized", "Authentication required");
  }
  const requested = new URL(req.url).searchParams.get("date");
  if (requested !== null && (!DATE.test(requested) || Number.isNaN(Date.parse(`${requested}T00:00:00Z`)))) {
    throw new HttpError(400, "validation_failed", "date must be YYYY-MM-DD");
  }
  const nightly = requested === null;
  const date = requested ?? new Date(now().getTime() - 86_400_000).toISOString().slice(0, 10);
  const db = c.deps.db;

  const results: Record<string, unknown> = {};
  let ok = true;
  const step = async (name: string, run: () => Promise<unknown>) => {
    try {
      const r = await run();
      results[name] = r;
      if (name === "deletions" && (r as { failed?: number }).failed) ok = false;
    } catch (err) {
      ok = false;
      results[name] = { error: err instanceof Error ? err.message : String(err) };
      log({ level: "error", job: name, request_id: c.requestId, error: results[name] });
    }
  };
  await step("aggregate", () => runners.aggregate(db, date));
  // Scoring reads the aggregates, so it runs only after aggregation succeeded (runbook §7).
  if (ok) await step("score", () => runners.score(db, date));
  if (nightly) {
    await step("purge", () => runners.purge(db, env));
    await step("deletions", () => runners.deletions(db, env));
  }
  return json(c, { date, nightly, ok, results }, ok ? 200 : 500);
}
