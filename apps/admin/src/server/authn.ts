import {
  CSRF_COOKIE,
  CSRF_HEADER,
  DeviceTokenError,
  HttpError,
  bearerToken,
  checkCsrf,
  readCookie,
  verifyDeviceAccessToken,
  type AdultIdentity,
} from "@bnl/auth";
import type { DeviceTokenClaims, HouseholdRole, StaffRole } from "@bnl/contracts";
import type { Sql } from "./db-port";
import type { AppDeps } from "./deps";
import type { Ctx } from "./http";

/** Cookie name fixed by the OpenAPI AdultSession security scheme. */
export const SESSION_COOKIE = "bnl_admin_session";

const unauthorized = () => new HttpError(401, "unauthorized", "Authentication required");

/** `details.reason` of the 403 every adult API returns while the account must still replace its one-time password. */
export const PASSWORD_CHANGE_REQUIRED = "password_change_required";
export const passwordChangeRequired = () =>
  new HttpError(403, "forbidden", "Password change required before continuing", { reason: PASSWORD_CHANGE_REQUIRED });

/**
 * Adult endpoints that stay usable while the must-change flag is set (besides POST /api/v1/auth/password, which
 * opts in explicitly, and logout, which needs no identity). Keyed by "METHOD /path".
 */
const ALLOWED_WHILE_PASSWORD_CHANGE_PENDING: ReadonlySet<string> = new Set(["GET /api/v1/admin/me"]);

function requestKey(req: Request): string {
  let path: string;
  try {
    path = new URL(req.url).pathname.replace(/\/+$/, "");
  } catch {
    path = "";
  }
  return `${req.method.toUpperCase()} ${path}`;
}

export interface RequireAdultOptions {
  /** Let an account with a pending forced password change through (only the password-change endpoint). */
  readonly allowPendingPasswordChange?: boolean;
}

/** Verifies the adult session cookie value; null when absent/invalid. */
export async function adultFromSessionToken(deps: AppDeps, token: string | null | undefined): Promise<AdultIdentity | null> {
  if (!token) return null;
  return deps.adultAuth.verifySession(token);
}

/**
 * Every adult API goes through here. No/invalid session → 401 (SEC-001). A valid session whose account must
 * still change its one-time password → 403 forbidden/password_change_required, except on the allow-list.
 */
export async function requireAdult(req: Request, c: Ctx, opts: RequireAdultOptions = {}): Promise<AdultIdentity> {
  const identity = await adultFromSessionToken(c.deps, readCookie(req.headers.get("cookie"), SESSION_COOKIE));
  if (!identity) throw unauthorized();
  if (identity.mustChangePassword && !opts.allowPendingPasswordChange && !ALLOWED_WHILE_PASSWORD_CHANGE_PENDING.has(requestKey(req))) {
    throw passwordChangeRequired();
  }
  return identity;
}

/** Origin + double-submit token for cookie-authenticated mutations (SEC-009). */
export function requireCsrf(req: Request, c: Ctx): void {
  const result = checkCsrf(
    {
      method: req.method,
      origin: req.headers.get("origin"),
      referer: req.headers.get("referer"),
      cookieToken: readCookie(req.headers.get("cookie"), CSRF_COOKIE),
      headerToken: req.headers.get(CSRF_HEADER),
    },
    c.deps.adminOrigin,
  );
  if (!result.ok) throw new HttpError(403, "forbidden", "Cross-site request rejected", { reason: result.reason });
}

export interface HouseholdMembership {
  readonly householdId: string;
  readonly role: HouseholdRole;
}

/**
 * Resolves the caller's household from active owner/guardian membership.
 * v1 supports exactly one household per adult; several is an explicit conflict
 * rather than a guess. Staff roles grant no household access (ADR-0003).
 */
export async function requireHousehold(sql: Sql, c: Ctx, userId: string): Promise<HouseholdMembership> {
  const memberships = await c.deps.repos.memberships.activeMemberships(sql, userId);
  const [only, ...others] = memberships;
  if (!only) throw new HttpError(403, "forbidden", "No household access");
  if (others.length > 0) throw new HttpError(409, "conflict", "Multiple households are not supported in v1");
  return only;
}

/** Runs `fn` in the adult's DB context with their household resolved. */
export function withAdultHousehold<T>(c: Ctx, adult: AdultIdentity, fn: (sql: Sql, m: HouseholdMembership) => Promise<T>): Promise<T> {
  return c.deps.db({ kind: "adult", userId: adult.userId }, async (sql) => fn(sql, await requireHousehold(sql, c, adult.userId)));
}

/** Signature/expiry/claims only; revocation is checked by {@link withDevice}. */
export async function verifyDeviceBearer(req: Request, c: Ctx): Promise<DeviceTokenClaims> {
  const token = bearerToken(req.headers.get("authorization"));
  if (!token) throw unauthorized();
  try {
    return await verifyDeviceAccessToken(c.deps.keys.deviceToken, token, c.deps.now());
  } catch (err) {
    if (err instanceof DeviceTokenError) throw unauthorized();
    throw err;
  }
}

/**
 * Runs `fn` in the device's DB context after confirming, in the same
 * transaction, that the device is unrevoked and the token's `ver` equals the
 * current token_version (revocation takes effect on the very next request).
 */
export function withDevice<T>(c: Ctx, claims: DeviceTokenClaims, fn: (sql: Sql) => Promise<T>): Promise<T> {
  return c.deps.db({ kind: "device", householdId: claims.hid, deviceId: claims.sub }, async (sql) => {
    const current = await c.deps.repos.devices.touchIfCurrent(sql, { id: claims.sub, householdId: claims.hid, tokenVersion: claims.ver, at: c.deps.now() });
    if (!current) throw unauthorized();
    return fn(sql);
  });
}

export function hasBearer(req: Request): boolean {
  return (req.headers.get("authorization") ?? "") !== "";
}

/**
 * Runs `fn` in the staff DB context after confirming, in the same transaction, that the caller
 * holds at least one of `roles` (ADR-0003). RLS re-checks staff roles inside the database;
 * this is the handler-level gate (SEC-002). Staff contexts never see household data.
 */
export function withStaff<T>(
  c: Ctx,
  adult: AdultIdentity,
  roles: readonly StaffRole[],
  fn: (sql: Sql, held: readonly StaffRole[]) => Promise<T>,
): Promise<T> {
  return c.deps.db({ kind: "staff", userId: adult.userId }, async (sql) => {
    const held = (await c.deps.repos.memberships.activeStaffRoles(sql, adult.userId)) as readonly StaffRole[];
    if (!held.some((r) => roles.includes(r))) throw new HttpError(403, "forbidden", "Insufficient role");
    return fn(sql, held);
  });
}
