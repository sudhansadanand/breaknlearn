/**
 * SEC-001: unauthenticated /admin and /api/v1/admin/* give 401/redirect without leaking data.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ApiError } from "@bnl/contracts";
import { setDepsForTesting } from "../src/server/deps";
import { middleware } from "../src/middleware";
import { OUTSIDER, OWNER_A, makeTestEnv, req, type TestEnv } from "./fakes";
import { params, routes } from "./routes";

const appDir = fileURLToPath(new URL("../src/app", import.meta.url));
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));

let env: TestEnv;
beforeEach(() => {
  env = makeTestEnv();
  setDepsForTesting(env.deps);
});
afterEach(() => setDepsForTesting(null));

type AnyHandler = (r: Request, ctx: ReturnType<typeof params>) => Promise<Response>;

/** Every route handler that requires an adult session (no bearer). */
const ADULT_ROUTES: [string, string, AnyHandler][] = [
  ["GET", "/api/v1/admin/me", routes.me.GET],
  ["POST", "/api/v1/admin/consent", routes.consent.POST],
  ...(["GET", "POST", "PUT", "PATCH", "DELETE"] as const).map(
    (m) => [m, "/api/v1/admin/lessons", routes.adminCatchAll[m]] as [string, string, AnyHandler],
  ),
  ["GET", "/api/v1/devices", routes.devices.GET],
  ["POST", "/api/v1/devices/pair", routes.pair.POST],
  ["POST", "/api/v1/devices/d0000000-0000-4000-8000-000000000001/revoke", routes.revoke.POST as AnyHandler],
  ["GET", "/api/v1/profiles", routes.profiles.GET],
  ["POST", "/api/v1/profiles", routes.profiles.POST],
];

async function expect401(res: Response) {
  expect(res.status).toBe(401);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = ApiError.parse(await res.json());
  expect(body.error.code).toBe("unauthorized");
  expect(res.headers.get("x-request-id")).toBe(body.error.request_id);
  expect(Object.keys(body)).toEqual(["error"]);
}

describe("SEC-001 API", () => {
  /** Every route file under /api/v1/admin, discovered from disk, so new routes are covered automatically. */
  const adminRouteFiles = walk(join(appDir, "api/v1/admin"))
    .filter((f) => f.endsWith("route.ts"))
    .map((f) => relative(appDir, f))
    .sort();
  const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
  const ANY_PARAMS = {
    rest: ["lessons"], nodeId: "a0000000-0000-4000-8000-000000000001", jobId: "a0000000-0000-4000-8000-000000000002",
    lessonId: "a0000000-0000-4000-8000-000000000003", versionId: "a0000000-0000-4000-8000-000000000004", revision: "1",
  };

  it("discovers the admin route files (sanity: none missing from the scan)", () => {
    expect(adminRouteFiles.length).toBeGreaterThanOrEqual(16);
    expect(adminRouteFiles).toContain("api/v1/admin/me/route.ts");
  });

  it.each(adminRouteFiles)("%s: every exported method without a session → 401 (or 404 for dev-only routes)", async (file) => {
    const mod = (await import(join(appDir, file))) as Partial<Record<(typeof METHODS)[number], AnyHandler>>;
    const exported = METHODS.filter((m) => typeof mod[m] === "function");
    expect(exported.length, file).toBeGreaterThan(0);
    for (const m of exported) {
      const body = m === "GET" ? undefined : {};
      const res = await mod[m]!(req(m, `/${file.replace(/\/route\.ts$/, "")}`, { body, csrf: true }), params(ANY_PARAMS));
      expect([401], `${m} ${file} -> ${res.status}`).toContain(res.status);
      expect(res.headers.get("cache-control"), `${m} ${file}`).toBe("no-store");
    }
    expect(env.store.audit).toHaveLength(0);
  });

  it.each(ADULT_ROUTES)("%s %s without a session → 401", async (method, path, handler) => {
    const body = method === "GET" ? undefined : { code: "ABCDEFGH", device_label: "x" };
    await expect401(await handler(req(method, path, { body, csrf: true }), params({ deviceId: "d0000000-0000-4000-8000-000000000001", rest: ["lessons"] })));
    expect(env.store.audit).toHaveLength(0);
  });

  it.each(ADULT_ROUTES)("%s %s with a forged session → 401", async (method, path, handler) => {
    await expect401(await handler(req(method, path, { session: "forged", csrf: true }), params({ deviceId: "d0000000-0000-4000-8000-000000000001" })));
  });

  it("authenticated adults reach /admin/me; unimplemented admin endpoints are 404, not data", async () => {
    const owner = env.auth.sessionFor(OWNER_A);
    const me = await routes.me.GET(req("GET", "/api/v1/admin/me", { session: owner }));
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ user_id: OWNER_A.userId, email: OWNER_A.email, households: [{ household_id: expect.any(String), role: "owner" }], staff_roles: [] });
    expect((await routes.adminCatchAll.GET(req("GET", "/api/v1/admin/lessons", { session: owner }))).status).toBe(404);
  });

  it("an adult with no household gets 403 on household data, never another household's rows", async () => {
    const outsider = env.auth.sessionFor(OUTSIDER);
    const res = await routes.devices.GET(req("GET", "/api/v1/devices", { session: outsider }));
    expect(res.status).toBe(403);
    expect(Object.keys(ApiError.parse(await res.json()))).toEqual(["error"]);
  });

  it("public endpoints stay public (health, pairing bootstrap)", async () => {
    expect((await routes.health.GET(req("GET", "/api/v1/health"))).status).toBe(200);
    expect((await routes.pairingCode.POST(req("POST", "/api/v1/devices/pairing-code", { csrf: false }))).status).toBe(201);
  });
});

describe("SEC-001 pages", () => {
  const pageFiles = walk(join(appDir, "admin")).filter((f) => f.endsWith("page.tsx")).map((f) => relative(appDir, f));

  it.each(["/admin", "/admin/devices", "/admin/children", "/admin/anything"])("middleware redirects %s to /admin/login without a cookie", (path) => {
    const res = middleware(new NextRequest(`http://localhost:3000${path}`));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/admin/login");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("login page is reachable without a session", () => {
    const res = middleware(new NextRequest("http://localhost:3000/admin/login"));
    expect(res.headers.get("location")).toBeNull();
  });

  it("every portal page and the portal layout verify the session server-side", () => {
    const portal = pageFiles.filter((f) => f.startsWith("admin/(portal)/"));
    expect(portal.length).toBeGreaterThanOrEqual(3);
    for (const f of [...portal, "admin/(portal)/layout.tsx"]) {
      expect(readFileSync(join(appDir, f), "utf8"), f).toMatch(/await requireAdultPage\(\)/);
    }
    // The only admin page outside the gated group is the login page.
    expect(pageFiles.filter((f) => !f.startsWith("admin/(portal)/"))).toEqual(["admin/login/page.tsx"]);
  });

  it("requireAdultPage redirects for missing and invalid cookies, and passes a valid one", async () => {
    let cookie: string | undefined;
    vi.doMock("next/headers", () => ({ cookies: async () => ({ get: () => (cookie === undefined ? undefined : { value: cookie }) }) }));
    vi.doMock("next/navigation", () => ({
      redirect: (to: string) => {
        throw new Error(`REDIRECT:${to}`);
      },
    }));
    const { requireAdultPage } = await import("../src/server/page-auth");
    cookie = undefined;
    await expect(requireAdultPage()).rejects.toThrow("REDIRECT:/admin/login");
    cookie = "forged";
    await expect(requireAdultPage()).rejects.toThrow("REDIRECT:/admin/login");
    cookie = env.auth.sessionFor(OWNER_A);
    await expect(requireAdultPage()).resolves.toEqual(OWNER_A);
    vi.doUnmock("next/headers");
    vi.doUnmock("next/navigation");
  });
});
