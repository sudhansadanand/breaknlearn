/**
 * Full-stack happy path on ONE origin (ADR-0006): the built admin (`next start`) serves /admin, /api/v1 and the
 * student bundle at `/`, backed by a throwaway Postgres with real roles/RLS. Real handlers, real DB, real jobs.
 *
 * guardian login → create two child profiles → pair a TV (student bundle) → link explorers + legacy import →
 * child plays ×3 (one world, 10 slides) and the quiz → telemetry and progress land in the DB → server-side
 * assessment (start/answers/finish with the TV credential) → nightly jobs (aggregate-sessions, score-learners)
 * → the guardian sees the child's activity and score on /admin/analytics.
 */
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HH_A, ROOT, act, guardianContext, login, runJob, sqlJson } from "./helpers";

test.describe.configure({ mode: "serial" });
test.use({ serviceWorkers: "block" });

const STORE = "breaknlearn.profiles.v1";
const legacy = JSON.parse(readFileSync(resolve(ROOT, "tests/fixtures/legacy/profiles-v1-two-children.json"), "utf8"));
const CHILDREN = [{ slot: 1, name: "Synthetic Asha", grade: "2" }, { slot: 2, name: "Synthetic Ravi", grade: "6" }];
const today = new Date().toISOString().slice(0, 10);

let learnerIds: string[] = [];
let deviceToken = "";

test.beforeAll(() => {
  // Start household A from zero children (SYNTHETIC seed rows only; throwaway database).
  sqlJson(`delete from bnl.learner_profiles where household_id = '${HH_A}'`);
});

test("guardian signs in and creates two child profiles", async ({ page }) => {
  await login(page);
  await page.goto("/admin/children");
  for (const c of CHILDREN) {
    const card = page.locator("section.card", { has: page.getByRole("heading", { name: `Child ${c.slot}` }) });
    await card.getByLabel("Display name").fill(c.name);
    await card.getByLabel("Grade").selectOption(c.grade);
    await card.getByRole("button", { name: "Create profile" }).click();
    await expect(card.getByRole("status")).toHaveText("Saved.");
  }
  const rows = sqlJson<{ id: string; slot: number; display_name: string }[]>(
    `select json_agg(json_build_object('id', id, 'slot', slot, 'display_name', display_name) order by slot) from bnl.learner_profiles where household_id = '${HH_A}'`);
  expect(rows.map((r) => r.display_name)).toEqual(CHILDREN.map((c) => c.name));
  learnerIds = rows.map((r) => r.id);
});

async function openTv(page: Page) {
  await page.addInitScript(([k, v]) => {
    if (!sessionStorage.getItem("seeded")) {
      localStorage.setItem(k as string, v as string);
      sessionStorage.setItem("seeded", "1");
    }
  }, [STORE, JSON.stringify(legacy[STORE])]);
  await page.clock.install();
  await page.goto("/");
  await expect(page.getByText("Choose your explorer!")).toBeVisible();
}

test("a TV pairs through the guardian portal, links explorers and uploads its legacy progress once", async ({ browser }) => {
  const tv = await (await browser.newContext({ serviceWorkers: "block", viewport: { width: 1920, height: 1080 } })).newPage();
  const guardian = await (await guardianContext(browser)).newPage();
  await openTv(tv);
  await act(tv, "family").click();
  await act(tv, "pair-start").click();
  const code = (await tv.locator("#pairing-code").textContent())!.trim();
  expect(code).toMatch(/^[A-Z0-9]{8}$/);

  await guardian.goto("/admin/devices");
  await guardian.getByLabel("Code shown on the TV").fill(code);
  await guardian.getByLabel("Name for this TV").fill("SYNTHETIC E2E TV");
  await guardian.getByRole("button", { name: "Approve TV" }).click();
  await expect(guardian.getByRole("status")).toContainText("Approved");

  for (let i = 0; i < 10 && !(await tv.getByRole("heading", { name: "Link explorers" }).isVisible()); i++) await tv.clock.runFor(3_100);
  await expect(tv.getByRole("heading", { name: "Link explorers" })).toBeVisible();
  await act(tv, "link-toggle:0").click();
  await act(tv, "link-toggle:1").click();
  await act(tv, "link-save").click();
  await expect(tv.getByText("This TV is connected ✓")).toBeVisible();

  const cred = await tv.evaluate(() => JSON.parse(localStorage.getItem("breaknlearn.device.v1") ?? "null"));
  expect(cred.household_id).toBe(HH_A);
  deviceToken = cred.access_token;
  await expect.poll(() => sqlJson<number>(`select count(*) from bnl.migration_runs where household_id = '${HH_A}'`)).toBe(1);
  const aliases = sqlJson<string[]>(`select json_agg(learner_id order by local_profile_id) from bnl.migration_aliases where household_id = '${HH_A}'`);
  expect(aliases).toEqual(learnerIds);
  // The guardian sees the TV in the device list.
  await guardian.goto("/admin/devices");
  await expect(guardian.getByRole("cell", { name: "SYNTHETIC E2E TV", exact: true })).toBeVisible();

  // Child plays ×3 in Puppy Park: ten 7-second slides, then the three-question quiz.
  await act(tv, "profiles").click();
  await act(tv, "profile:0").click();
  await act(tv, "subject:Math").click();
  await act(tv, "multiplication").click();
  await act(tv, "table:3").click();
  await act(tv, "world:puppy").click();
  for (let i = 0; i < 12 && !(await tv.getByText("PICTURE QUIZ").isVisible()); i++) await tv.clock.runFor(7_100);
  await expect(tv.getByText("PICTURE QUIZ")).toBeVisible();
  for (let q = 0; q < 3; q++) {
    await act(tv, "answer:0").click();
    await act(tv, "nextq").click();
  }
  await expect(tv.getByText("WONDERFUL DISCOVERY!")).toBeVisible();
  // Let the queue and outbox flush (they back off on the fake clock).
  await tv.clock.runFor(5 * 60_000);
  await expect.poll(async () => (await tv.evaluate(() => JSON.parse(localStorage.getItem("breaknlearn.telemetry-queue.v1") ?? "[]"))).length, { timeout: 30_000 }).toBe(0);

  const lesson3 = sqlJson<string>(`select to_json(id) from bnl.lessons where stable_key = 'grade2.math.multiplication.table-3'`);
  await expect.poll(() => sqlJson<number>(`select count(*) from bnl.learner_progress where learner_id = '${learnerIds[0]}' and lesson_id = '${lesson3}' and theme_key = 'puppy' and completed`)).toBeGreaterThan(0);
  const types = sqlJson<string[]>(`select json_agg(distinct event_type) from bnl.learning_events where learner_id = '${learnerIds[0]}'`);
  expect(types).toEqual(expect.arrayContaining(["lesson_started", "slide_entered", "lesson_completed", "quiz_started", "answer_submitted"]));
  // Deduplicated: one row per client event id, all scoped to household A and this device.
  const dup = sqlJson<number>(`select count(*) - count(distinct event_id) from bnl.learning_events where household_id = '${HH_A}'`);
  expect(dup).toBe(0);
  expect(sqlJson<number>(`select count(*) from bnl.learning_events where learner_id = '${learnerIds[0]}' and household_id <> '${HH_A}'`)).toBe(0);
  // Learner 2 played nothing: no events invented.
  expect(sqlJson<number>(`select count(*) from bnl.learning_events where learner_id = '${learnerIds[1]}' and event_type = 'lesson_started'`)).toBe(0);
});

test("server-authoritative assessment with the TV credential", async ({ request }) => {
  expect(deviceToken).not.toBe("");
  const lesson3 = sqlJson<string>(`select to_json(id) from bnl.lessons where stable_key = 'grade2.math.multiplication.table-3'`);
  const auth = { authorization: `Bearer ${deviceToken}` };
  const start = await request.post("/api/v1/assessments/start", {
    headers: auth, data: { learner_id: learnerIds[0], lesson_id: lesson3, stage: "immediate", client_attempt_id: crypto.randomUUID() },
  });
  expect(start.status()).toBe(201);
  const s = (await start.json()) as { attempt_id: string; questions: { question_version_key: string }[] };
  expect(JSON.stringify(s)).not.toMatch(/correct/i);
  expect(s.questions.length).toBeGreaterThanOrEqual(3);
  const keys = sqlJson<Record<string, string>>(
    `select json_object_agg(question_version_key, correct_option_id) from bnl.quiz_items where question_version_key in (${s.questions.map((q) => `'${q.question_version_key}'`).join(",")})`);
  for (const q of s.questions) {
    const res = await request.post(`/api/v1/assessments/${s.attempt_id}/answers`, { headers: auth, data: { question_version_key: q.question_version_key, selected_option_id: keys[q.question_version_key] } });
    expect(res.status()).toBe(200);
  }
  const fin = await request.post(`/api/v1/assessments/${s.attempt_id}/finish`, { headers: auth });
  expect(fin.status()).toBe(200);
  const f = (await fin.json()) as Record<string, unknown>;
  expect(JSON.stringify(f)).toContain(String(s.questions.length));
  const [row] = sqlJson<{ total: number; correct: number }[]>(`select json_agg(json_build_object('total', total_questions, 'correct', correct_questions)) from bnl.assessment_attempts where id = '${s.attempt_id}'`);
  expect(row).toEqual({ total: s.questions.length, correct: s.questions.length });
});

test("nightly jobs run against the same DB and are idempotent", () => {
  const agg1 = runJob("aggregate-sessions.mjs", ["--date", today]);
  const agg2 = runJob("aggregate-sessions.mjs", ["--date", today]);
  expect(agg1).toMatchObject({ sessions_considered: 1, events_excluded: 0 });
  // Idempotent rerun: same totals, nothing changed the second time (OPS-004); lag metric emitted.
  expect(agg2.totals).toEqual(agg1.totals);
  expect(agg2.sessions_changed).toBe(0);
  expect(agg1).toHaveProperty("max_ingest_lag_ms");
  const score1 = runJob("score-learners.mjs", ["--as-of", today]);
  runJob("score-learners.mjs", ["--as-of", today]);
  expect(score1).toBeTruthy();
  const snaps = sqlJson<number>(`select count(*) from bnl.mastery_snapshots where learner_id = '${learnerIds[0]}' and score_date = '${today}'`);
  expect(snaps).toBeGreaterThan(0);
  // Re-running the same as-of day replaced, not duplicated (ELS-008 / OPS-004).
  expect(sqlJson<number>(`select count(*) - count(distinct (coalesce(topic_id::text,'') || coalesce(lesson_id::text,'') || weights_version)) from bnl.mastery_snapshots where learner_id = '${learnerIds[0]}' and score_date = '${today}'`)).toBe(0);
  const playback = sqlJson<number>(`select coalesce(sum(playback_ms), 0) from bnl.learning_sessions where learner_id = '${learnerIds[0]}'`);
  expect(playback).toBeGreaterThan(0);
});

test("the guardian sees activity and a score for ×3 on the analytics page; the other child shows no invented data", async ({ browser }) => {
  const page = await (await guardianContext(browser)).newPage();
  await page.goto("/admin/analytics");
  await expect(page.getByRole("heading", { name: "Learning progress", level: 1 })).toBeVisible();
  await expect(page.getByText(/Scores include quiz answers up to/)).toBeVisible();
  const asha = page.locator("section.card", { has: page.getByRole("heading", { name: CHILDREN[0]!.name }) });
  const row3 = asha.getByRole("row", { name: /3 Times Table|×3|Table 3/i });
  await expect(row3).toBeVisible();
  await expect(row3.locator("td.num strong")).toHaveText(/^\d+$/);
  const ravi = page.locator("section.card", { has: page.getByRole("heading", { name: CHILDREN[1]!.name }) });
  await expect(ravi.locator("td.num strong")).toHaveCount(0);
  // Never a child name in the TV-facing or log-facing ids: the page itself is no-store.
  const res = await page.request.get("/admin/analytics");
  expect(res.headers()["cache-control"]).toContain("no-store");
});
