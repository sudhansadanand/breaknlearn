import type { DeviceRepo, DeviceRow } from "./types";

/** bnl.paired_devices (ADR-0005 §3). */
const COLS = `id, household_id as "householdId", label, token_version as "tokenVersion",
  refresh_token_hash as "refreshTokenHash", last_seen_at as "lastSeenAt", revoked_at as "revokedAt", created_at as "createdAt"`;

export const sqlDeviceRepo: DeviceRepo = {
  async insert(sql, p) {
    const rows = await sql<DeviceRow[]>`
      insert into bnl.paired_devices (household_id, label, token_version, created_at)
      values (${p.householdId}, ${p.label}, 1, ${p.at})
      returning ${sql.unsafe(COLS)}`;
    const row = rows[0];
    if (!row) throw new Error("paired_devices insert returned no row");
    return row;
  },

  async get(sql, id) {
    const rows = await sql<DeviceRow[]>`select ${sql.unsafe(COLS)} from bnl.paired_devices where id = ${id} for update`;
    return rows[0] ?? null;
  },

  async touchIfCurrent(sql, p) {
    const rows = await sql`
      update bnl.paired_devices set last_seen_at = ${p.at}
       where id = ${p.id} and household_id = ${p.householdId} and token_version = ${p.tokenVersion} and revoked_at is null
       returning id`;
    return rows.length === 1;
  },

  async setRefreshHash(sql, p) {
    await sql`
      update bnl.paired_devices set refresh_token_hash = ${p.hash}, refresh_rotated_at = ${p.at}, last_seen_at = ${p.at}
       where id = ${p.id} and revoked_at is null`;
  },

  async revoke(sql, p) {
    const rows = await sql<DeviceRow[]>`
      update bnl.paired_devices
         set revoked_at = coalesce(revoked_at, ${p.at}), token_version = token_version + 1, refresh_token_hash = null
       where id = ${p.id} and household_id = ${p.householdId}
       returning ${sql.unsafe(COLS)}`;
    return rows[0] ?? null;
  },

  async listForHousehold(sql, householdId) {
    return sql<DeviceRow[]>`
      select ${sql.unsafe(COLS)} from bnl.paired_devices
       where household_id = ${householdId}
       order by created_at desc`;
  },
};
