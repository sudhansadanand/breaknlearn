import type { HouseholdRole, StaffRole } from "@bnl/contracts";
import type { Sql } from "../db-port";

/**
 * Repository ports. All SQL lives in the `sql-*.ts` implementations so the
 * lead can reconcile table/column names with A1's migrations in one place.
 * Handlers own the business rules; repositories are thin data access.
 */

export interface PairingCodeRow {
  readonly id: string;
  readonly pairingId: string;
  readonly householdId: string | null;
  readonly pollSecretHash: string;
  readonly approvedAt: Date | null;
  readonly deviceId: string | null;
  readonly redeemedAt: Date | null;
  readonly failedAttempts: number;
  readonly expiresAt: Date;
}

export interface PairingRepo {
  insert(sql: Sql, p: { pairingId: string; codeHash: string; pollSecretHash: string; expiresAt: Date }): Promise<void>;
  /** Locks the row (FOR UPDATE). */
  findByCodeHash(sql: Sql, codeHash: string): Promise<PairingCodeRow | null>;
  /** Locks the row (FOR UPDATE). */
  findByPairingId(sql: Sql, pairingId: string): Promise<PairingCodeRow | null>;
  markApproved(sql: Sql, p: { id: string; householdId: string; approvedBy: string; deviceId: string; at: Date }): Promise<void>;
  markRedeemed(sql: Sql, p: { id: string; at: Date }): Promise<void>;
  /** Returns the new failed_attempts value. */
  incrementFailedAttempts(sql: Sql, id: string): Promise<number>;
}

export interface DeviceRow {
  readonly id: string;
  readonly householdId: string;
  readonly label: string;
  readonly tokenVersion: number;
  readonly refreshTokenHash: string | null;
  readonly lastSeenAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

export interface DeviceRepo {
  insert(sql: Sql, p: { householdId: string; label: string; at: Date }): Promise<DeviceRow>;
  /** Locks the row (FOR UPDATE). */
  get(sql: Sql, id: string): Promise<DeviceRow | null>;
  /** Marks the device seen iff it is unrevoked and on `tokenVersion`; false => token is stale/revoked. */
  touchIfCurrent(sql: Sql, p: { id: string; householdId: string; tokenVersion: number; at: Date }): Promise<boolean>;
  setRefreshHash(sql: Sql, p: { id: string; hash: string; at: Date }): Promise<void>;
  /** Sets revoked_at (if unset), bumps token_version, clears the refresh hash. Null if not in household. */
  revoke(sql: Sql, p: { id: string; householdId: string; at: Date }): Promise<DeviceRow | null>;
  listForHousehold(sql: Sql, householdId: string): Promise<DeviceRow[]>;
}

export interface ProfileRow {
  readonly id: string;
  readonly householdId: string;
  readonly slot: number;
  readonly displayName: string;
  readonly grade: number;
  readonly avatarId: string;
  readonly preferences: unknown;
  readonly updatedAt: Date;
}

export type ProfileWrite = Omit<ProfileRow, "updatedAt"> & { readonly at: Date };

export type ProfileInsertResult = { readonly kind: "ok"; readonly row: ProfileRow } | { readonly kind: "id_taken" } | { readonly kind: "slot_taken" };
export type ProfileUpdateResult = { readonly kind: "ok"; readonly row: ProfileRow } | { readonly kind: "slot_taken" } | { readonly kind: "missing" };

export interface ProfileRepo {
  listForHousehold(sql: Sql, householdId: string): Promise<ProfileRow[]>;
  /** Visible row only (RLS-scoped); null if absent or in another household. */
  getInHousehold(sql: Sql, id: string, householdId: string): Promise<ProfileRow | null>;
  /** `id_taken`: the id exists outside the caller's scope (unique violation on the PK). */
  insert(sql: Sql, p: ProfileWrite): Promise<ProfileInsertResult>;
  update(sql: Sql, p: ProfileWrite): Promise<ProfileUpdateResult>;
}

export interface MembershipRepo {
  activeMemberships(sql: Sql, userId: string): Promise<{ householdId: string; role: HouseholdRole }[]>;
  activeStaffRoles(sql: Sql, userId: string): Promise<StaffRole[]>;
}

export interface ConsentRepo {
  grant(sql: Sql, p: { householdId: string; userId: string; consentVersion: string; at: Date }): Promise<void>;
  /** Returns the number of active grants revoked. */
  revoke(sql: Sql, p: { householdId: string; userId: string; consentVersion: string; at: Date }): Promise<number>;
}

export interface AuditEntry {
  readonly actorAuthId: string | null;
  readonly householdId: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  /** Must never contain names, answers or tokens; redacted again before insert. */
  readonly metadata: Record<string, unknown>;
}

export interface AuditRepo {
  insert(sql: Sql, entry: AuditEntry): Promise<void>;
}

export interface RateLimitRepo {
  increment(sql: Sql, key: string, windowStart: Date, windowSeconds: number): Promise<number>;
}

export interface Repos {
  readonly pairing: PairingRepo;
  readonly devices: DeviceRepo;
  readonly profiles: ProfileRepo;
  readonly memberships: MembershipRepo;
  readonly consent: ConsentRepo;
  readonly audit: AuditRepo;
  readonly rateLimits: RateLimitRepo;
}
