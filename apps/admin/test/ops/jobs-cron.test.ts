import { describe, expect, it } from "vitest";
import { jobsCronHandler, type JobRunners } from "../../src/server/handlers/jobs-cron";
import { handle } from "../../src/server/http";
import { setDepsForTesting } from "../../src/server/deps";
import { makeTestEnv } from "../fakes";

const SECRET = "s".repeat(40);
const NOW = () => new Date("2026-11-15T00:30:00Z");

function recorder(fail: Partial<Record<keyof JobRunners, boolean>> = {}) {
  const calls: string[] = [];
  const mk = (name: keyof JobRunners) => async (_db: unknown, arg: unknown) => {
    calls.push(typeof arg === "string" ? `${name}:${arg}` : name);
    if (fail[name]) throw new Error(`${name} broke`);
    return name === "deletions" ? { failed: 0 } : { ok: true };
  };
  const runners = { aggregate: mk("aggregate"), score: mk("score"), purge: mk("purge"), deletions: mk("deletions") } as unknown as JobRunners;
  return { calls, runners };
}

async function call(url: string, auth: string | null, env: Record<string, string | undefined>, runners: JobRunners) {
  setDepsForTesting(makeTestEnv().deps);
  try {
    const headers: Record<string, string> = auth ? { authorization: auth } : {};
    return await handle((c) => jobsCronHandler(new Request(url, { headers }), c, env, runners, NOW));
  } finally {
    setDepsForTesting(null);
  }
}

const URL_ = "http://localhost/api/v1/internal/jobs/nightly";

describe("GET /api/v1/internal/jobs/nightly (Vercel Cron)", () => {
  it("does not exist without a strong CRON_SECRET", async () => {
    const { calls, runners } = recorder();
    expect((await call(URL_, `Bearer ${"x".repeat(10)}`, { CRON_SECRET: "x".repeat(10) }, runners)).status).toBe(404);
    expect((await call(URL_, "Bearer ", {}, runners)).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("rejects a missing or wrong secret without running anything", async () => {
    const { calls, runners } = recorder();
    expect((await call(URL_, null, { CRON_SECRET: SECRET }, runners)).status).toBe(401);
    expect((await call(URL_, `Bearer ${SECRET}x`, { CRON_SECRET: SECRET }, runners)).status).toBe(401);
    expect((await call(URL_, SECRET, { CRON_SECRET: SECRET }, runners)).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("nightly: aggregate then score yesterday (UTC), then purge and deletion requests", async () => {
    const { calls, runners } = recorder();
    const res = await call(URL_, `Bearer ${SECRET}`, { CRON_SECRET: SECRET }, runners);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ date: "2026-11-14", nightly: true, ok: true });
    expect(calls).toEqual(["aggregate:2026-11-14", "score:2026-11-14", "purge", "deletions"]);
  });

  it("?date= runs only aggregate and score for that day", async () => {
    const { calls, runners } = recorder();
    const res = await call(`${URL_}?date=2026-11-15`, `Bearer ${SECRET}`, { CRON_SECRET: SECRET }, runners);
    expect(res.status).toBe(200);
    expect(calls).toEqual(["aggregate:2026-11-15", "score:2026-11-15"]);
  });

  it("rejects a malformed date", async () => {
    const { calls, runners } = recorder();
    expect((await call(`${URL_}?date=2026-13-99x`, `Bearer ${SECRET}`, { CRON_SECRET: SECRET }, runners)).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("skips scoring when aggregation fails, still runs the other jobs, and answers 500", async () => {
    const { calls, runners } = recorder({ aggregate: true });
    const res = await call(URL_, `Bearer ${SECRET}`, { CRON_SECRET: SECRET }, runners);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, results: { aggregate: { error: "aggregate broke" } } });
    expect(calls).toEqual(["aggregate:2026-11-14", "purge", "deletions"]);
  });
});
