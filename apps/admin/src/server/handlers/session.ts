import { HttpError } from "@bnl/auth";
import { z } from "zod";
import { SESSION_COOKIE, requireCsrf } from "../authn";
import { clientIp, empty, json, readJson, type Ctx } from "../http";
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
  const maxAge = (session.expiresAt.getTime() - c.deps.now().getTime()) / 1000;
  return json(c, { user_id: session.identity.userId }, 200, { "Set-Cookie": sessionCookie(session.token, maxAge, c.deps.secureCookies) });
}

/** POST /api/v1/auth/logout — clears the session cookie. */
export async function logoutHandler(req: Request, c: Ctx): Promise<Response> {
  requireCsrf(req, c);
  return empty(c, 204, { "Set-Cookie": sessionCookie("", 0, c.deps.secureCookies) });
}
