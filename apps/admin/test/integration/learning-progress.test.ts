/** M09 progress sync/read: merge by server revision, MIG-006, SEC-003/004, idempotent replay (real DB). */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ApiError, MULTIPLICATION_LESSON_IDS, ProgressState, ProgressSyncResponse } from "@bnl/contracts";
import { z } from "zod";
import { deviceRequest } from "../learning/builders";
import { freshHousehold, openDbEnv, revoke, type DbEnv, type Household } from "../learning/db-env";
import { learningRoutes } from "../learning/routes";

const LESSON_7 = MULTIPLICATION_LESSON_IDS[7]!;
const ListResponse = z.object({ items: z.array(ProgressState), next_cursor: z.string().nullable() });
let env: DbEnv;
let hh: Household;
let other: Household;
let attempt: string;

beforeAll(() => {
  env = openDbEnv();
});
afterAll(() => env.close());
beforeEach(async () => {
  hh = await freshHousehold(env);
  other = await freshHousehold(env);
  attempt = randomUUID();
});

const body = (o: Partial<{ learner_id: string; slide: number; pos: number; completed: boolean; rev: number; base: number | null; attempt: string; lesson: string; version: string }> = {}) => ({
  learner_id: o.learner_id ?? hh.learners[0],
  lesson_id: o.lesson ?? LESSON_7,
  ...(o.version ? { lesson_version_id: o.version } : {}),
  theme_key: "farm",
  attempt_id: o.attempt ?? attempt,
  client_revision: o.rev ?? 1,
  base_server_revision: o.base === undefined ? null : o.base,
  slide_id: `step-${o.slide ?? 1}`,
  position_seconds: o.pos ?? 0,
  completed: o.completed ?? false,
  client_updated_at: new Date().toISOString(),
});
const sync = async (b: unknown, o: { bearer?: string; key?: string } = {}) => {
  const res = await learningRoutes.progressSync.POST(deviceRequest("POST", "/api/v1/progress/sync", { bearer: o.bearer ?? hh.token, body: b, ...(o.key ? { idempotencyKey: o.key } : {}) }));
  return { status: res.status, json: (await res.json()) as unknown, res };
};
const row = async () => (await env.admin`select slide_id, completed, server_revision::int as rev from bnl.learner_progress where learner_id = ${hh.learners[0]} and attempt_id = ${attempt}`)[0];

describe("progress sync (real DB)", () => {
  it("applies, advances on the current base, merges an old-base write to the furthest point", async () => {
    const first = await sync(body({ slide: 3 }));
    expect(first.status).toBe(200);
    expect(ProgressSyncResponse.parse(first.json)).toMatchObject({ outcome: "applied", state: { server_revision: 1, slide_id: "step-3", completed: false } });
    const second = ProgressSyncResponse.parse((await sync(body({ slide: 5, rev: 2, base: 1 }))).json);
    expect(second).toMatchObject({ outcome: "applied", state: { server_revision: 2, slide_id: "step-5" } });
    // Another device on an old base, further ahead.
    const merged = ProgressSyncResponse.parse((await sync(body({ slide: 8, rev: 1, base: 1 }))).json);
    expect(merged).toMatchObject({ outcome: "merged", state: { server_revision: 3, slide_id: "step-8" } });
  });

  it("MIG-006: stale client revision → stale_ignored; completion never regresses; future base → 409", async () => {
    await sync(body({ slide: 10, completed: true, rev: 5 }));
    const stale = ProgressSyncResponse.parse((await sync(body({ slide: 2, rev: 3, base: 1 }))).json);
    expect(stale).toMatchObject({ outcome: "stale_ignored", state: { completed: true, slide_id: "step-10", server_revision: 1 } });
    const newerButBehind = ProgressSyncResponse.parse((await sync(body({ slide: 2, rev: 9, base: 1, completed: false }))).json);
    expect(newerButBehind.state.completed).toBe(true);
    expect(await row()).toMatchObject({ completed: true, slide_id: "step-10" });
    const ahead = await sync(body({ slide: 10, rev: 10, base: 99 }));
    expect(ahead.status).toBe(409);
    expect(ApiError.parse(ahead.json).error.code).toBe("conflict");
    const phantom = await sync(body({ attempt: randomUUID(), base: 4 }));
    expect(phantom.status).toBe(409);
    // A restart is a new attempt, never an overwrite.
    const restart = ProgressSyncResponse.parse((await sync(body({ attempt: randomUUID(), slide: 1 }))).json);
    expect(restart).toMatchObject({ outcome: "applied", state: { completed: false } });
    expect(await row()).toMatchObject({ completed: true });
  });

  it("Idempotency-Key replay returns the same response without a second write", async () => {
    const key = `ps-${randomUUID()}`;
    const same = body({ slide: 4 });
    const a = await sync(same, { key });
    const b = await sync(JSON.parse(JSON.stringify(same)), { key });
    expect(b.status).toBe(200);
    expect(b.res.headers.get("Idempotent-Replayed")).toBe("true");
    expect(b.json).toEqual(a.json);
    expect((await row())?.rev).toBe(1);
    const conflict = await sync(body({ slide: 6 }), { key });
    expect(conflict.status).toBe(409);
    expect(ApiError.parse(conflict.json).error.code).toBe("idempotency_conflict");
  });

  it("SEC-003: another household's learner → 403 even with a valid UUID; nothing written", async () => {
    const res = await sync(body({ learner_id: other.learners[0] }));
    expect(res.status).toBe(403);
    expect(await env.admin`select 1 from bnl.learner_progress where learner_id = ${other.learners[0]}`).toHaveLength(0);
    const read = await learningRoutes.progress.GET(deviceRequest("GET", `/api/v1/progress?learner_id=${other.learners[0]}`, { bearer: hh.token, idempotencyKey: null }));
    expect(read.status).toBe(403);
  });

  it("SEC-004: revoked device → 401 for sync and read", async () => {
    await revoke(env, hh.deviceId);
    expect((await sync(body())).status).toBe(401);
    expect((await learningRoutes.progress.GET(deviceRequest("GET", `/api/v1/progress?learner_id=${hh.learners[0]}`, { bearer: hh.token, idempotencyKey: null }))).status).toBe(401);
    expect(await row()).toBeUndefined();
  });

  it("unknown or draft lesson / mismatched version → 422", async () => {
    expect((await sync(body({ lesson: randomUUID() }))).status).toBe(422);
    expect((await sync(body({ lesson: "1e000000-0000-4000-8000-000000000001" }))).status).toBe(422);
    expect((await sync(body({ version: randomUUID() }))).status).toBe(422);
    const [v3] = await env.admin`select lesson_version_id from bnl.publication_records where lesson_id = ${MULTIPLICATION_LESSON_IDS[3]!} limit 1`;
    expect((await sync(body({ version: v3!.lesson_version_id as string }))).status).toBe(422);
    const [v7] = await env.admin`select lesson_version_id from bnl.publication_records where lesson_id = ${LESSON_7} limit 1`;
    expect((await sync(body({ version: v7!.lesson_version_id as string }))).status).toBe(200);
  });

  it("GET: device and own-household adult read with pagination; another household's adult gets 403", async () => {
    for (const t of ["puppy", "candy", "farm"] as const) {
      await sync({ ...body(), theme_key: t, attempt_id: randomUUID() });
    }
    const page1 = ListResponse.parse(await (await learningRoutes.progress.GET(deviceRequest("GET", `/api/v1/progress?learner_id=${hh.learners[0]}&limit=2`, { bearer: hh.token, idempotencyKey: null }))).json());
    expect(page1.items).toHaveLength(2);
    expect(page1.next_cursor).not.toBeNull();
    const page2 = ListResponse.parse(await (await learningRoutes.progress.GET(deviceRequest("GET", `/api/v1/progress?learner_id=${hh.learners[0]}&limit=2&cursor=${page1.next_cursor}`, { bearer: hh.token, idempotencyKey: null }))).json());
    expect(page2).toMatchObject({ next_cursor: null });
    expect(new Set([...page1.items, ...page2.items].map((i) => i.theme_key))).toEqual(new Set(["puppy", "candy", "farm"]));

    const owner = env.auth.sessionFor({ userId: hh.ownerUserId, email: "a6-owner@bnl.test" });
    const adult = ListResponse.parse(await (await learningRoutes.progress.GET(deviceRequest("GET", `/api/v1/progress?learner_id=${hh.learners[0]}`, { session: owner, idempotencyKey: null }))).json());
    expect(adult.items).toHaveLength(3);
    const outsider = env.auth.sessionFor({ userId: other.ownerUserId, email: "a6-other@bnl.test" });
    expect((await learningRoutes.progress.GET(deviceRequest("GET", `/api/v1/progress?learner_id=${hh.learners[0]}`, { session: outsider, idempotencyKey: null }))).status).toBe(403);
    expect((await learningRoutes.progress.GET(deviceRequest("GET", `/api/v1/progress?learner_id=${hh.learners[0]}`, { idempotencyKey: null }))).status).toBe(401);
  });
});
