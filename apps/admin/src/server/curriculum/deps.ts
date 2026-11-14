import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ConfigError, loadServerSecret } from "@bnl/auth";
import { DEFAULT_THRESHOLD } from "@bnl/curriculum";
import { LocalFsStorage, SupabaseStorage, type StorageFetch, type StoragePort } from "@bnl/storage";
import type { Env } from "../deps";
import { sqlCurriculumRepo } from "./sql-repo";
import type { CurriculumRepo } from "./types";

/** Private bucket for school syllabi; object keys are `<household_id>/<uuid>` (ADR-0005 §13). */
export const SYLLABI_BUCKET = "school-syllabi";
/** Same-origin route that serves LocalFsStorage signed URLs (dev/test only). */
export const LOCAL_OBJECT_PATH = "/api/v1/admin/imports/local-object";
/** The DB check on syllabus_uploads.size_bytes caps uploads at 20 MB. */
const HARD_MAX_MB = 20;

/**
 * Curriculum/import dependencies, kept separate from the shared AppDeps (owned by the identity
 * module) so this feature can be wired and tested on its own.
 */
export interface CurriculumDeps {
  readonly repo: CurriculumRepo;
  readonly storage: StoragePort;
  /** Set only when storage is the local filesystem driver (enables the local signed-URL route). */
  readonly localStorage: LocalFsStorage | null;
  readonly importMaxBytes: number;
  readonly signedUrlTtlSeconds: number;
  readonly suggestThreshold: number;
}

function intEnv(env: Env, name: string, def: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  if (!/^[0-9]+$/.test(raw)) throw new ConfigError(`${name} must be a whole number`);
  const n = Number(raw);
  if (n < min || n > max) throw new ConfigError(`${name} must be between ${min} and ${max}`);
  return n;
}

function isProduction(env: Env): boolean {
  if (env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview") return true;
  // A local `next start` (NODE_ENV=production) may opt in explicitly.
  return env.NODE_ENV === "production" && env.BNL_ALLOW_LOCAL_STORAGE !== "true";
}

export function buildStorage(env: Env): { storage: StoragePort; local: LocalFsStorage | null } {
  const driver = env.BNL_STORAGE_DRIVER ?? (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY ? "supabase" : "local");
  if (driver === "supabase") {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new ConfigError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for Supabase storage");
    return { storage: new SupabaseStorage(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, globalThis.fetch as unknown as StorageFetch), local: null };
  }
  if (driver !== "local") throw new ConfigError("BNL_STORAGE_DRIVER must be 'local' or 'supabase'");
  // Fail closed: private school files never land on a serverless instance's disk in production.
  if (isProduction(env)) throw new ConfigError("Local file storage is not allowed in production; configure Supabase storage");
  const root = env.BNL_LOCAL_STORAGE_DIR ?? join(tmpdir(), "bnl-local-storage");
  if (!isAbsolute(root)) throw new ConfigError("BNL_LOCAL_STORAGE_DIR must be an absolute path");
  const signingKey = new Uint8Array(createHmac("sha256", loadServerSecret(env)).update("bnl/v1/local-storage-url").digest());
  const local = new LocalFsStorage(root, { signingKey, baseUrl: LOCAL_OBJECT_PATH });
  return { storage: local, local };
}

export function buildCurriculumDeps(env: Env): CurriculumDeps {
  const { storage, local } = buildStorage(env);
  const threshold = env.IMPORT_SUGGEST_THRESHOLD ? Number(env.IMPORT_SUGGEST_THRESHOLD) : DEFAULT_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new ConfigError("IMPORT_SUGGEST_THRESHOLD must be between 0 and 1");
  return {
    repo: sqlCurriculumRepo,
    storage,
    localStorage: local,
    importMaxBytes: intEnv(env, "IMPORT_MAX_MB", HARD_MAX_MB, 1, HARD_MAX_MB) * 1024 * 1024,
    signedUrlTtlSeconds: intEnv(env, "IMPORT_SIGNED_URL_TTL_SECONDS", 60, 10, 900),
    suggestThreshold: threshold,
  };
}

let cached: CurriculumDeps | null = null;
let override: CurriculumDeps | null = null;

export function getCurriculumDeps(): CurriculumDeps {
  if (override) return override;
  cached ??= buildCurriculumDeps(process.env);
  return cached;
}

/** Test seam. */
export function setCurriculumDepsForTesting(deps: CurriculumDeps | null): void {
  override = deps;
}
