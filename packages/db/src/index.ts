/**
 * @bnl/db — the ONLY way request code may touch the database (ADR-0005).
 *
 * Every unit of work runs in one transaction that first does `SET LOCAL ROLE <bnl_*>` and sets the
 * transaction-local settings `bnl.household_id`, `bnl.device_id`, `bnl.actor_id` from a VERIFIED
 * credential. Row-level security policies key on those settings, so a handler bug cannot cross households.
 */
import postgres from "postgres";
import type { Sql, TransactionSql } from "postgres";

export type { Sql, TransactionSql } from "postgres";

/** A pooled connection for the `bnl_app` LOGIN role (never a superuser / service_role URL). */
export type Db = Sql;

export type DbContext =
  | { readonly kind: "public" }
  | { readonly kind: "device"; readonly householdId: string; readonly deviceId: string }
  | { readonly kind: "adult"; readonly userId: string }
  | { readonly kind: "staff"; readonly userId: string }
  | { readonly kind: "job" };

export type DbContextKind = DbContext["kind"];

export type DbRole = "bnl_public" | "bnl_device" | "bnl_adult" | "bnl_staff" | "bnl_job";

export const DB_ROLES: Readonly<Record<DbContextKind, DbRole>> = {
  public: "bnl_public",
  device: "bnl_device",
  adult: "bnl_adult",
  staff: "bnl_staff",
  job: "bnl_job",
};

/** Transaction-local settings applied for a context. Empty string = unset (policies treat it as NULL). */
export interface DbContextSettings {
  readonly role: DbRole;
  readonly householdId: string;
  readonly deviceId: string;
  readonly actorId: string;
}

export class DbContextError extends Error {
  override readonly name = "DbContextError";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function requireUuid(value: unknown, field: string): string {
  if (!isUuid(value)) throw new DbContextError(`${field} must be a UUID`);
  return value.toLowerCase();
}

/** Pure mapping from a context to role + settings; validates every id. Throws DbContextError. */
export function contextSettings(ctx: DbContext): DbContextSettings {
  switch (ctx.kind) {
    case "public":
      return { role: DB_ROLES.public, householdId: "", deviceId: "", actorId: "" };
    case "device":
      return {
        role: DB_ROLES.device,
        householdId: requireUuid(ctx.householdId, "householdId"),
        deviceId: requireUuid(ctx.deviceId, "deviceId"),
        actorId: "",
      };
    case "adult":
      return { role: DB_ROLES.adult, householdId: "", deviceId: "", actorId: requireUuid(ctx.userId, "userId") };
    case "staff":
      return { role: DB_ROLES.staff, householdId: "", deviceId: "", actorId: requireUuid(ctx.userId, "userId") };
    case "job":
      return { role: DB_ROLES.job, householdId: "", deviceId: "", actorId: "" };
    default: {
      const unknownKind: never = ctx;
      throw new DbContextError(`unknown context kind: ${JSON.stringify(unknownKind)}`);
    }
  }
}

export interface CreateDbOptions {
  /** Pool size (default 10). */
  readonly max?: number;
  /** Disable for transaction-mode poolers such as Supabase's port 6543 (default true). */
  readonly prepare?: boolean;
}

/** Creates a connection pool. Use the `bnl_app` login URL; it holds no privileges until a role is set. */
export function createDb(url: string, options: CreateDbOptions = {}): Db {
  return postgres(url, {
    max: options.max ?? 10,
    prepare: options.prepare ?? true,
    onnotice: () => undefined,
    connection: { application_name: "bnl-app" },
  });
}

/**
 * Applies a context to an already-open transaction. Exposed for tests and tooling;
 * request code should use {@link withDbContext}.
 */
export async function applyDbContext(sql: TransactionSql, ctx: DbContext): Promise<DbContextSettings> {
  const s = contextSettings(ctx);
  // The role name comes from the fixed DB_ROLES map, never from input.
  await sql.unsafe(`set local role ${s.role}`);
  await sql`
    select set_config('bnl.household_id', ${s.householdId}, true),
           set_config('bnl.device_id', ${s.deviceId}, true),
           set_config('bnl.actor_id', ${s.actorId}, true)`;
  return s;
}

/** Runs `fn` in one transaction as the context's role. Commits on success, rolls back on any throw. */
export async function withDbContext<T>(db: Db, ctx: DbContext, fn: (sql: TransactionSql) => Promise<T>): Promise<T> {
  // Validate before opening a transaction so bad input never reaches the pool.
  contextSettings(ctx);
  const result = await db.begin(async (sql) => {
    await applyDbContext(sql, ctx);
    return fn(sql);
  });
  return result as T;
}

/** SQLSTATE codes raised by the bnl schema (see supabase/README.md). */
export const DB_ERROR_CODES = {
  forbidden: "42501",
  notFound: "P0002",
  validation: "22023",
  wrongState: "55000",
  uniqueViolation: "23505",
  foreignKeyViolation: "23503",
  checkViolation: "23514",
} as const;
