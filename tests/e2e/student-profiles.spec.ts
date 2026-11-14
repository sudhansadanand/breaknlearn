/** MIG-001: two profiles on one device keep independent names, grades, avatars, progress and music. */
import { act, createProfile, expect, readJson, STORE, test } from "../fixtures/student/server";

test.use({ serviceWorkers: "block" });

test("two explorers are independent and survive relaunch", async ({ page, student }) => {
  await page.clock.install();
  await page.goto(student.base + "/");
  await createProfile(page, 0, "Asha", 2, 0);
  await act(page, "subject:Math").click();
  await act(page, "multiplication").click();
  await act(page, "table:3").click();
  await act(page, "world:candy").click();
  await page.clock.runFor(7_200 * 3);
  await expect(page.locator(".formula")).toHaveText("3 × 4 = 12");
  await page.keyboard.press("ArrowUp");
  await act(page, "music").click(); // Asha turns music off
  await page.keyboard.press("Escape");
  await act(page, "back").click();
  await expect(page.locator('[data-act="table:3"] .sub')).toHaveText("0 of 6 worlds complete");

  await act(page, "back").click();
  await act(page, "back").click();
  await act(page, "profiles").click();
  await createProfile(page, 1, "Ravi", 2, 9);
  await act(page, "subject:Math").click();
  await act(page, "multiplication").click();
  await act(page, "table:3").click();
  await expect(page.locator(".resume")).toHaveCount(0); // Asha's resume point is not Ravi's
  await expect(page.locator('[data-act="world:candy"] .sub')).toHaveText("10 visual slides");
  await act(page, "world:farm").click();
  await expect(page.locator(".crumb")).toHaveText("Ravi · ×3 · Animal Farm · Slide 1 / 10");
  await page.keyboard.press("ArrowUp");
  await expect(act(page, "music")).toHaveText("♫ Music On");

  await page.reload();
  await expect(page.locator(".profile strong")).toHaveText(["Asha", "Ravi"]);
  await expect(page.locator(".profile .face")).toHaveText(["🦊", "🧑‍🚀"]);
  const store = await readJson(page, STORE);
  expect(Object.keys(store.profiles[0].lessons)).toEqual(["times-3:candy"]);
  expect(store.profiles[0].lessons["times-3:candy"].slideId).toBe("step-4");
  expect(store.profiles[0].musicEnabled).toBe(false);
  expect(Object.keys(store.profiles[1].lessons)).toEqual(["times-3:farm"]);
  expect(store.profiles[1].musicEnabled).toBe(true);
  await act(page, "profile:0").click();
  await act(page, "subject:Math").click();
  await act(page, "multiplication").click();
  await act(page, "table:3").click();
  await expect(page.locator(".resume h3")).toHaveText("🍬 Candy Land · ×3");
  await expect(page.locator(".resume p")).toHaveText("Slide 4 of 10");
});
