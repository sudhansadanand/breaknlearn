import { randomUUID } from "node:crypto";
import {
  ConfigError,
  DevAuthProvider,
  StoreRateLimiter,
  SupabaseJwtProvider,
  loadServerKeys,
  redact,
  type AdultAuthProvider,
  type FetchLike,
  type RateLimiter,
  type ServerKeys,
} from "@bnl/auth";
import { createDb, withDbContext } from "@bnl/db";
import { unwiredDbRunner, type DbRunner } from "./db-port";
import { sqlRepos, type Repos } from "./repos";

/** Everything a handler needs; injected so tests can supply fakes. */
export interface AppDeps {
  readonly db: DbRunner;
  readonly repos: Repos;
  readonly adultAuth: AdultAuthProvider;
  readonly keys: ServerKeys;
  readonly rateLimiter: RateLimiter;
  /** Exact origin the admin UI is served from (ADMIN_ORIGIN); CSRF Origin checks compare to it. */
  readonly adminOrigin: string;
  /** Secure cookies whenever the admin origin is https. */
  readonly secureCookies: boolean;
  readonly now: () => Date;
  readonly uuid: () => string;
  /** Structured log sink; callers pass already-redacted data, and it redacts again. */
  readonly log: (entry: Record<string, unknown>) => void;
}

export type Env = Readonly<Record<string, string | undefined>>;

export function parseAdminOrigin(value: string | undefined): string {
  if (!value) throw new ConfigError("ADMIN_ORIGIN is not set");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("ADMIN_ORIGIN is not a valid URL");
  }
  if (url.origin !== value.replace(/\/$/, "")) throw new ConfigError("ADMIN_ORIGIN must be a bare origin (scheme://host[:port])");
  return url.origin;
}

export function buildAdultAuth(env: Env, keys: ServerKeys): AdultAuthProvider {
  if (env.BNL_DEV_AUTH === "true") {
    // Throws in production (NODE_ENV/VERCEL_ENV) — fail closed, never silently fall back.
    return DevAuthProvider.fromEnv(env, keys.devSession);
  }
  if (!env.SUPABASE_URL) throw new ConfigError("SUPABASE_URL is not set (or set BNL_DEV_AUTH=true for local dev)");
  return new SupabaseJwtProvider({
    supabaseUrl: env.SUPABASE_URL,
    jwtSecret: env.SUPABASE_JWT_SECRET,
    anonKey: env.SUPABASE_ANON_KEY,
    // Server-only; used solely to clear the forced-password-change flag (POST /api/v1/auth/password).
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    fetch: globalThis.fetch as unknown as FetchLike,
  });
}

let dbRunner: DbRunner = unwiredDbRunner;
let cached: AppDeps | null = null;
let override: AppDeps | null = null;

/** Integration hook for the lead: `setDbRunner((ctx, fn) => withDbContext(db, ctx, fn))`. */
export function setDbRunner(runner: DbRunner): void {
  dbRunner = runner;
  cached = null;
}

export function buildDeps(env: Env, db: DbRunner): AppDeps {
  const keys = loadServerKeys(env);
  const adminOrigin = parseAdminOrigin(env.ADMIN_ORIGIN);
  const now = () => new Date();
  return {
    db,
    repos: sqlRepos,
    adultAuth: buildAdultAuth(env, keys),
    keys,
    // Shared across serverless instances; the bucket table is written under the job role
    // because limits apply before any credential is known.
    rateLimiter: new StoreRateLimiter(
      { increment: (key, start, seconds) => db({ kind: "job" }, (sql) => sqlRepos.rateLimits.increment(sql, key, start, seconds)) },
      now,
    ),
    adminOrigin,
    secureCookies: adminOrigin.startsWith("https://"),
    now,
    uuid: randomUUID,
    log: (entry) => console.error(JSON.stringify(redact(entry))),
  };
}

/**
 * Real database wiring (ADR-0005): BNL_APP_DB_URL logs in as the `bnl_app` role, which can only
 * act after `withDbContext` switches to a request role. Without it the app fails closed.
 */
export function dbRunnerFromEnv(env: Env): DbRunner | null {
  const url = env.BNL_APP_DB_URL;
  if (!url) return null;
  // Transaction-mode poolers (Supabase/Vercel) do not support prepared statements.
  const db = createDb(url, { prepare: env.BNL_DB_PREPARE === "true", max: Number(env.BNL_DB_POOL_MAX ?? 5) });
  return (ctx, fn) => withDbContext(db, ctx, fn);
}

export function getDeps(): AppDeps {
  if (override) return override;
  if (dbRunner === unwiredDbRunner) dbRunner = dbRunnerFromEnv(process.env) ?? unwiredDbRunner;
  cached ??= buildDeps(process.env, dbRunner);
  return cached;
}

/** Test seam. */
export function setDepsForTesting(deps: AppDeps | null): void {
  override = deps;
}
