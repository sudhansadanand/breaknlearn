import type { ProfileInsertResult, ProfileRepo, ProfileRow, ProfileUpdateResult } from "./types";

/** bnl.learner_profiles (ADR-0005). Expects unique (household_id, slot) and PK id. */
const COLS = `id, household_id as "householdId", slot, display_name as "displayName", grade,
  avatar_id as "avatarId", preferences, updated_at as "updatedAt"`;

type UniqueViolation = { code: "23505"; constraint_name?: string | undefined };

function uniqueViolation(err: unknown): UniqueViolation | null {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505" ? (err as UniqueViolation) : null;
}

/** Slot uniqueness constraint names contain "slot"; anything else unique on this table is the id. */
const isSlotConstraint = (v: UniqueViolation) => (v.constraint_name ?? "").includes("slot");

export const sqlProfileRepo: ProfileRepo = {
  async listForHousehold(sql, householdId) {
    return sql<ProfileRow[]>`
      select ${sql.unsafe(COLS)} from bnl.learner_profiles where household_id = ${householdId} order by slot`;
  },

  async getInHousehold(sql, id, householdId) {
    const rows = await sql<ProfileRow[]>`
      select ${sql.unsafe(COLS)} from bnl.learner_profiles where id = ${id} and household_id = ${householdId} for update`;
    return rows[0] ?? null;
  },

  async insert(sql, p): Promise<ProfileInsertResult> {
    try {
      // Savepoint so a unique violation does not abort the surrounding transaction.
      const rows = await sql.savepoint((s) => s<ProfileRow[]>`
        insert into bnl.learner_profiles (id, household_id, slot, display_name, grade, avatar_id, preferences, updated_at)
        values (${p.id}, ${p.householdId}, ${p.slot}, ${p.displayName}, ${p.grade}, ${p.avatarId},
                ${sql.json(p.preferences as Parameters<typeof sql.json>[0])}, ${p.at})
        returning ${sql.unsafe(COLS)}`);
      const row = rows[0];
      if (!row) throw new Error("learner_profiles insert returned no row");
      return { kind: "ok", row };
    } catch (err) {
      const v = uniqueViolation(err);
      if (!v) throw err;
      return { kind: isSlotConstraint(v) ? "slot_taken" : "id_taken" };
    }
  },

  async update(sql, p): Promise<ProfileUpdateResult> {
    try {
      const rows = await sql.savepoint((s) => s<ProfileRow[]>`
        update bnl.learner_profiles
           set slot = ${p.slot}, display_name = ${p.displayName}, grade = ${p.grade}, avatar_id = ${p.avatarId},
               preferences = ${sql.json(p.preferences as Parameters<typeof sql.json>[0])}, updated_at = ${p.at}
         where id = ${p.id} and household_id = ${p.householdId}
         returning ${sql.unsafe(COLS)}`);
      const row = rows[0];
      return row ? { kind: "ok", row } : { kind: "missing" };
    } catch (err) {
      const v = uniqueViolation(err);
      if (v && isSlotConstraint(v)) return { kind: "slot_taken" };
      throw err;
    }
  },
};
