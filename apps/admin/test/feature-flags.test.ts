/** A9-OPS-01: pairing, catalog API and learning scores stay off (503 feature_disabled) until their flag is exactly "true". */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@bnl/contracts";
import * as pairingCode from "../src/app/api/v1/devices/pairing-code/route";
import * as token from "../src/app/api/v1/devices/token/route";
import * as manifest from "../src/app/api/v1/catalog/manifest/route";
import * as summary from "../src/app/api/v1/admin/analytics/summary/route";
import { featureEnabled } from "../src/server/flags";
import { setDepsForTesting } from "../src/server/deps";
import { OWNER_A, makeTestEnv, req, type TestEnv } from "./fakes";

let env: TestEnv;
beforeEach(() => {
  env = makeTestEnv();
  setDepsForTesting(env.deps);
});
afterEach(() => {
  vi.unstubAllEnvs();
  setDepsForTesting(null);
});

async function expectDisabled(res: Response) {
  expect(res.status).toBe(503);
  expect(ApiError.parse(await res.json()).error.code).toBe("feature_disabled");
}

describe("rollout flags", () => {
  it("only the exact string 'true' turns a flag on", () => {
    expect(featureEnabled("FEATURE_PAIRING", {})).toBe(false);
    expect(featureEnabled("FEATURE_PAIRING", { FEATURE_PAIRING: "TRUE" })).toBe(false);
    expect(featureEnabled("FEATURE_PAIRING", { FEATURE_PAIRING: "true" })).toBe(true);
  });

  it("FEATURE_PAIRING off: pairing code and token redemption are 503 and create nothing", async () => {
    vi.stubEnv("FEATURE_PAIRING", "");
    await expectDisabled(await pairingCode.POST(req("POST", "/api/v1/devices/pairing-code", { body: {} })));
    await expectDisabled(await token.POST(req("POST", "/api/v1/devices/token", { body: {} })));
    expect(env.contexts).toHaveLength(0);
  });

  it("FEATURE_CATALOG_API off: the manifest is 503 (the TV keeps its built-in tables)", async () => {
    vi.stubEnv("FEATURE_CATALOG_API", "");
    await expectDisabled(await manifest.GET(req("GET", "/api/v1/catalog/manifest?grade=2")));
  });

  it("FEATURE_SCORES off: analytics is 401 unauthenticated (SEC-001) and 503 for a signed-in adult", async () => {
    vi.stubEnv("FEATURE_SCORES", "");
    expect((await summary.GET(req("GET", "/api/v1/admin/analytics/summary"))).status).toBe(401);
    await expectDisabled(await summary.GET(req("GET", "/api/v1/admin/analytics/summary", { session: env.auth.sessionFor(OWNER_A) })));
  });
});
