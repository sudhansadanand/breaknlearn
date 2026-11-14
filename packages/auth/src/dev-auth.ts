import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { AdultAuthProvider, AdultIdentity, AdultSession } from "./adult-auth";
import { identityFromClaims } from "./adult-auth";
import { ConfigError, MIN_SECRET_BYTES } from "./secrets";

/**
 * LOCAL-ONLY adult auth for development and local E2E against a local DB.
 * It refuses to exist in production and has no built-in password: the shared
 * synthetic-user password comes from BNL_DEV_AUTH_PASSWORD on the developer's
 * machine. Users are synthetic and must match the local DB seed.
 */

export const DEV_SESSION_AUDIENCE = "bnl:dev-admin";
const DEV_SESSION_ISSUER = "bnl-dev-auth";
export const DEV_SESSION_TTL_SECONDS = 60 * 60;
export const DEV_MIN_PASSWORD_LENGTH = 12;

/** Synthetic users; ids are fixed so the local DB seed can attach memberships. */
export const DEV_SYNTHETIC_USERS = [
  { userId: "11111111-1111-4111-8111-111111111111", email: "owner@bnl.test" },
  { userId: "22222222-2222-4222-8222-222222222222", email: "guardian@bnl.test" },
  { userId: "33333333-3333-4333-8333-333333333333", email: "outsider@bnl.test" },
] as const satisfies readonly AdultIdentity[];

export interface DevUserSeed extends AdultIdentity {
  readonly password: string;
}

interface StoredUser extends AdultIdentity {
  readonly salt: Buffer;
  readonly hash: Buffer;
}

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 } as const;

function scrypt(password: string, salt: Buffer): Buffer {
  return scryptSync(password.normalize("NFKC"), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
}

export function hashPassword(password: string): { salt: Buffer; hash: Buffer } {
  const salt = randomBytes(16);
  return { salt, hash: scrypt(password, salt) };
}

export function verifyPassword(password: string, salt: Buffer, hash: Buffer): boolean {
  return timingSafeEqual(scrypt(password, salt), hash);
}

export type EnvLike = Readonly<Record<string, string | undefined>>;

/** Throws unless the environment is explicitly local development. */
export function assertDevAuthAllowed(env: EnvLike): void {
  if (env.NODE_ENV === "production") throw new ConfigError("DevAuthProvider is disabled when NODE_ENV=production");
  if (env.VERCEL_ENV === "production") throw new ConfigError("DevAuthProvider is disabled when VERCEL_ENV=production");
  if (env.BNL_DEV_AUTH !== "true") throw new ConfigError("DevAuthProvider requires BNL_DEV_AUTH=true");
}

export interface DevAuthProviderOptions {
  readonly env: EnvLike;
  readonly users: readonly DevUserSeed[];
  /** ≥32-byte key for signing dev sessions (derive from the server secret). */
  readonly sessionKey: Uint8Array;
  readonly now?: () => Date;
}

export class DevAuthProvider implements AdultAuthProvider {
  readonly kind = "dev" as const;
  private readonly users = new Map<string, StoredUser>();
  private readonly dummy: { salt: Buffer; hash: Buffer };
  private readonly sessionKey: Uint8Array;
  private readonly now: () => Date;

  constructor(opts: DevAuthProviderOptions) {
    assertDevAuthAllowed(opts.env);
    if (opts.sessionKey.byteLength < MIN_SECRET_BYTES) throw new ConfigError("dev session key too short");
    for (const u of opts.users) {
      if (u.password.length < DEV_MIN_PASSWORD_LENGTH) {
        throw new ConfigError(`dev user password must be at least ${DEV_MIN_PASSWORD_LENGTH} characters`);
      }
      this.users.set(u.email.toLowerCase(), { userId: u.userId, email: u.email.toLowerCase(), ...hashPassword(u.password) });
    }
    this.dummy = hashPassword(randomBytes(16).toString("hex"));
    this.sessionKey = opts.sessionKey;
    this.now = opts.now ?? (() => new Date());
  }

  /** Seeds DEV_SYNTHETIC_USERS with the password from BNL_DEV_AUTH_PASSWORD. */
  static fromEnv(env: EnvLike, sessionKey: Uint8Array, now?: () => Date): DevAuthProvider {
    assertDevAuthAllowed(env);
    const password = env.BNL_DEV_AUTH_PASSWORD;
    if (password === undefined || password.length < DEV_MIN_PASSWORD_LENGTH) {
      throw new ConfigError(`BNL_DEV_AUTH_PASSWORD must be set (≥${DEV_MIN_PASSWORD_LENGTH} chars) to use DevAuthProvider`);
    }
    return new DevAuthProvider({
      env,
      sessionKey,
      users: DEV_SYNTHETIC_USERS.map((u) => ({ ...u, password })),
      ...(now ? { now } : {}),
    });
  }

  async signInWithPassword(email: string, password: string): Promise<AdultSession | null> {
    const user = this.users.get(email.trim().toLowerCase());
    // Always run scrypt so unknown emails take as long as wrong passwords.
    const ok = user ? verifyPassword(password, user.salt, user.hash) : verifyPassword(password, this.dummy.salt, this.dummy.hash) && false;
    if (!user || !ok) return null;
    const iat = Math.floor(this.now().getTime() / 1000);
    const exp = iat + DEV_SESSION_TTL_SECONDS;
    const token = await new SignJWT({ email: user.email })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(user.userId)
      .setIssuer(DEV_SESSION_ISSUER)
      .setAudience(DEV_SESSION_AUDIENCE)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(this.sessionKey);
    return { token, identity: { userId: user.userId, email: user.email }, expiresAt: new Date(exp * 1000) };
  }

  async verifySession(token: string): Promise<AdultIdentity | null> {
    if (typeof token !== "string" || token.length === 0 || token.length > 4096) return null;
    try {
      const { payload } = await jwtVerify(token, this.sessionKey, {
        algorithms: ["HS256"],
        issuer: DEV_SESSION_ISSUER,
        audience: DEV_SESSION_AUDIENCE,
        currentDate: this.now(),
      });
      const identity = identityFromClaims(payload);
      // Only currently seeded users are valid (a removed user loses access immediately).
      return identity && this.users.get(identity.email)?.userId === identity.userId ? identity : null;
    } catch {
      // Dev sessions are verified locally with no I/O: every failure is a token rejection.
      return null;
    }
  }
}
