/**
 * TV-004: autoplay-blocked music never hides or stalls the lesson (both a rejected play() promise and a
 * synchronous throw, as older webOS builds do), and the per-explorer mute preference survives a relaunch and
 * stops play() from being called at all. Headless Chromium only; real LG audio is TV-006 (LG_TV_TEST_PLAN.md).
 */
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { act, control, expect, readJson, seedOnce, STORE, test } from "../fixtures/student/server";

test.use({ serviceWorkers: "block" });
const fixture = JSON.parse(readFileSync("tests/fixtures/legacy/profiles-v1-two-children.json", "utf8"));

async function blockAudio(page: Page, mode: "reject" | "throw") {
  await page.addInitScript((m) => {
    (window as unknown as { __plays: number }).__plays = 0;
    HTMLMediaElement.prototype.play = function () {
      (window as unknown as { __plays: number }).__plays++;
      if (m === "throw") throw new DOMException("blocked", "NotAllowedError");
      return Promise.reject(new DOMException("blocked", "NotAllowedError"));
    };
  }, mode);
}
const plays = (page: Page) => page.evaluate(() => (window as unknown as { __plays: number }).__plays);

async function openLesson(page: Page, base: string) {
  await page.goto(base + "/");
  await act(page, "profile:0").click();
  await act(page, "subject:Math").click();
  await act(page, "multiplication").click();
  await act(page, "table:2").click();
  await act(page, "world:puppy").click();
}

for (const mode of ["reject", "throw"] as const) {
  test(`blocked music (${mode}) leaves the lesson visible and autoplaying (TV-004)`, async ({ page, student }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await blockAudio(page, mode);
    await seedOnce(page, { [STORE]: JSON.stringify(fixture[STORE]) });
    await page.clock.install();
    await openLesson(page, student.base);
    await expect(page.locator(".formula")).toHaveText("2 × 1 = 2");
    expect(await plays(page)).toBeGreaterThan(0); // music was attempted and refused
    await page.clock.runFor(7_200);
    await expect(page.locator(".formula")).toHaveText("2 × 2 = 4"); // still auto-advancing
    // The remote can still toggle music without breaking anything.
    await control(page, "music");
    await expect(act(page, "music")).toHaveText("♪ Music Off");
    expect(errors).toEqual([]);
  });
}

test("mute preference persists across relaunch and suppresses play() (TV-004)", async ({ page, student }) => {
  await blockAudio(page, "reject");
  await seedOnce(page, { [STORE]: JSON.stringify(fixture[STORE]) });
  await page.clock.install();
  await openLesson(page, student.base);
  await control(page, "music");
  await expect(act(page, "music")).toHaveText("♪ Music Off");
  const store = await readJson(page, STORE);
  expect(store.profiles[0].musicEnabled).toBe(false);

  await page.reload();
  const before = await plays(page);
  await openLesson(page, student.base);
  await page.clock.runFor(7_200);
  expect(await plays(page)).toBe(before); // muted explorer: no play() attempts after relaunch
  await page.keyboard.press("ArrowUp");
  await expect(act(page, "music")).toHaveText("♪ Music Off");
});
