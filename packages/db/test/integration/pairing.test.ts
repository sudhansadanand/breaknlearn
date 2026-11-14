import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { withDbContext } from "../../src/index";
import { HH_A, HH_B, OWNER_A, adultA, adultB } from "../fixtures";
import { admin, closeAll, db, expectSqlState, rolledBack } from "./helpers";

afterAll(closeAll);

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const pub = { kind: "public" } as const;

describe("device pairing functions (ADR-0002 P1)", () => {
  it("create -> pending -> approve -> redeem once -> gone; refresh rotation; device can then write", async () => {
    const pairingId = randomUUID();
    const code = "K7M2Q9XA";
    const poll = "p".repeat(40);
    const expires = new Date(Date.now() + 600_000);
    await withDbContext(db, pub, (sql) =>
      sql`select bnl.create_pairing_code(${pairingId}, ${sha(code)}, ${sha(poll)}, ${expires})`);

    const redeem = (secret: string, refresh: string) =>
      withDbContext(db, pub, async (sql) => {
        const [r] = await sql<{ status: string; device_id: string | null; household_id: string | null; token_version: number | null }[]>`
          select * from bnl.redeem_pairing(${pairingId}, ${sha(secret)}, ${sha(refresh)})`;
        return r!;
      });

    expect((await redeem(poll, "r1")).status).toBe("pending");
    expect((await redeem("wrong-secret-wrong-secret-wrong-secret!!", "r1")).status).toBe("invalid_secret");

    // Household B's adult cannot approve into household A; unknown codes yield no row.
    await expect(withDbContext(db, adultB, (sql) => sql`select * from bnl.approve_pairing(${sha(code)}, ${HH_A}, 'TV')`))
      .rejects.toMatchObject({ code: "42501" });
    const none = await withDbContext(db, adultA, (sql) => sql`select * from bnl.approve_pairing(${sha("NOPE2345")}, ${HH_A}, 'TV')`);
    expect(none).toHaveLength(0);

    const [approved] = await withDbContext(db, adultA, (sql) =>
      sql<{ pairing_id: string; device_id: string }[]>`select * from bnl.approve_pairing(${sha(code)}, ${HH_A}, 'Kitchen TV')`);
    expect(approved?.pairing_id).toBe(pairingId);

    const ok = await redeem(poll, "refresh-1");
    expect(ok).toEqual({ status: "redeemed", device_id: approved!.device_id, household_id: HH_A, token_version: 1 });
    expect((await redeem(poll, "refresh-2")).status).toBe("gone");

    const rotated = await withDbContext(db, pub, (sql) =>
      sql<{ device_id: string }[]>`select * from bnl.rotate_device_refresh(${sha("refresh-1")}, ${sha("refresh-3")})`);
    expect(rotated.map((r) => r.device_id)).toEqual([approved!.device_id]);
    const reused = await withDbContext(db, pub, (sql) =>
      sql`select * from bnl.rotate_device_refresh(${sha("refresh-1")}, ${sha("refresh-4")})`);
    expect(reused).toHaveLength(0);

    const device = { kind: "device", householdId: HH_A, deviceId: approved!.device_id } as const;
    await withDbContext(db, device, async (sql) => {
      const [t] = await sql<{ v: number }[]>`select bnl.touch_device() as v`;
      expect(t?.v).toBe(1);
      expect((await sql`select id from bnl.learner_profiles`).length).toBe(2);
    });

    const audit = await admin<{ action: string }[]>`
      select action from bnl.audit_logs where target_id = ${approved!.device_id} order by created_at, action`;
    expect(audit.map((a) => a.action).sort()).toEqual(["device.pair_approved", "device.paired"]);
    // Adults see their devices but never token hashes.
    await withDbContext(db, adultA, async (sql) => {
      expect(await sql`select id, label from bnl.paired_devices where id = ${approved!.device_id}`).toHaveLength(1);
    });
  });

  it("the public role cannot read pairing codes or devices directly", async () => {
    for (const q of ["select * from bnl.device_pairing_codes", "select id from bnl.paired_devices", "select * from bnl.rate_limit_buckets"]) {
      await expect(withDbContext(db, pub, (sql) => sql.unsafe(q)), q).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("pairing expiry is capped", async () => {
    await expect(withDbContext(db, pub, (sql) =>
      sql`select bnl.create_pairing_code(${randomUUID()}, ${sha("A")}, ${sha("B")}, ${new Date(Date.now() + 3_600_000)})`))
      .rejects.toMatchObject({ code: "22023" });
  });
});

describe("households, rate limits, retention", () => {
  it("create_household makes the caller owner, audited", async () => {
    const user = randomUUID();
    await rolledBack({ kind: "adult", userId: user }, async (sql) => {
      const [h] = await sql<{ id: string }[]>`select bnl.create_household('SYNTHETIC new', 'Asia/Kolkata') as id`;
      const m = await sql<{ role: string }[]>`select role from bnl.household_memberships where household_id = ${h!.id}`;
      expect(m).toEqual([{ role: "owner" }]);
      const [hh] = await sql<{ timezone: string }[]>`select timezone from bnl.households where id = ${h!.id}`;
      expect(hh?.timezone).toBe("Asia/Kolkata");
      await expectSqlState(sql, "22023", (sp) => sp`select bnl.create_household('x', 'Mars/Olympus')`);
    });
  });

  it("guardians cannot add members; owners can", async () => {
    await rolledBack({ kind: "adult", userId: "a0000000-0000-4000-8000-0000000000a2" }, async (sql) => {
      await expectSqlState(sql, "42501", (sp) =>
        sp`insert into bnl.household_memberships (household_id, auth_user_id, role, invited_by)
           values (${HH_A}, ${randomUUID()}, 'guardian', 'a0000000-0000-4000-8000-0000000000a2')`);
    });
    await rolledBack(adultA, async (sql) => {
      await sql`insert into bnl.household_memberships (household_id, auth_user_id, role, invited_by)
                values (${HH_A}, ${randomUUID()}, 'guardian', ${OWNER_A})`;
      await expectSqlState(sql, "42501", (sp) =>
        sp`insert into bnl.household_memberships (household_id, auth_user_id, role, invited_by)
           values (${HH_B}, ${randomUUID()}, 'guardian', ${OWNER_A})`);
    });
  });

  it("rate_limit_hit allows up to the limit per window", async () => {
    const key = `test:${randomUUID()}`;
    const results = await rolledBack(pub, async (sql) => {
      const out: boolean[] = [];
      for (let i = 0; i < 4; i++) {
        const [r] = await sql<{ ok: boolean }[]>`select bnl.rate_limit_hit(${key}, 60, 3) as ok`;
        out.push(r!.ok);
      }
      return out;
    });
    expect(results).toEqual([true, true, true, false]);
  });

  it("purge_expired runs as the job role, is audited and idempotent", async () => {
    await rolledBack({ kind: "job" }, async (sql) => {
      const [first] = await sql<{ r: Record<string, number> }[]>`select bnl.purge_expired() as r`;
      expect(first?.r).toMatchObject({ raw_days: 90, aggregate_days: 395 });
      const [second] = await sql<{ r: Record<string, number> }[]>`select bnl.purge_expired() as r`;
      expect(second?.r.learning_events).toBe(0);
      const audit = await sql`select id from bnl.audit_logs where action = 'retention.purge'`;
      expect(audit.length).toBeGreaterThanOrEqual(2);
    });
    await expect(withDbContext(db, adultA, (sql) => sql`select bnl.purge_expired()`)).rejects.toMatchObject({ code: "42501" });
  });
});
