/**
 * Legacy migration on the device (MIG-002/003/004, F1): the first launch backs up every legacy key
 * verbatim, launching again changes nothing, hidden legacy profiles are never dropped, and the
 * historical ×3 keys are never modified.
 */
import { readFileSync } from "node:fs";
import { act, BACKUP, dumpStorage, expect, readJson, seedOnce, STORE, test } from "../fixtures/student/server";

test.use({ serviceWorkers: "block" });

const fixture = JSON.parse(readFileSync("tests/fixtures/legacy/profiles-v1-two-children.json", "utf8"));
const historical = JSON.parse(readFileSync("tests/fixtures/legacy/historical-x3-keys.json", "utf8"));
const hiddenProfile = { id: "child-9", name: "Old explorer", grade: 3, avatar: "🐼", lessons: { "times-2:puppy": { slideId: "step-2" } } };
const root = { ...fixture[STORE], profiles: [...fixture[STORE].profiles, hiddenProfile] };
const SEED = {
  [STORE]: JSON.stringify(root),
  "breaknlearn.progress.v1": JSON.stringify(historical["breaknlearn.progress.v1"]),
  "learnbreak-x3-v4-progress": "{corrupt",
};

test("launching twice is idempotent and the backup stays intact", async ({ page, student }) => {
  await seedOnce(page, SEED);
  await page.goto(student.base + "/");
  await expect(page.locator(".profile strong")).toHaveText(["Asha", "Ravi"]);
  const first = await dumpStorage(page);
  const backup = JSON.parse(first[BACKUP]!);
  expect(backup.version).toBe(1);
  expect(backup.items).toEqual(SEED); // verbatim, corrupt value included
  expect(first[STORE]).toBe(SEED[STORE]); // reading never rewrites

  await page.reload();
  await expect(page.locator(".profile strong")).toHaveText(["Asha", "Ravi"]);
  await page.reload();
  expect(await dumpStorage(page)).toEqual(first);
});

test("resume state is read exactly like the live app and a write never drops hidden profiles (F1)", async ({ page, student }) => {
  await seedOnce(page, SEED);
  await page.goto(student.base + "/");
  await act(page, "profile:0").click();
  await act(page, "subject:Math").click();
  await act(page, "multiplication").click();
  await expect(page.locator('[data-act="table:1"] .sub')).toHaveText("1 of 6 worlds complete");
  await act(page, "table:3").click();
  await expect(page.locator(".resume h3")).toHaveText("🍬 Candy Land · ×3");
  await expect(page.locator(".resume p")).toHaveText("Slide 4 of 10");
  await expect(page.locator('[data-act="world:farm"] .sub')).toHaveText("↻ Resume at 3 × 6"); // bare key = ×3 only
  await act(page, "back").click();
  await act(page, "table:4").click();
  await expect(page.locator('[data-act="world:farm"] .sub')).toHaveText("10 visual slides");
  await act(page, "world:school").click(); // writes progress

  const store = await readJson(page, STORE);
  expect(store.activeId).toBe("child-1");
  expect(store.profiles.map((p: { id: string }) => p.id)).toEqual(["child-1", "child-2", "child-9"]);
  expect(store.profiles[2]).toEqual(hiddenProfile);
  expect(store.profiles[0].lessons.farm.slideId).toBe("three-6");
  expect(store.profiles[0].lessons["times-4:school"]).toMatchObject({ slideId: "step-1", complete: false });
  const all = await dumpStorage(page);
  expect(all["breaknlearn.progress.v1"]).toBe(SEED["breaknlearn.progress.v1"]);
  expect(all["learnbreak-x3-v4-progress"]).toBe("{corrupt");
  expect(JSON.parse(all[BACKUP]!).items[STORE]).toBe(SEED[STORE]);
  await page.reload();
  await expect(page.locator(".profile strong")).toHaveText(["Asha", "Ravi"]);
});
