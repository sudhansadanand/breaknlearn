import { HttpError, PASSWORD_MAX_LENGTH, PasswordChangeRejected, passwordPolicyIssues, type AdultIdentity, type AdultSession } from "@bnl/auth";
import { z } from "zod";
import { SESSION_COOKIE, requireAdult, requireCsrf } from "../authn";
import { clientIp, empty, json, readJson, validationFailed, type Ctx } from "../http";
import { enforceRateLimit } from "../rate-limits";

export const LoginRequest = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(200),
});

export function sessionCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/**
 * POST /api/v1/auth/login — adult password sign-in (proposal A2-auth-session-endpoints).
 * Brute-force protection: per-IP and per-email fixed windows; generic failure message.
 * Login CSRF: Origin + double-submit token (cookie set by middleware on /admin/login).
 */
export async function loginHandler(req: Request, c: Ctx): Promise<Response> {
  await enforceRateLimit(c, "loginByIp", clientIp(req));
  requireCsrf(req, c);
  const body = await readJson(req, LoginRequest);
  await enforceRateLimit(c, "loginByEmail", body.email);
  const session = await c.deps.adultAuth.signInWithPassword(body.email, body.password);
  if (!session) throw new HttpError(401, "unauthorized", "Invalid email or password");
  return json(
    c,
    { user_id: session.identity.userId, ...(session.identity.mustChangePassword ? { must_change_password: true } : {}) },
    200,
    { "Set-Cookie": cookieFor(c, session) },
  );
}

function cookieFor(c: Ctx, session: AdultSession): string {
  const maxAge = (session.expiresAt.getTime() - c.deps.now().getTime()) / 1000;
  return sessionCookie(session.token, maxAge, c.deps.secureCookies);
}

/** POST /api/v1/auth/logout — clears the session cookie. */
export async function logoutHandler(req: Request, c: Ctx): Promise<Response> {
  requireCsrf(req, c);
  return empty(c, 204, { "Set-Cookie": sessionCookie("", 0, c.deps.secureCookies) });
}

export const ChangePasswordRequest = z.object({
  current_password: z.string().min(1).max(200),
  // Upper bound only here; the policy (length, email) is checked separately so issues carry stable codes.
  new_password: z.string().min(1).max(PASSWORD_MAX_LENGTH * 4),
});

/** One message for "current password wrong" and "new equals current": neither is distinguishable. */
const changeRefused = () =>
  new HttpError(422, "validation_failed", "Password could not be changed. Check your current password and choose a different new one.");

/**
 * POST /api/v1/auth/password — the signed-in adult replaces their password; clears the forced-change flag set by
 * scripts/ops/bootstrap-owner.mjs. Allowed while the flag is pending (every other adult API is 403 then).
 * Order: IP limit → session (401) → CSRF → per-user limit → body/policy → verify current → change → re-sign-in.
 * The session cookie is rotated to a token minted after the change. Passwords are never logged or audited.
 */
export async function changePasswordHandler(req: Request, c: Ctx): Promise<Response> {
  await enforceRateLimit(c, "passwordChangeByIp", clientIp(req));
  const adult = await requireAdult(req, c, { allowPendingPasswordChange: true });
  requireCsrf(req, c);
  await enforceRateLimit(c, "passwordChangeByUser", adult.userId);
  const body = await readJson(req, ChangePasswordRequest);
  const issues = passwordPolicyIssues(body.new_password, adult.email);
  if (issues.length > 0) {
    throw validationFailed(issues.map((code) => ({ path: ["new_password"], code })), "New password does not meet the password rules");
  }

  const verified = await c.deps.adultAuth.signInWithPassword(adult.email, body.current_password);
  if (!verified || verified.identity.userId !== adult.userId) throw changeRefused();
  if (body.new_password.normalize("NFKC") === body.current_password.normalize("NFKC")) throw changeRefused();

  try {
    await c.deps.adultAuth.changePassword({ accessToken: verified.token, userId: adult.userId, newPassword: body.new_password });
  } catch (err) {
    // The auth server's own policy refused it (e.g. breached-password check). No detail is echoed.
    if (err instanceof PasswordChangeRejected) {
      throw new HttpError(422, "validation_failed", "New password was rejected by the sign-in service; choose a stronger one");
    }
    throw err;
  }

  const fresh = await c.deps.adultAuth.signInWithPassword(adult.email, body.new_password);
  if (!fresh || fresh.identity.userId !== adult.userId || fresh.identity.mustChangePassword) {
    // Password changed but no clean session could be minted: fail closed and make the user sign in again.
    throw new Error("password changed but re-sign-in did not yield a cleared session");
  }
  await auditPasswordChange(c, adult);
  return json(c, { user_id: adult.userId, must_change_password: false }, 200, { "Set-Cookie": cookieFor(c, fresh) });
}

/**
 * Audit row (no password, no email). Household adults write it under their own RLS context; adults without
 * exactly one household (e.g. staff-only) are recorded by the job role with no household.
 */
async function auditPasswordChange(c: Ctx, adult: AdultIdentity): Promise<void> {
  const entry = {
    actorAuthId: adult.userId,
    action: "auth.password_changed",
    targetType: "auth_user",
    targetId: adult.userId,
    metadata: { forced: adult.mustChangePassword === true },
  };
  const householdId = await c.deps.db({ kind: "adult", userId: adult.userId }, async (sql) => {
    const memberships = await c.deps.repos.memberships.activeMemberships(sql, adult.userId);
    const only = memberships.length === 1 ? memberships[0] : undefined;
    if (only) await c.deps.repos.audit.insert(sql, { ...entry, householdId: only.householdId });
    return only?.householdId ?? null;
  });
  if (householdId === null) await c.deps.db({ kind: "job" }, (sql) => c.deps.repos.audit.insert(sql, { ...entry, householdId: null }));
}

/**
 * GET /api/v1/admin/me wrapper: adds `must_change_password: true` (additive; absent otherwise) so the portal can
 * route a pending account to the change-password page. The inner handler is reachable while the flag is set.
 */
export async function withPasswordChangeFlag(req: Request, c: Ctx, inner: (req: Request, c: Ctx) => Promise<Response>): Promise<Response> {
  const res = await inner(req, c);
  if (res.status !== 200) return res;
  const adult = await requireAdult(req, c, { allowPendingPasswordChange: true });
  if (!adult.mustChangePassword) return res;
  const body = (await res.json()) as Record<string, unknown>;
  return json(c, { ...body, must_change_password: true });
}
