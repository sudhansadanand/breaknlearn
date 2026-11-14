import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { Uuid } from "@bnl/contracts";
import { ConfigError } from "./secrets";

/** A verified adult (guardian/owner/staff). Roles are resolved from the DB, never from the token. */
export interface AdultIdentity {
  readonly userId: string;
  readonly email: string;
}

export interface AdultSession {
  /** Opaque value stored in the httpOnly `bnl_admin_session` cookie. */
  readonly token: string;
  readonly identity: AdultIdentity;
  readonly expiresAt: Date;
}

export interface AdultAuthProvider {
  readonly kind: "supabase" | "dev";
  /** Returns the identity for a valid, unexpired session token, otherwise null. Never throws for bad tokens. */
  verifySession(token: string): Promise<AdultIdentity | null>;
  /** Password sign-in. Returns null on bad credentials (callers must not reveal which part was wrong). */
  signInWithPassword(email: string, password: string): Promise<AdultSession | null>;
}

const TOKEN_REJECTIONS = [
  joseErrors.JWTExpired,
  joseErrors.JWTClaimValidationFailed,
  joseErrors.JWTInvalid,
  joseErrors.JWSInvalid,
  joseErrors.JWSSignatureVerificationFailed,
  joseErrors.JWKSNoMatchingKey,
  joseErrors.JWKSMultipleMatchingKeys,
  joseErrors.JOSEAlgNotAllowed,
  joseErrors.JOSENotSupported,
] as const;

function isTokenRejection(err: unknown): boolean {
  return TOKEN_REJECTIONS.some((cls) => err instanceof cls);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function identityFromClaims(payload: JWTPayload): AdultIdentity | null {
  const sub = payload.sub;
  const email = (payload as { email?: unknown }).email;
  if (typeof sub !== "string" || !Uuid.safeParse(sub).success) return null;
  if (typeof email !== "string" || !EMAIL.test(email) || email.length > 254) return null;
  return { userId: sub.toLowerCase(), email: email.toLowerCase() };
}

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface SupabaseJwtProviderOptions {
  readonly supabaseUrl: string;
  /** Legacy HS256 project JWT secret. When absent, the project JWKS endpoint is used. */
  readonly jwtSecret?: string | undefined;
  /** Public anon key; only needed for server-side password sign-in. */
  readonly anonKey?: string | undefined;
  readonly fetch?: FetchLike;
  /** Test seam: custom JWKS resolver. */
  readonly jwks?: JWTVerifyGetKey;
  readonly now?: () => Date;
}

/**
 * Verifies Supabase Auth access tokens (aud=authenticated, iss=<url>/auth/v1)
 * with the project's HS256 secret or its published JWKS.
 */
export class SupabaseJwtProvider implements AdultAuthProvider {
  readonly kind = "supabase" as const;
  private readonly issuer: string;
  private readonly baseUrl: string;
  private readonly secret: Uint8Array | null;
  private readonly jwks: JWTVerifyGetKey | null;
  private readonly fetchImpl: FetchLike | null;
  private readonly anonKey: string | null;
  private readonly now: () => Date;

  constructor(opts: SupabaseJwtProviderOptions) {
    let url: URL;
    try {
      url = new URL(opts.supabaseUrl);
    } catch {
      throw new ConfigError("SUPABASE_URL is not a valid URL");
    }
    this.baseUrl = url.origin + url.pathname.replace(/\/+$/, "");
    this.issuer = `${this.baseUrl}/auth/v1`;
    if (opts.jwtSecret !== undefined && opts.jwtSecret !== "") {
      if (new TextEncoder().encode(opts.jwtSecret).byteLength < 32) throw new ConfigError("SUPABASE_JWT_SECRET must be at least 32 bytes");
      this.secret = new TextEncoder().encode(opts.jwtSecret);
      this.jwks = null;
    } else {
      this.secret = null;
      this.jwks = opts.jwks ?? createRemoteJWKSet(new URL(`${this.issuer}/.well-known/jwks.json`));
    }
    this.fetchImpl = opts.fetch ?? null;
    this.anonKey = opts.anonKey ?? null;
    this.now = opts.now ?? (() => new Date());
  }

  async verifySession(token: string): Promise<AdultIdentity | null> {
    const payload = await this.verify(token);
    return payload ? identityFromClaims(payload) : null;
  }

  private async verify(token: string): Promise<JWTPayload | null> {
    if (typeof token !== "string" || token.length === 0 || token.length > 8192) return null;
    const options = {
      issuer: this.issuer,
      audience: "authenticated",
      currentDate: this.now(),
      requiredClaims: ["sub", "exp"],
    };
    try {
      const { payload } = this.secret
        ? await jwtVerify(token, this.secret, { ...options, algorithms: ["HS256"] })
        : await jwtVerify(token, this.jwks as JWTVerifyGetKey, { ...options, algorithms: ["ES256", "RS256"] });
      if ((payload as { role?: unknown }).role !== "authenticated") return null;
      return payload;
    } catch (err) {
      // Token problems (bad signature, expiry, claims) => not authenticated.
      // Anything else (e.g. JWKS endpoint unreachable) propagates: fail closed with a 500, not a silent 401.
      if (isTokenRejection(err)) return null;
      throw err;
    }
  }

  async signInWithPassword(email: string, password: string): Promise<AdultSession | null> {
    if (!this.fetchImpl || !this.anonKey) throw new ConfigError("Supabase password sign-in needs SUPABASE_ANON_KEY and fetch");
    const res = await this.fetchImpl(`${this.issuer}/token?grant_type=password`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: this.anonKey },
      body: JSON.stringify({ email, password }),
    });
    if (res.status === 400 || res.status === 401 || res.status === 422) return null;
    if (!res.ok) throw new Error(`Supabase auth responded ${res.status}`);
    const body = (await res.json()) as { access_token?: unknown };
    if (typeof body.access_token !== "string") throw new Error("Supabase auth response missing access_token");
    const payload = await this.verify(body.access_token);
    const identity = payload ? identityFromClaims(payload) : null;
    if (!payload || !identity || typeof payload.exp !== "number") return null;
    return { token: body.access_token, identity, expiresAt: new Date(payload.exp * 1000) };
  }
}
