/**
 * In-memory fakes for route tests: a DbRunner that records each DbContext and
 * rolls back on throw, and repositories that mimic RLS scoping using the
 * context carried on the fake `sql` handle.
 */
import { randomUUID } from "node:crypto";
import {
  CSRF_COOKIE,
  MemoryRateLimiter,
  deriveServerKeys,
  generateCsrfToken,
  type AdultAuthProvider,
  type AdultIdentity,
  type AdultSession,
} from "@bnl/auth";
import type { HouseholdRole, StaffRole } from "@bnl/contracts";
import type { DbContext, DbRunner, Sql } from "../src/server/db-port";
import type { AppDeps } from "../src/server/deps";
import type { AuditEntry, DeviceRow, PairingCodeRow, ProfileRow, Repos } from "../src/server/repos";

export const ORIGIN = "http://localhost:3000";
export const HH_A = "a0000000-0000-4000-8000-00000000000a";
export const HH_B = "b0000000-0000-4000-8000-00000000000b";
export const OWNER_A: AdultIdentity = { userId: "11111111-1111-4111-8111-111111111111", email: "owner@bnl.test" };
export const GUARDIAN_A: AdultIdentity = { userId: "22222222-2222-4222-8222-222222222222", email: "guardian@bnl.test" };
export const OWNER_B: AdultIdentity = { userId: "44444444-4444-4444-8444-444444444444", email: "owner-b@bnl.test" };
export const OUTSIDER: AdultIdentity = { userId: "33333333-3333-4333-8333-333333333333", email: "outsider@bnl.test" };

interface PairingStored extends PairingCodeRow {
  codeHash: string;
  approvedBy: string | null;
}
interface ConsentStored {
  householdId: string;
  userId: string;
  consentVersion: string;
  grantedAt: Date;
  revokedAt: Date | null;
}

export interface Store {
  pairing: PairingStored[];
  devices: DeviceRow[];
  profiles: ProfileRow[];
  memberships: { householdId: string; userId: string; role: HouseholdRole; active: boolean }[];
  staff: { userId: string; role: StaffRole; revokedAt: Date | null }[];
  consent: ConsentStored[];
  audit: AuditEntry[];
}

type FakeSql = { readonly ctx: DbContext };
const ctxOf = (sql: Sql): DbContext => (sql as unknown as FakeSql).ctx;

/** RLS emulation: which household rows the context may see. `null` = unrestricted (job). */
function visibleHousehold(store: Store, ctx: DbContext): string[] | null {
  switch (ctx.kind) {
    case "job":
      return null;
    case "device":
      return [ctx.householdId];
    case "adult":
      return store.memberships.filter((m) => m.userId === ctx.userId && m.active).map((m) => m.householdId);
    default:
      return [];
  }
}
function canSee(store: Store, sql: Sql, householdId: string | null): boolean {
  const v = visibleHousehold(store, ctxOf(sql));
  return v === null || (householdId !== null && v.includes(householdId));
}

export function fakeRepos(store: Store): Repos {
  const mutable = <T>(row: T) => row as { -readonly [K in keyof T]: T[K] };
  const pairingRow = (id: string) => {
    const row = store.pairing.find((x) => x.id === id);
    if (!row) throw new Error(`no pairing row ${id}`);
    return mutable(row);
  };
  return {
    pairing: {
      async insert(_sql, p) {
        store.pairing.push({
          id: randomUUID(), pairingId: p.pairingId, codeHash: p.codeHash, pollSecretHash: p.pollSecretHash, expiresAt: p.expiresAt,
          householdId: null, approvedAt: null, approvedBy: null, deviceId: null, redeemedAt: null, failedAttempts: 0,
        });
      },
      async findByCodeHash(sql, codeHash) {
        // Unclaimed codes are visible to adults (approval policy); claimed ones only within scope.
        return store.pairing.find((r) => r.codeHash === codeHash && (r.householdId === null || canSee(store, sql, r.householdId))) ?? null;
      },
      async findByPairingId(_sql, pairingId) {
        return store.pairing.find((r) => r.pairingId === pairingId) ?? null;
      },
      async markApproved(_sql, p) {
        const r = pairingRow(p.id);
        Object.assign(r, { householdId: p.householdId, approvedBy: p.approvedBy, approvedAt: p.at, deviceId: p.deviceId });
      },
      async markRedeemed(_sql, p) {
        pairingRow(p.id).redeemedAt = p.at;
      },
      async incrementFailedAttempts(_sql, id) {
        const r = pairingRow(id);
        r.failedAttempts += 1;
        return r.failedAttempts;
      },
    },
    devices: {
      async insert(sql, p) {
        if (!canSee(store, sql, p.householdId)) throw new Error("RLS: insert outside scope");
        const row: DeviceRow = { id: randomUUID(), householdId: p.householdId, label: p.label, tokenVersion: 1, refreshTokenHash: null, lastSeenAt: null, revokedAt: null, createdAt: p.at };
        store.devices.push(row);
        return { ...row };
      },
      async get(sql, id) {
        const row = store.devices.find((d) => d.id === id && canSee(store, sql, d.householdId));
        return row ? { ...row } : null;
      },
      async touchIfCurrent(sql, p) {
        const row = store.devices.find((d) => d.id === p.id && d.householdId === p.householdId && canSee(store, sql, d.householdId));
        if (!row || row.revokedAt !== null || row.tokenVersion !== p.tokenVersion) return false;
        mutable(row).lastSeenAt = p.at;
        return true;
      },
      async setRefreshHash(sql, p) {
        const row = store.devices.find((d) => d.id === p.id && d.revokedAt === null && canSee(store, sql, d.householdId));
        if (row) Object.assign(mutable(row), { refreshTokenHash: p.hash, lastSeenAt: p.at });
      },
      async revoke(sql, p) {
        const row = store.devices.find((d) => d.id === p.id && d.householdId === p.householdId && canSee(store, sql, d.householdId));
        if (!row) return null;
        Object.assign(mutable(row), { revokedAt: row.revokedAt ?? p.at, tokenVersion: row.tokenVersion + 1, refreshTokenHash: null });
        return { ...row };
      },
      async listForHousehold(sql, householdId) {
        return store.devices.filter((d) => d.householdId === householdId && canSee(store, sql, d.householdId)).map((d) => ({ ...d }));
      },
    },
    profiles: {
      async listForHousehold(sql, householdId) {
        return store.profiles.filter((p) => p.householdId === householdId && canSee(store, sql, p.householdId)).sort((a, b) => a.slot - b.slot).map((p) => ({ ...p }));
      },
      async getInHousehold(sql, id, householdId) {
        const row = store.profiles.find((p) => p.id === id && p.householdId === householdId && canSee(store, sql, p.householdId));
        return row ? { ...row } : null;
      },
      async insert(sql, p) {
        if (!canSee(store, sql, p.householdId)) throw new Error("RLS: insert outside scope");
        if (store.profiles.some((x) => x.id === p.id)) return { kind: "id_taken" };
        if (store.profiles.some((x) => x.householdId === p.householdId && x.slot === p.slot)) return { kind: "slot_taken" };
        if (p.slot !== 1 && p.slot !== 2) throw new Error("check constraint: slot in (1,2)");
        const { at, ...rest } = p;
        const row: ProfileRow = { ...rest, updatedAt: at };
        store.profiles.push(row);
        return { kind: "ok", row: { ...row } };
      },
      async update(sql, p) {
        const row = store.profiles.find((x) => x.id === p.id && x.householdId === p.householdId && canSee(store, sql, x.householdId));
        if (!row) return { kind: "missing" };
        if (store.profiles.some((x) => x.householdId === p.householdId && x.slot === p.slot && x.id !== p.id)) return { kind: "slot_taken" };
        const { at, ...rest } = p;
        Object.assign(mutable(row), { ...rest, updatedAt: at });
        return { kind: "ok", row: { ...row } };
      },
    },
    memberships: {
      async activeMemberships(sql, userId) {
        const ctx = ctxOf(sql);
        if (ctx.kind !== "adult" || ctx.userId !== userId) throw new Error("RLS: memberships readable only by self");
        return store.memberships.filter((m) => m.userId === userId && m.active).map((m) => ({ householdId: m.householdId, role: m.role }));
      },
      async activeStaffRoles(_sql, userId) {
        return store.staff.filter((s) => s.userId === userId && s.revokedAt === null).map((s) => s.role);
      },
    },
    consent: {
      async grant(sql, p) {
        if (!canSee(store, sql, p.householdId)) throw new Error("RLS");
        store.consent.push({ householdId: p.householdId, userId: p.userId, consentVersion: p.consentVersion, grantedAt: p.at, revokedAt: null });
      },
      async revoke(_sql, p) {
        const rows = store.consent.filter((c) => c.householdId === p.householdId && c.userId === p.userId && c.consentVersion === p.consentVersion && c.revokedAt === null);
        for (const r of rows) r.revokedAt = p.at;
        return rows.length;
      },
    },
    audit: {
      async insert(_sql, e) {
        store.audit.push(e);
      },
    },
    rateLimits: {
      async increment() {
        throw new Error("tests use MemoryRateLimiter");
      },
    },
  };
}

/** Records contexts; restores the store snapshot when `fn` throws (transaction rollback). */
export function fakeDbRunner(store: Store, contexts: DbContext[]): DbRunner {
  return async <T>(ctx: DbContext, fn: (sql: Sql) => Promise<T>): Promise<T> => {
    contexts.push(ctx);
    const snapshot = structuredClone(store);
    try {
      return await fn({ ctx } as unknown as Sql);
    } catch (err) {
      Object.assign(store, snapshot);
      throw err;
    }
  };
}

export class FakeAdultAuth implements AdultAuthProvider {
  readonly kind = "dev" as const;
  readonly sessions = new Map<string, AdultIdentity>();
  readonly passwords = new Map<string, { password: string; identity: AdultIdentity }>();

  sessionFor(identity: AdultIdentity): string {
    const token = `sess-${randomUUID()}`;
    this.sessions.set(token, identity);
    return token;
  }
  async verifySession(token: string) {
    return this.sessions.get(token) ?? null;
  }
  async signInWithPassword(email: string, password: string): Promise<AdultSession | null> {
    const entry = this.passwords.get(email);
    if (!entry || entry.password !== password) return null;
    return { token: this.sessionFor(entry.identity), identity: entry.identity, expiresAt: new Date(Date.now() + 3600_000) };
  }
  /** Like Supabase: existing sessions keep their (stale) claims; only sessions minted afterwards lose the flag. */
  readonly passwordChanges: { userId: string; accessToken: string }[] = [];
  async changePassword(input: { accessToken: string; userId: string; newPassword: string }): Promise<void> {
    const entry = [...this.passwords.values()].find((e) => e.identity.userId === input.userId);
    if (!entry || this.sessions.get(input.accessToken)?.userId !== input.userId) throw new Error("fake changePassword: bad session");
    this.passwordChanges.push({ userId: input.userId, accessToken: input.accessToken });
    entry.password = input.newPassword;
    entry.identity = { userId: entry.identity.userId, email: entry.identity.email };
  }
}

export interface TestEnv {
  deps: AppDeps;
  store: Store;
  contexts: DbContext[];
  auth: FakeAdultAuth;
  clock: { now: Date };
  advance(ms: number): void;
}

export function makeTestEnv(): TestEnv {
  const store: Store = {
    pairing: [], devices: [], profiles: [], consent: [], audit: [], staff: [],
    memberships: [
      { householdId: HH_A, userId: OWNER_A.userId, role: "owner", active: true },
      { householdId: HH_A, userId: GUARDIAN_A.userId, role: "guardian", active: true },
      { householdId: HH_B, userId: OWNER_B.userId, role: "owner", active: true },
    ],
  };
  const contexts: DbContext[] = [];
  const clock = { now: new Date("2026-11-14T10:00:00Z") };
  const auth = new FakeAdultAuth();
  auth.passwords.set(OWNER_A.email, { password: "correct horse battery", identity: OWNER_A });
  const deps: AppDeps = {
    db: fakeDbRunner(store, contexts),
    repos: fakeRepos(store),
    adultAuth: auth,
    keys: deriveServerKeys(new TextEncoder().encode("route-test-secret-0123456789abcdefghijkl")),
    rateLimiter: new MemoryRateLimiter(() => clock.now),
    adminOrigin: ORIGIN,
    secureCookies: false,
    now: () => clock.now,
    uuid: randomUUID,
    log: () => undefined,
  };
  return { deps, store, contexts, auth, clock, advance: (ms) => (clock.now = new Date(clock.now.getTime() + ms)) };
}

export interface ReqOpts {
  body?: unknown;
  session?: string;
  /** true (default for mutations with a session) sends a valid Origin + matching CSRF cookie/header. */
  csrf?: boolean;
  origin?: string | null;
  csrfHeader?: string | null;
  bearer?: string;
  ip?: string;
  rawBody?: string;
  contentType?: string;
}

export function req(method: string, path: string, o: ReqOpts = {}): Request {
  const headers = new Headers();
  const cookies: string[] = [];
  if (o.session) cookies.push(`bnl_admin_session=${o.session}`);
  const csrf = o.csrf ?? method !== "GET";
  if (csrf) {
    const t = generateCsrfToken();
    cookies.push(`${CSRF_COOKIE}=${t}`);
    headers.set("X-CSRF-Token", o.csrfHeader === undefined ? t : (o.csrfHeader ?? ""));
    if (o.origin !== null) headers.set("origin", o.origin ?? ORIGIN);
  } else if (o.origin) headers.set("origin", o.origin);
  if (cookies.length) headers.set("cookie", cookies.join("; "));
  if (o.bearer) headers.set("authorization", `Bearer ${o.bearer}`);
  headers.set("x-forwarded-for", o.ip ?? "203.0.113.7");
  let body: string | undefined;
  if (o.rawBody !== undefined || o.body !== undefined) {
    headers.set("content-type", o.contentType ?? "application/json");
    body = o.rawBody ?? JSON.stringify(o.body);
  }
  return new Request(`${ORIGIN}${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
}

export async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}
