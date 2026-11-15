/**
 * Offline playback (MIG-005, F6). (1) Every network request except the bundle itself is aborted:
 * the app behaves exactly as offline-first. (2) With the service worker, the TV relaunches with no
 * network at all from the last good bundle. (3) The `?sw=off` kill switch removes worker and caches.
 */
import type { Page } from "@playwright/test";
import { act, createProfile, expect, readJson, STORE, test } from "../fixtures/student/server";

async function playOneLessonAndQuiz(page: Page) {
  await act(page, "subject:Math").click();
  await act(page, "multiplication").click();
  await act(page, "table:6").click();
  await act(page, "world:treat").click();
  await expect(page.locator(".formula")).toHaveText("6 × 1 = 6");
  for (let n = 2; n <= 10; n++) {
    await page.clock.runFor(7_100);
    await expect(page.locator(".formula")).toHaveText(`6 × ${n} = ${6 * n}`);
  }
  await page.clock.runFor(7_100);
  for (let q = 1; q <= 3; q++) {
    await expect(page.locator(".crumb")).toContainText(`Quiz ${q} / 3`);
    await page.locator(".quiz-answers button").first().click();
    await act(page, "nextq").click();
  }
  await expect(page.getByText("You did it, Asha!")).toBeVisible();
  expect((await readJson(page, STORE)).profiles[0].lessons["times-6:treat"]).toMatchObject({ complete: true, slideId: "step-10" });
}

test.describe("no network beyond the static bundle", () => {
  test.use({ serviceWorkers: "block" });
  test("all API/network requests aborted: lesson, quiz and progress work", async ({ page, student }) => {
    const aborted: string[] = [];
    await page.route("**/*", (route) => {
      const u = new URL(route.request().url());
      if (u.origin === student.base && /^\/(|index\.html|app\.js|logo\.webp|music\.wav)$/.test(u.pathname)) return route.continue();
      aborted.push(u.pathname);
      return route.abort("internetdisconnected");
    });
    await page.clock.install();
    await page.goto(student.base + "/");
    await createProfile(page, 0, "Asha", 2, 0);
    await expect(page.locator('[data-act="family"]')).toHaveCount(0); // paired mode stays off
    await playOneLessonAndQuiz(page);
    expect(aborted).toContain("/api/v1/student/config");
  });
});

test.describe("service worker", () => {
  test("relaunch with no network serves the last good bundle", async ({ context, page, student }) => {
    await page.goto(student.base + "/");
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r));
    });
    const cached = await page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith("bnl-student-")));
    expect(cached).toHaveLength(1);
    await createProfile(page, 0, "Asha", 2, 0);
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByText("Choose your explorer!")).toBeVisible();
    await expect(page.locator(".profile strong")).toHaveText(["Asha", "Add Explorer 2"]);
    await expect(page.locator("img.brand")).toHaveJSProperty("complete", true);
    expect(await page.locator("img.brand").evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(110);
    await act(page, "profile:0").click();
    await act(page, "subject:Math").click();
    await act(page, "multiplication").click();
    await act(page, "table:2").click();
    await act(page, "world:farm").click();
    await expect(page.locator(".formula")).toHaveText("2 × 1 = 2");
    await context.setOffline(false);
  });

  test("?sw=off kill switch unregisters the worker and deletes its caches", async ({ page, student }) => {
    await page.goto(student.base + "/");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.goto(student.base + "/?sw=off");
    await expect(page.getByText("Choose your explorer!")).toBeVisible();
    await expect
      .poll(() => page.evaluate(async () => ({ regs: (await navigator.serviceWorker.getRegistrations()).length, caches: (await caches.keys()).filter((k) => k.startsWith("bnl-student-")).length })))
      .toEqual({ regs: 0, caches: 0 });
  });

  test("the worker never intercepts /api or /admin", async ({ page, student }) => {
    await page.goto(student.base + "/");
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r));
    });
    const viaSw: string[] = [];
    page.on("response", (r) => {
      if (r.fromServiceWorker()) viaSw.push(new URL(r.url()).pathname);
    });
    await page.evaluate(async () => {
      await fetch("/api/v1/health");
      await fetch("/admin");
      await fetch("/logo.webp");
    });
    expect(viaSw).toEqual(["/logo.webp"]);
  });
});
