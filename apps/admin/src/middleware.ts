import { NextResponse, type NextRequest } from "next/server";

/**
 * Security headers for /admin/** pages and /api/** (ADR-0006, spec M12).
 * Student static files (`/`, /index.html, /logo.webp, /music.wav) are NOT
 * matched: their bytes and behaviour stay exactly as the live app.
 *
 * Edge runtime: keep this file free of node:* imports (@bnl/auth is server-only).
 * Real authentication happens server-side in every page and route handler; the
 * redirect below is only a cheap early exit for requests with no cookie at all.
 */

export const SESSION_COOKIE = "bnl_admin_session";
export const CSRF_COOKIE = "bnl_csrf";
const LOGIN_PATH = "/admin/login";

function randomToken(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function pageCsp(nonce: string, dev: boolean, https: boolean): string {
  return [
    "default-src 'self'",
    // Nonce + strict-dynamic: no inline script runs unless Next stamped it with this request's nonce.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self'${dev ? " 'unsafe-inline'" : ` 'nonce-${nonce}'`}`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "media-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const COMMON_HEADERS: Readonly<Record<string, string>> = {
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

function applyCommon(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(COMMON_HEADERS)) res.headers.set(k, v);
  return res;
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  const dev = process.env.NODE_ENV === "development";

  if (pathname.startsWith("/api/")) {
    const res = applyCommon(NextResponse.next());
    res.headers.set("Content-Security-Policy", API_CSP);
    // Handlers already send no-store; enforce it for every non-catalog API response.
    if (!pathname.startsWith("/api/v1/catalog/")) res.headers.set("Cache-Control", "no-store");
    return res;
  }

  // /admin pages
  const isLogin = pathname === LOGIN_PATH;
  if (!isLogin && !req.cookies.get(SESSION_COOKIE)?.value) {
    const res = applyCommon(NextResponse.redirect(new URL(LOGIN_PATH, req.url)));
    res.headers.set("Cache-Control", "no-store");
    return res;
  }

  const nonce = randomToken(16);
  const csp = pageCsp(nonce, dev, req.nextUrl.protocol === "https:");
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  // Next reads the nonce from the request CSP header and stamps its own scripts.
  requestHeaders.set("Content-Security-Policy", csp);

  const res = applyCommon(NextResponse.next({ request: { headers: requestHeaders } }));
  res.headers.set("Content-Security-Policy", csp);
  res.headers.set("Cache-Control", "no-store");
  if (!req.cookies.get(CSRF_COOKIE)?.value) {
    res.cookies.set(CSRF_COOKIE, randomToken(32), {
      path: "/",
      sameSite: "strict",
      secure: req.nextUrl.protocol === "https:",
      httpOnly: false, // double-submit: same-origin JS must read it to echo X-CSRF-Token
    });
  }
  return res;
}

export const config = {
  matcher: ["/admin", "/admin/:path*", "/api/:path*"],
};
