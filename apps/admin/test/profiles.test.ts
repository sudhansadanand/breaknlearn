import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError, Profile, ProfileList } from "@bnl/contracts";
import { signDeviceAccessToken } from "@bnl/auth";
import { setDepsForTesting } from "../src/server/deps";
import { GUARDIAN_A, HH_A, HH_B, OWNER_A, OWNER_B, bodyOf, makeTestEnv, req, type TestEnv } from "./fakes";
import { routes } from "./routes";

let env: TestEnv;
let tokenA: string;
let tokenB: string;
const DEV_A = "da000000-0000-4000-8000-0000000000a1";
const DEV_B = "db000000-0000-4000-8000-0000000000b1";
const P1 = "f1000000-0000-4000-8000-000000000001";
const P2 = "f2000000-0000-4000-8000-000000000002";
const P3 = "f3000000-0000-4000-8000-000000000003";
const PB = "fb000000-0000-4000-8000-0000000000b1";

const profile = (id: string, slot: 1 | 2, display_name = "Asha", extra: Record<string, unknown> = {}) => ({
  id, slot, display_name, grade: 2, avatar_id: "fox", ...extra,
});

beforeEach(async () => {
  env = makeTestEnv();
  setDepsForTesting(env.deps);
  for (const [id, householdId] of [[DEV_A, HH_A], [DEV_B, HH_B]] as const) {
    env.store.devices.push({ id, householdId, label: "TV", tokenVersion: 1, refreshTokenHash: null, lastSeenAt: null, revokedAt: null, createdAt: env.clock.now });
  }
  tokenA = (await signDeviceAccessToken(env.deps.keys.deviceToken, { deviceId: DEV_A, householdId: HH_A, tokenVersion: 1 }, env.clock.now)).token;
  tokenB = (await signDeviceAccessToken(env.deps.keys.deviceToken, { deviceId: DEV_B, householdId: HH_B, tokenVersion: 1 }, env.clock.now)).token;
  env.store.profiles.push({ id: PB, householdId: HH_B, slot: 1, displayName: "Bea", grade: 6, avatarId: "panda", preferences: {}, updatedAt: env.clock.now });
});
afterEach(() => setDepsForTesting(null));

const devicePost = (bearer: string, body: unknown) => routes.profiles.POST(req("POST", "/api/v1/profiles", { bearer, csrf: false, body }));

describe("profiles", () => {
  it("device creates and lists profiles in its own household only", async () => {
    const res = await devicePost(tokenA, profile(P1, 1));
    expect(res.status).toBe(200);
    const saved = Profile.parse(await res.json());
    expect(saved).toMatchObject({ id: P1, slot: 1, display_name: "Asha", preferences: { music_enabled: true, last_theme_key: null, last_table: null } });
    const list = ProfileList.parse(await (await routes.profiles.GET(req("GET", "/api/v1/profiles", { bearer: tokenA }))).json());
    expect(list.profiles.map((p) => p.id)).toEqual([P1]);
    const listB = ProfileList.parse(await (await routes.profiles.GET(req("GET", "/api/v1/profiles", { bearer: tokenB }))).json());
    expect(listB.profiles.map((p) => p.id)).toEqual([PB]);
    // Audit never contains the display name.
    expect(JSON.stringify(env.store.audit)).not.toContain("Asha");
  });

  it("ignores a submitted household_id: the household comes from the credential", async () => {
    const res = await devicePost(tokenA, { ...profile(P1, 1), household_id: HH_B });
    expect(res.status).toBe(200);
    expect(env.store.profiles.find((p) => p.id === P1)?.householdId).toBe(HH_A);
  });

  it("device cannot write a profile into another household (403, target untouched)", async () => {
    const res = await devicePost(tokenA, profile(PB, 2, "Mallory"));
    expect(res.status).toBe(403);
    expect(ApiError.parse(await res.json()).error.code).toBe("forbidden");
    expect(env.store.profiles.find((p) => p.id === PB)).toMatchObject({ householdId: HH_B, displayName: "Bea", slot: 1 });
    expect(env.store.profiles.filter((p) => p.householdId === HH_A)).toHaveLength(0);
  });

  it("rejects display_name markup and control characters (422)", async () => {
    for (const name of ["<b>x</b>", "a>b", "tab\there", "", " ".repeat(3), "x".repeat(31)]) {
      const res = await devicePost(tokenA, profile(P1, 1, name));
      expect(res.status, name).toBe(422);
      const body = await bodyOf(res);
      // Validation details carry paths, never the submitted value.
      expect(JSON.stringify(body)).not.toContain("<b>");
    }
    expect(env.store.profiles.filter((p) => p.householdId === HH_A)).toHaveLength(0);
  });

  it("rejects a third profile and a taken slot (422)", async () => {
    expect((await devicePost(tokenA, profile(P1, 1))).status).toBe(200);
    const taken = await devicePost(tokenA, profile(P3, 1, "Other"));
    expect(taken.status).toBe(422);
    expect((await devicePost(tokenA, profile(P2, 2, "Ravi"))).status).toBe(200);
    const third = await devicePost(tokenA, profile(P3, 1, "Third"));
    expect(third.status).toBe(422);
    expect(ApiError.parse(await third.json()).error.details).toMatchObject({ issues: [{ path: "id", code: "profile_limit" }] });
    expect(env.store.profiles.filter((p) => p.householdId === HH_A)).toHaveLength(2);
    // slot outside 1|2 is a contract violation
    expect((await devicePost(tokenA, profile(P3, 3 as 1))).status).toBe(422);
  });

  it("updates an existing profile in place, including preferences", async () => {
    await devicePost(tokenA, profile(P1, 1));
    const res = await devicePost(tokenA, profile(P1, 1, "Asha K", { grade: 6, preferences: { music_enabled: false, last_theme_key: "farm", last_table: 3 } }));
    expect(res.status).toBe(200);
    expect(Profile.parse(await res.json())).toMatchObject({ display_name: "Asha K", grade: 6, preferences: { music_enabled: false, last_theme_key: "farm", last_table: 3 } });
    expect(env.store.audit.map((a) => a.action)).toEqual(["profile.created", "profile.updated"]);
  });

  it("guardian (cookie session + CSRF) can view and edit; other households' adults cannot see them", async () => {
    await devicePost(tokenA, profile(P1, 1));
    const guardian = env.auth.sessionFor(GUARDIAN_A);
    const list = ProfileList.parse(await (await routes.profiles.GET(req("GET", "/api/v1/profiles", { session: guardian }))).json());
    expect(list.profiles.map((p) => p.id)).toEqual([P1]);
    const edit = await routes.profiles.POST(req("POST", "/api/v1/profiles", { session: guardian, body: profile(P1, 1, "Ash") }));
    expect(edit.status).toBe(200);
    expect(env.store.audit.at(-1)).toMatchObject({ actorAuthId: GUARDIAN_A.userId, action: "profile.updated" });

    const ownerB = env.auth.sessionFor(OWNER_B);
    const listB = ProfileList.parse(await (await routes.profiles.GET(req("GET", "/api/v1/profiles", { session: ownerB }))).json());
    expect(listB.profiles.map((p) => p.id)).toEqual([PB]);
    const hijack = await routes.profiles.POST(req("POST", "/api/v1/profiles", { session: ownerB, body: profile(P1, 2, "Eve") }));
    expect(hijack.status).toBe(403);
    void OWNER_A;
  });

  it("device tokens for a revoked or version-bumped device are rejected", async () => {
    env.store.devices[0] = { ...env.store.devices[0]!, tokenVersion: 2 };
    expect((await routes.profiles.GET(req("GET", "/api/v1/profiles", { bearer: tokenA }))).status).toBe(401);
    expect((await devicePost(tokenA, profile(P1, 1))).status).toBe(401);
  });

  it("an expired or tampered device token is rejected", async () => {
    env.advance(15 * 60 * 1000);
    expect((await routes.profiles.GET(req("GET", "/api/v1/profiles", { bearer: tokenB }))).status).toBe(401);
    env.advance(-15 * 60 * 1000);
    const tampered = tokenB.slice(0, -3) + (tokenB.endsWith("abc") ? "xyz" : "abc");
    expect((await routes.profiles.GET(req("GET", "/api/v1/profiles", { bearer: tampered }))).status).toBe(401);
  });
});
