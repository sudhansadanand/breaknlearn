import type { TransactionSql } from "postgres";

/**
 * Port onto `@bnl/db` (owned by A1). The lead wires the real
 * `withDbContext(db, ctx, fn)` into {@link DbRunner} during integration; unit
 * tests inject fakes. Each call is one transaction in which `@bnl/db` runs
 * `SET LOCAL ROLE bnl_<kind>` and sets `bnl.household_id` / `bnl.device_id` /
 * `bnl.actor_id` from the *verified* credential, so RLS scopes every query.
 */
export type DbContext =
  | { readonly kind: "public" }
  | { readonly kind: "device"; readonly householdId: string; readonly deviceId: string }
  | { readonly kind: "adult"; readonly userId: string }
  | { readonly kind: "staff"; readonly userId: string }
  | { readonly kind: "job" };

/** postgres@3.4.7 transaction handle. */
export type Sql = TransactionSql;

export type DbRunner = <T>(ctx: DbContext, fn: (sql: Sql) => Promise<T>) => Promise<T>;

/** Default runner until the lead wires `@bnl/db`: fails closed on every call. */
export const unwiredDbRunner: DbRunner = async () => {
  throw new Error("Database is not wired: inject a DbRunner backed by @bnl/db withDbContext");
};
