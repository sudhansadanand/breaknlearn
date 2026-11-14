/**
 * Paired mode against mocked /api/v1 routes: server flag, pairing code screen, linking explorers,
 * one-time legacy import (Idempotency-Key, guardian-assigned historical entries), published catalog
 * (tables and worlds from the manifest), progress sync and telemetry with Idempotency-Key, and
 * offline queueing with no duplicated events once the network returns (MIG-005).
 */
import type { Page, Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { lessonForTable, manifestFixture } from "../fixtures/student/catalog";
import { act, expect, readJson, seedOnce, STORE, test } from "../fixtures/student/server";

test.use({ serviceWorkers: "block" });

const fixture = JSON.parse(readFileSync("tests/fixtures/legacy/profiles-v1-two-children.json", "utf8"));
const historical = JSON.parse(readFileSync("tests/fixtures/legacy/historical-x3-keys.json", "utf8"));
const ASHA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RAVI = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DEVICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TABLES = [1, 2, 3];

interface Seen {
  imports: { body: Record<string, unknown>; key: string | null }[];
  syncs: { body: Record<string, unknown>; key: string | null }[];
  batches: { events: { event_id: string; event_type: string; learner_id: string }[]; key: string | null }[];
  polls: number;
  offline: boolean;
}

async function mockServer(page: Page, opts: { enabled: boolean }): Promise<Seen> {
  const seen: Seen = { imports: [], syncs: [], batches: [], polls: 0, offline: false };
  const json = (route: Route, status: number, body: unknown, headers: Record<string, string> = {}) => route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) });
  await page.route("**/api/v1/**", async (route) => {
    if (seen.offline) return route.abort("internetdisconnected");
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname.replace("/api/v1", "");
    const key = req.headers()["idempotency-key"] ?? null;
    if (p === "/student/config") return json(route, 200, { paired_mode: opts.enabled, telemetry: true, service_worker: true });
    if (p === "/devices/pairing-code") return json(route, 201, { pairing_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", code: "K7MX2PQR", poll_secret: "s".repeat(43), expires_at: new Date(Date.now() + 600_000).toISOString() });
    if (p === "/devices/token") {
      seen.polls++;
      if (seen.polls < 2) return json(route, 202, { status: "pending" }, { "Retry-After": "3" });
      return json(route, 200, { device_id: DEVICE, household_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", access_token: "acc", access_expires_at: new Date(Date.now() + 3_600_000).toISOString(), refresh_token: "r".repeat(40) });
    }
    if (req.headers().authorization !== "Bearer acc" && !p.startsWith("/catalog")) return json(route, 401, { error: { code: "unauthorized", message: "no", request_id: "x" } });
    if (p === "/profiles") return json(route, 200, { profiles: [{ id: ASHA, slot: 1, display_name: "Asha", grade: 2, avatar_id: "fox" }, { id: RAVI, slot: 2, display_name: "Ravi", grade: 6, avatar_id: "astronaut" }] });
    if (p === "/catalog/manifest") return json(route, 200, manifestFixture(TABLES), { ETag: '"rev-1"' });
    const lesson = /^\/catalog\/lessons\/(.+)$/.exec(p);
    if (lesson) {
      const t = manifestFixture(TABLES).subjects[1]!.topics[0]!.lessons.find((l) => l.id === lesson[1])?.sort_order;
      return t ? json(route, 200, lessonForTable(t, t === 2 ? { themes: ["candy"] } : {})) : json(route, 404, {});
    }
    if (p === "/progress/legacy-import") {
      const body = req.postDataJSON();
      seen.imports.push({ body, key });
      return json(route, 200, { migration_run_id: body.migration_run_id, outcome: "imported", per_profile: [], historical: { entries_found: 1, entries_pending_assignment: 0, entries_unrecognized: 0 } });
    }
    if (p === "/progress") return json(route, 200, { items: [], next_cursor: null });
    if (p === "/progress/sync") {
      const body = req.postDataJSON();
      seen.syncs.push({ body, key });
      return json(route, 200, { outcome: "applied", state: { ...body, lesson_version_id: body.lesson_version_id ?? null, server_revision: seen.syncs.length, updated_at: new Date().toISOString() } });
    }
    if (p === "/telemetry/batch") {
      const body = req.postDataJSON();
      seen.batches.push({ events: body.events, key });
      return json(route, 200, { accepted: body.events.map((e: { event_id: string }) => e.event_id), duplicates: [], rejected: [] });
    }
    return json(route, 404, { error: { code: "not_found", message: "Not found", request_id: "x" } });
  });
  return seen;
}

test("server flag off: no Family account entry, behaviour as live", async ({ page, student }) => {
  await mockServer(page, { enabled: false });
  await page.goto(student.base + "/");
  await expect(page.getByText("Choose your explorer!")).toBeVisible();
  await expect(page.locator('[data-act="family"]')).toHaveCount(0);
});

test("pair, link, import, catalog, progress sync, telemetry, offline queue", async ({ page, student }) => {
  test.setTimeout(90_000);
  await seedOnce(page, { [STORE]: JSON.stringify(fixture[STORE]), "breaknlearn.progress.v1": JSON.stringify(historical["breaknlearn.progress.v1"]) });
  const seen = await mockServer(page, { enabled: true });
  await page.clock.install();
  await page.goto(student.base + "/");

  // Pairing screen with the 8-char code; polls until the guardian approves.
  await act(page, "family").click();
  await act(page, "pair-start").click();
  await expect(page.locator("#pairing-code")).toHaveText("K7MX2PQR");
  await page.clock.runFor(3_100);
  await page.clock.runFor(3_100);
  await expect(page.getByRole("heading", { name: "Link explorers" })).toBeVisible();
  await expect(page.getByText("Family account: Asha")).toBeVisible();

  // Guardian links both explorers and explicitly assigns the old ×3 progress to Asha.
  await act(page, "link-toggle:0").click();
  await act(page, "link-toggle:1").click();
  await expect(page.getByText("Older ×3 progress was found on this TV")).toBeVisible();
  await act(page, "hist:0").click();
  await act(page, "link-save").click();
  await expect(page.getByText("This TV is connected ✓")).toBeVisible();
  await expect.poll(() => seen.imports.length).toBe(1);
  const imp = seen.imports[0]!;
  expect(imp.key).toBe(`li-${imp.body.migration_run_id}`);
  expect(imp.body.profile_mapping).toEqual([{ local_profile_id: "child-1", learner_id: ASHA }, { local_profile_id: "child-2", learner_id: RAVI }]);
  expect(imp.body.historical_learner_id).toBe(ASHA);
  expect(imp.body.legacy_fingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect((imp.body.raw as Record<string, unknown>)["breaknlearn.progress.v1"]).toEqual(historical["breaknlearn.progress.v1"]);
  await expect(page.getByText("Saved progress from this TV was added to the family account.")).toBeVisible();

  // Published catalog drives tables and worlds.
  await act(page, "profiles").click();
  await act(page, "profile:0").click();
  await act(page, "subject:Math").click();
  await act(page, "multiplication").click();
  await expect(page.locator(".table-card h3")).toHaveText(["1 Times Table", "2 Times Table", "3 Times Table"]);
  await act(page, "table:2").click();
  await expect(page.locator(".tile h3")).toHaveText(["Candy Land"]);
  await act(page, "back").click();

  // Play: progress sync + telemetry, each with an Idempotency-Key.
  await act(page, "table:1").click();
  await act(page, "world:puppy").click();
  for (let i = 0; i < 4; i++) await page.clock.runFor(7_100);
  await page.clock.runFor(31_000);
  await expect.poll(() => seen.syncs.length).toBeGreaterThan(0);
  await expect.poll(() => seen.batches.length).toBeGreaterThan(0);
  for (const s of seen.syncs) {
    expect(s.key).toMatch(/^ps-[0-9a-f-]{36}-\d+$/);
    expect(s.body).toMatchObject({ learner_id: ASHA, theme_key: "puppy", lesson_id: "02402664-c8e7-5408-ab92-292f6e20a308" });
  }
  for (const b of seen.batches) expect(b.key).toBe(`tb-${b.events[0]!.event_id}-${b.events.length}`);
  expect(seen.batches.flatMap((b) => b.events.map((e) => e.learner_id)).every((l) => l === ASHA)).toBe(true);

  // Network drops: the child keeps learning, events queue durably.
  seen.offline = true;
  const sentBefore = seen.batches.flatMap((b) => b.events).length;
  for (let i = 0; i < 12 && !(await page.getByText("PICTURE QUIZ").isVisible()); i++) await page.clock.runFor(7_100);
  await expect(page.getByText("PICTURE QUIZ")).toBeVisible(); // lesson finished while offline
  await page.locator(".quiz-answers button").first().click();
  await page.clock.runFor(31_000);
  const queued = (await readJson(page, "breaknlearn.telemetry-queue.v1")) as unknown[];
  expect(queued.length).toBeGreaterThan(0);
  await page.reload(); // queue survives a relaunch
  expect(((await readJson(page, "breaknlearn.telemetry-queue.v1")) as unknown[]).length).toBeGreaterThanOrEqual(queued.length); // nothing lost (pagehide may add app_hidden)

  // Network returns: everything is delivered once.
  seen.offline = false;
  await page.clock.runFor(10 * 60_000);
  await expect.poll(async () => ((await readJson(page, "breaknlearn.telemetry-queue.v1")) as unknown[]).length).toBe(0);
  const all = seen.batches.flatMap((b) => b.events.map((e) => e.event_id));
  expect(new Set(all).size).toBe(all.length);
  expect(all.length).toBeGreaterThan(sentBefore);
  const types = seen.batches.flatMap((b) => b.events.map((e) => e.event_type));
  expect(types).toEqual(expect.arrayContaining(["lesson_started", "slide_entered", "lesson_completed", "quiz_started", "answer_submitted"]));
  expect(seen.syncs.some((s) => s.body.completed === true)).toBe(true);
  // Local storage stays in the live shape.
  expect((await readJson(page, STORE)).profiles[0].lessons["times-1:puppy"]).toMatchObject({ complete: true, slideId: "step-10" });
});
