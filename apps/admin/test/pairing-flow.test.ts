import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeviceTokenResponse, PairingCodeResponse } from "@bnl/contracts";
import { setDepsForTesting } from "../src/server/deps";
import { HH_A, OUTSIDER, OWNER_A, bodyOf, makeTestEnv, req, type TestEnv } from "./fakes";
import { revokeDevice, routes } from "./routes";

let env: TestEnv;
beforeEach(() => {
  env = makeTestEnv();
  setDepsForTesting(env.deps);
});
afterEach(() => setDepsForTesting(null));

async function newCode() {
  const res = await routes.pairingCode.POST(req("POST", "/api/v1/devices/pairing-code", { csrf: false }));
  expect(res.status).toBe(201);
  return PairingCodeResponse.parse(await res.json());
}
const poll = (pairing_id: string, poll_secret: string) =>
  routes.token.POST(req("POST", "/api/v1/devices/token", { csrf: false, body: { pairing_id, poll_secret } }));
const approve = (session: string, code: string, device_label = "Living room TV") =>
  routes.pair.POST(req("POST", "/api/v1/devices/pair", { session, body: { code, device_label } }));
const refreshWith = (refresh_token: string) =>
  routes.refresh.POST(req("POST", "/api/v1/devices/token/refresh", { csrf: false, body: { refresh_token } }));

describe("pairing end-to-end through handlers", () => {
  it("code → approve → 202 → 200 once → 410 → refresh rotates → old refresh reuse revokes", async () => {
    const owner = env.auth.sessionFor(OWNER_A);
    const code = await newCode();
    expect(code.expires_at).toBe("2026-11-14T10:10:00.000Z");
    // Only hashes are stored.
    expect(JSON.stringify(env.store.pairing)).not.toContain(code.code);
    expect(JSON.stringify(env.store.pairing)).not.toContain(code.poll_secret);

    const pending = await poll(code.pairing_id, code.poll_secret);
    expect(pending.status).toBe(202);
    expect(pending.headers.get("cache-control")).toBe("no-store");

    // Guardian may type lower case / with a hyphen.
    const typed = `${code.code.slice(0, 4).toLowerCase()}-${code.code.slice(4)}`;
    const approved = await approve(owner, typed);
    expect(approved.status).toBe(200);
    const { device_id } = (await approved.json()) as { device_id: string };
    expect(env.store.devices[0]).toMatchObject({ id: device_id, householdId: HH_A, tokenVersion: 1, label: "Living room TV" });
    expect(env.store.audit.map((a) => a.action)).toContain("device.pair_approved");

    const issued = await poll(code.pairing_id, code.poll_secret);
    expect(issued.status).toBe(200);
    const cred = DeviceTokenResponse.parse(await issued.json());
    expect(cred).toMatchObject({ device_id, household_id: HH_A, access_expires_at: "2026-11-14T10:15:00.000Z" });

    const again = await poll(code.pairing_id, code.poll_secret);
    expect(again.status).toBe(410);

    // The access token works for device endpoints.
    expect((await routes.profiles.GET(req("GET", "/api/v1/profiles", { bearer: cred.access_token }))).status).toBe(200);

    const rotated = await refreshWith(cred.refresh_token);
    expect(rotated.status).toBe(200);
    const cred2 = DeviceTokenResponse.parse(await rotated.json());
    expect(cred2.refresh_token).not.toBe(cred.refresh_token);
    expect(env.store.devices[0]!.refreshTokenHash).not.toBeNull();

    // Replaying the superseded refresh token = theft signal: device revoked, both tokens dead.
    const reuse = await refreshWith(cred.refresh_token);
    expect(reuse.status).toBe(401);
    expect(env.store.devices[0]!.revokedAt).not.toBeNull();
    expect(env.store.devices[0]!.tokenVersion).toBe(2);
    expect(env.store.audit.map((a) => a.action)).toContain("device.refresh_reuse_revoked");
    expect((await refreshWith(cred2.refresh_token)).status).toBe(401);
    expect((await routes.profiles.GET(req("GET", "/api/v1/profiles", { bearer: cred2.access_token }))).status).toBe(401);
  });

  it("uses the privileged job context only for code creation and redemption", async () => {
    const owner = env.auth.sessionFor(OWNER_A);
    const code = await newCode();
    const afterCreate = env.contexts.length;
    expect(env.contexts.map((c) => c.kind)).toEqual(["job"]);
    await approve(owner, code.code);
    expect(env.contexts.slice(afterCreate).map((c) => c.kind)).toEqual(["adult"]);
    const before = env.contexts.length;
    const cred = DeviceTokenResponse.parse(await (await poll(code.pairing_id, code.poll_secret)).json());
    expect(env.contexts.slice(before).map((c) => c.kind)).toEqual(["job"]);
    const beforeRefresh = env.contexts.length;
    await refreshWith(cred.refresh_token);
    expect(env.contexts.slice(beforeRefresh)).toEqual([{ kind: "device", householdId: HH_A, deviceId: cred.device_id }]);
  });

  it("revoke makes the very next device request 401 and blocks refresh", async () => {
    const owner = env.auth.sessionFor(OWNER_A);
    const code = await newCode();
    await approve(owner, code.code);
    const cred = DeviceTokenResponse.parse(await (await poll(code.pairing_id, code.poll_secret)).json());
    expect((await routes.profiles.GET(req("GET", "/api/v1/profiles", { bearer: cred.access_token }))).status).toBe(200);

    const listed = await routes.devices.GET(req("GET", "/api/v1/devices", { session: owner }));
    const { devices } = (await listed.json()) as { devices: { id: string; revoked_at: string | null }[] };
    expect(devices).toHaveLength(1);
    expect(devices[0]!.revoked_at).toBeNull();

    const r = await revokeDevice(req("POST", `/api/v1/devices/${cred.device_id}/revoke`, { session: owner }), cred.device_id);
    expect(r.status).toBe(200);
    expect(env.store.audit.map((a) => a.action)).toContain("device.revoked");

    const after = await routes.profiles.GET(req("GET", "/api/v1/profiles", { bearer: cred.access_token }));
    expect(after.status).toBe(401);
    expect((await bodyOf(after)).error).toMatchObject({ code: "unauthorized" });
    expect((await refreshWith(cred.refresh_token)).status).toBe(401);
  });

  it("another household cannot revoke the device (403, no change)", async () => {
    const owner = env.auth.sessionFor(OWNER_A);
    const code = await newCode();
    const { device_id } = (await (await approve(owner, code.code)).json()) as { device_id: string };
    const ownerB = env.auth.sessionFor({ userId: "44444444-4444-4444-8444-444444444444", email: "owner-b@bnl.test" });
    const r = await revokeDevice(req("POST", `/api/v1/devices/${device_id}/revoke`, { session: ownerB }), device_id);
    expect(r.status).toBe(403);
    expect(env.store.devices[0]!.revokedAt).toBeNull();
  });

  it("codes are one-time and expire after 10 minutes", async () => {
    const owner = env.auth.sessionFor(OWNER_A);
    const code = await newCode();
    expect((await approve(owner, code.code)).status).toBe(200);
    expect((await approve(owner, code.code)).status).toBe(404); // already approved

    const late = await newCode();
    env.advance(600_000);
    expect((await approve(owner, late.code)).status).toBe(404);
    expect((await poll(late.pairing_id, late.poll_secret)).status).toBe(410);
    expect(env.store.devices).toHaveLength(1);
  });

  it("wrong poll secrets are counted and lock the pairing after 5 failures", async () => {
    const owner = env.auth.sessionFor(OWNER_A);
    const code = await newCode();
    const wrong = "x".repeat(43);
    for (let i = 0; i < 4; i++) expect((await poll(code.pairing_id, wrong)).status).toBe(401);
    expect((await poll(code.pairing_id, wrong)).status).toBe(410);
    expect(env.store.pairing[0]!.failedAttempts).toBe(5);
    // Locked even for the right secret and for approval.
    expect((await poll(code.pairing_id, code.poll_secret)).status).toBe(410);
    expect((await approve(owner, code.code)).status).toBe(404);
  });

  it("unknown pairing ids are 410 and forged refresh tokens are 401 without side effects", async () => {
    expect((await poll("c0000000-0000-4000-8000-000000000999", "y".repeat(43))).status).toBe(410);
    expect((await refreshWith("z".repeat(64))).status).toBe(401);
  });

  it("an adult with no household cannot approve (403) and nothing is created", async () => {
    const code = await newCode();
    const res = await approve(env.auth.sessionFor(OUTSIDER), code.code);
    expect(res.status).toBe(403);
    expect(env.store.devices).toHaveLength(0);
    expect(env.store.pairing[0]!.approvedAt).toBeNull();
  });

  it("validates the approval body", async () => {
    const owner = env.auth.sessionFor(OWNER_A);
    expect((await approve(owner, "ABCDEFG0")).status).toBe(422);
    expect((await approve(owner, "ABCDEFGH", "")).status).toBe(422);
    expect((await approve(owner, "ABCDEFGH", "x".repeat(41))).status).toBe(422);
    const res = await routes.pair.POST(req("POST", "/api/v1/devices/pair", { session: owner, rawBody: "{", contentType: "application/json" }));
    expect(res.status).toBe(400);
    const res2 = await routes.pair.POST(req("POST", "/api/v1/devices/pair", { session: owner, rawBody: "code=x", contentType: "application/x-www-form-urlencoded" }));
    expect(res2.status).toBe(415);
  });
});
