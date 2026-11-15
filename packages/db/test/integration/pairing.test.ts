import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { withDbContext } from "../../src/index";
import { HH_A, HH_B, OUTSIDER, OWNER_A, OWNER_B, adultA, adultB, deviceB } from "../fixtures";
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
    await rolledBack({ kind: "adult", userId: "22222222-2222-4222-8222-222222222222" }, async (sql) => {
      await expectSqlState(sql, "42501", (sp) =>
        sp`insert into bnl.household_memberships (household_id, auth_user_id, role, invited_by)
           values (${HH_A}, ${randomUUID()}, 'guardian', '22222222-2222-4222-8222-222222222222')`);
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

describe("A2 direct-SQL flows under RLS", () => {
  it("job creates a code, adult claims it for an own household, job redeems, device reads its row", async () => {
    const pairingId = randomUUID();
    const codeHash = sha(`CODE-${pairingId}`);
    await withDbContext(db, { kind: "job" }, (sql) =>
      sql`insert into bnl.device_pairing_codes (pairing_id, code_hash, poll_secret_hash, expires_at)
          values (${pairingId}, ${codeHash}, ${sha("poll")}, now() + interval '10 minutes')`);

    // Outsider (no household) and household B cannot claim into A.
    await expect(withDbContext(db, { kind: "adult", userId: OUTSIDER }, (sql) =>
      sql`update bnl.device_pairing_codes set household_id = ${HH_A}, approved_by = ${OUTSIDER}, approved_at = now()
          where code_hash = ${codeHash}`)).rejects.toMatchObject({ code: "42501" });
    await expect(withDbContext(db, adultB, (sql) =>
      sql`update bnl.device_pairing_codes set household_id = ${HH_A}, approved_by = ${OWNER_B}, approved_at = now()
          where code_hash = ${codeHash}`)).rejects.toMatchObject({ code: "42501" });

    const deviceId = await withDbContext(db, adultA, async (sql) => {
      const [c] = await sql<{ id: string }[]>`
        select id from bnl.device_pairing_codes where code_hash = ${codeHash} and household_id is null and expires_at > now()`;
      const [d] = await sql<{ id: string }[]>`
        insert into bnl.paired_devices (household_id, label, approved_by) values (${HH_A}, 'A2 TV', ${OWNER_A}) returning id`;
      const upd = await sql`
        update bnl.device_pairing_codes set household_id = ${HH_A}, approved_by = ${OWNER_A}, approved_at = now(), device_id = ${d!.id}
        where id = ${c!.id}`;
      expect(upd.count).toBe(1);
      await sql`insert into bnl.audit_logs (actor_auth_id, household_id, action, target_type, target_id, metadata)
                values (${OWNER_A}, ${HH_A}, 'device.pair_approved', 'paired_device', ${d!.id}, '{}')`;
      // Cannot place a device into another household.
      await expectSqlState(sql, "42501", (sp) =>
        sp`insert into bnl.paired_devices (household_id, label, approved_by) values (${HH_B}, 'x', ${OWNER_A})`);
      return d!.id;
    });

    await withDbContext(db, { kind: "job" }, async (sql) => {
      const [c] = await sql<{ device_id: string }[]>`select device_id from bnl.device_pairing_codes where pairing_id = ${pairingId}`;
      expect(c?.device_id).toBe(deviceId);
      await sql`update bnl.paired_devices set refresh_token_hash = ${sha(`rt-${pairingId}`)}, refresh_rotated_at = now() where id = ${deviceId}`;
      await sql`update bnl.device_pairing_codes set redeemed_at = now() where pairing_id = ${pairingId}`;
      const [a] = await sql<{ actor_type: string }[]>`
        insert into bnl.audit_logs (household_id, action, target_type, target_id) values (${HH_A}, 'device.paired', 'paired_device', ${deviceId})
        returning actor_type`;
      expect(a?.actor_type).toBe("job");
    });

    const device = { kind: "device", householdId: HH_A, deviceId } as const;
    await withDbContext(db, device, async (sql) => {
      const rows = await sql<{ id: string; token_version: number }[]>`select id, token_version from bnl.paired_devices`;
      expect(rows).toEqual([{ id: deviceId, token_version: 1 }]);
      expect((await sql`update bnl.paired_devices set last_seen_at = now() where id = ${deviceId}`).count).toBe(1);
      // Refresh rotation + self-revocation (reuse detection) by the device itself, then an audit row.
      await sql`update bnl.paired_devices set refresh_token_hash = ${sha("rt2")}, refresh_rotated_at = now() where id = ${deviceId}`;
      await sql`update bnl.paired_devices set revoked_at = now(), token_version = token_version + 1 where id = ${deviceId}`;
      await sql`insert into bnl.audit_logs (actor_auth_id, household_id, action, target_type, target_id)
                values (${deviceId}, ${HH_A}, 'device.refresh_reuse', 'paired_device', ${deviceId})`;
    });
    const [reuse] = await admin<{ actor_type: string }[]>`
      select actor_type from bnl.audit_logs where action = 'device.refresh_reuse' and target_id = ${deviceId}`;
    expect(reuse?.actor_type).toBe("device");
    // Once revoked: still sees its own row (to fail closed on token_version) but can no longer update it.
    await withDbContext(db, device, async (sql) => {
      const [r] = await sql<{ revoked: boolean; v: number }[]>`select revoked_at is not null as revoked, token_version as v from bnl.paired_devices`;
      expect(r).toEqual({ revoked: true, v: 2 });
      expect((await sql`update bnl.paired_devices set last_seen_at = now()`).count).toBe(0);
      expect(await sql`select id from bnl.learner_profiles`).toHaveLength(0);
    });
    // Other devices never see it.
    await withDbContext(db, deviceB, async (sql) => {
      expect(await sql`select id from bnl.paired_devices where id = ${deviceId}`).toHaveLength(0);
    });
  });

  it("job rate limiting uses INSERT ... ON CONFLICT (key, window_start)", async () => {
    const key = `login:${sha(randomUUID())}`;
    const counts = await rolledBack({ kind: "job" }, async (sql) => {
      const out: number[] = [];
      for (let i = 0; i < 3; i++) {
        const [r] = await sql<{ count: number }[]>`
          insert into bnl.rate_limit_buckets (key, window_start, window_seconds, count)
          values (${key}, date_trunc('minute', now()), 60, 1)
          on conflict (key, window_start) do update set count = bnl.rate_limit_buckets.count + 1
          returning count`;
        out.push(r!.count);
      }
      return out;
    });
    expect(counts).toEqual([1, 2, 3]);
  });

  it("outsider adults see no household data", async () => {
    await withDbContext(db, { kind: "adult", userId: OUTSIDER }, async (sql) => {
      for (const t of ["households", "learner_profiles", "paired_devices", "consent_records", "household_memberships"]) {
        expect(await sql.unsafe(`select 1 from bnl.${t}`), t).toHaveLength(0);
      }
    });
  });

  it("learner_profiles slot uniqueness is a named constraint", async () => {
    await rolledBack(adultA, async (sql) => {
      await expect(sql.savepoint((sp) =>
        sp`insert into bnl.learner_profiles (household_id, slot, display_name, grade, avatar_id) values (${HH_A}, 1, 'Dup', 2, 'fox')`))
        .rejects.toMatchObject({ code: "23505", constraint_name: "learner_profiles_household_slot_key" });
    });
  });
});
