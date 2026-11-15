import { HttpError, newRequestId, type AdultIdentity } from "@bnl/auth";
import type { StaffRole } from "@bnl/contracts";
import { withStaff } from "../authn";
import type { Sql } from "../db-port";
import { getDeps } from "../deps";
import type { Ctx } from "../http";

export type StaffView<T> = { kind: "ok"; data: T; roles: readonly StaffRole[] } | { kind: "forbidden"; message: string };

/** Loads staff-scoped data for an /admin page (same role gate and DB context as the API). */
export async function loadForStaff<T>(
  adult: AdultIdentity,
  roles: readonly StaffRole[],
  fn: (sql: Sql, held: readonly StaffRole[], c: Ctx) => Promise<T>,
): Promise<StaffView<T>> {
  const c: Ctx = { requestId: newRequestId(), deps: getDeps() };
  try {
    return await withStaff(c, adult, roles, async (sql, held) => ({ kind: "ok" as const, data: await fn(sql, held, c), roles: held }));
  } catch (err) {
    // Only "no content role" is a normal page state; everything else is a real error.
    if (err instanceof HttpError && err.status === 403) return { kind: "forbidden", message: "Your account has no content role (editor, reviewer, publisher or analyst)." };
    throw err;
  }
}
