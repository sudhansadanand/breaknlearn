import { describe, expect, it } from "vitest";
import { contextSettings, DB_ROLES, DbContextError, isUuid, withDbContext } from "../../src/index";
import type { Db, DbContext } from "../../src/index";

const HH = "11111111-1111-4111-8111-111111111111";
const DEV = "d0000000-0000-4000-8000-0000000000a1";
const USER = "A0000000-0000-4000-8000-0000000000A1";

describe("contextSettings", () => {
  it("maps every context kind to its NOLOGIN role", () => {
    expect(contextSettings({ kind: "public" })).toEqual({ role: "bnl_public", householdId: "", deviceId: "", actorId: "" });
    expect(contextSettings({ kind: "job" })).toEqual({ role: "bnl_job", householdId: "", deviceId: "", actorId: "" });
    expect(contextSettings({ kind: "device", householdId: HH, deviceId: DEV })).toEqual({
      role: "bnl_device", householdId: HH, deviceId: DEV, actorId: "",
    });
    expect(contextSettings({ kind: "adult", userId: USER })).toEqual({
      role: "bnl_adult", householdId: "", deviceId: "", actorId: USER.toLowerCase(),
    });
    expect(contextSettings({ kind: "staff", userId: USER }).role).toBe("bnl_staff");
    expect(Object.values(DB_ROLES).sort()).toEqual(["bnl_adult", "bnl_device", "bnl_job", "bnl_public", "bnl_staff"]);
  });

  it.each([
    ["empty household", { kind: "device", householdId: "", deviceId: DEV }],
    ["sql in device id", { kind: "device", householdId: HH, deviceId: "x'; drop table bnl.lessons; --" }],
    ["short uuid", { kind: "adult", userId: "1234" }],
    ["uuid with suffix", { kind: "staff", userId: `${USER} ` }],
  ] as const)("rejects %s", (_label, ctx) => {
    expect(() => contextSettings(ctx as DbContext)).toThrow(DbContextError);
  });

  it("rejects an unknown kind at runtime", () => {
    expect(() => contextSettings({ kind: "root" } as unknown as DbContext)).toThrow(DbContextError);
  });
});

describe("isUuid", () => {
  it("accepts canonical uuids only", () => {
    expect(isUuid(HH)).toBe(true);
    expect(isUuid(HH.replace(/-/g, ""))).toBe(false);
    expect(isUuid(42)).toBe(false);
  });
});

describe("withDbContext", () => {
  it("validates the context before touching the pool", async () => {
    const calls: string[] = [];
    const fakeDb = { begin: () => { calls.push("begin"); return Promise.resolve(null); } } as unknown as Db;
    await expect(withDbContext(fakeDb, { kind: "adult", userId: "nope" }, () => Promise.resolve(1))).rejects.toThrow(
      DbContextError,
    );
    expect(calls).toEqual([]);
  });
});
