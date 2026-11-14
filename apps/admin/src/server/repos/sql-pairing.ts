import type { PairingCodeRow, PairingRepo } from "./types";

/** bnl.device_pairing_codes (ADR-0005 §3). */
export const sqlPairingRepo: PairingRepo = {
  async insert(sql, p) {
    await sql`
      insert into bnl.device_pairing_codes (pairing_id, code_hash, poll_secret_hash, expires_at, failed_attempts)
      values (${p.pairingId}, ${p.codeHash}, ${p.pollSecretHash}, ${p.expiresAt}, 0)`;
  },

  async findByCodeHash(sql, codeHash) {
    const rows = await sql<PairingCodeRow[]>`
      select id, pairing_id as "pairingId", household_id as "householdId", poll_secret_hash as "pollSecretHash",
             approved_at as "approvedAt", device_id as "deviceId", redeemed_at as "redeemedAt",
             failed_attempts as "failedAttempts", expires_at as "expiresAt"
        from bnl.device_pairing_codes
       where code_hash = ${codeHash}
       order by expires_at desc
       limit 1
         for update`;
    return rows[0] ?? null;
  },

  async findByPairingId(sql, pairingId) {
    const rows = await sql<PairingCodeRow[]>`
      select id, pairing_id as "pairingId", household_id as "householdId", poll_secret_hash as "pollSecretHash",
             approved_at as "approvedAt", device_id as "deviceId", redeemed_at as "redeemedAt",
             failed_attempts as "failedAttempts", expires_at as "expiresAt"
        from bnl.device_pairing_codes
       where pairing_id = ${pairingId}
         for update`;
    return rows[0] ?? null;
  },

  async markApproved(sql, p) {
    await sql`
      update bnl.device_pairing_codes
         set household_id = ${p.householdId}, approved_by = ${p.approvedBy}, approved_at = ${p.at}, device_id = ${p.deviceId}
       where id = ${p.id} and approved_at is null and redeemed_at is null`;
  },

  async markRedeemed(sql, p) {
    await sql`update bnl.device_pairing_codes set redeemed_at = ${p.at} where id = ${p.id} and redeemed_at is null`;
  },

  async incrementFailedAttempts(sql, id) {
    const rows = await sql<{ failedAttempts: number }[]>`
      update bnl.device_pairing_codes set failed_attempts = failed_attempts + 1
       where id = ${id}
       returning failed_attempts as "failedAttempts"`;
    return rows[0]?.failedAttempts ?? Number.MAX_SAFE_INTEGER;
  },
};
