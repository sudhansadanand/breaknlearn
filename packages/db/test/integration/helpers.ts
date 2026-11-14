import postgres from "postgres";
import { expect } from "vitest";
import { applyDbContext, createDb } from "../../src/index";
import type { DbContext, TransactionSql } from "../../src/index";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set; run via scripts/db/test-db.mjs (pnpm --filter @bnl/db test:integration)`);
  return v;
}

/** bnl_app pool: the same login the BFF uses. */
export const db = createDb(env("BNL_TEST_DB_URL"), { max: 4 });
/** Superuser pool: test setup and catalog inspection only. */
export const admin = postgres(env("BNL_TEST_ADMIN_URL"), { max: 2, onnotice: () => undefined });
export const freshUrls = env("BNL_TEST_FRESH_DB_URLS").split(",");

class Rollback extends Error {}

/** Runs fn as `ctx` inside a transaction that is always rolled back. */
export async function rolledBack<T>(ctx: DbContext, fn: (sql: TransactionSql) => Promise<T>): Promise<T> {
  let out: { value: T } | undefined;
  await db
    .begin(async (sql) => {
      await applyDbContext(sql, ctx);
      out = { value: await fn(sql) };
      throw new Rollback();
    })
    .catch((err: unknown) => {
      if (!(err instanceof Rollback)) throw err;
    });
  if (!out) throw new Error("rolledBack: no result");
  return out.value;
}

/** Asserts that `run` fails with SQLSTATE `code` without aborting the surrounding transaction. */
export async function expectSqlState(sql: TransactionSql, code: string, run: (sp: TransactionSql) => Promise<unknown>): Promise<void> {
  await expect(sql.savepoint((sp) => run(sp))).rejects.toMatchObject({ code });
}

export async function closeAll(): Promise<void> {
  await Promise.all([db.end({ timeout: 5 }), admin.end({ timeout: 5 })]);
}
