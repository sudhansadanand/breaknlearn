/**
 * TV accessibility (TV-001, TV-002, TV-005; spec §11.11) for the student bundle at 1080p, plus a self-test of the
 * dependency-free checker in tests/a11y/checks.ts (so a green run is not vacuous).
 *   - every visible remote target (`[data-act]`) is at least 64×64 CSS px on every screen;
 *   - arrow keys move a visible focus indicator (≥ 3 px outline) between targets, no mouse needed;
 *   - targets stay inside the 16:9 frame (no clipping, no page scroll at 1080p) and the layout reflows on a phone;
 *   - prefers-reduced-motion disables animations and transitions;
 *   - page language, image alt text and accessible names.
 * Physical LG webOS behaviour is NOT covered here (TV-006, docs/ops/LG_TV_TEST_PLAN.md).
 */
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { staticChecks } from "../a11y/checks";
import { act, control, expect, seedOnce, STORE, test } from "../fixtures/student/server";

test.use({ serviceWorkers: "block" });
const fixture = JSON.parse(readFileSync("tests/fixtures/legacy/profiles-v1-two-children.json", "utf8"));

async function targets(page: Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-act]"))
      .map((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return { act: el.getAttribute("data-act"), w: r.width, h: r.height, x: r.x, y: r.y, right: r.right, bottom: r.bottom, shown: r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0 };
      })
      .filter((t) => t.shown));
}

async function expectTvTargets(page: Page, screen: string) {
  const ts = await targets(page);
  expect(ts.length, `${screen}: no remote targets`).toBeGreaterThan(0);
  for (const t of ts) {
    expect(Math.min(t.w, t.h), `${screen}: ${t.act} is ${Math.round(t.w)}×${Math.round(t.h)}`).toBeGreaterThanOrEqual(64);
    expect(t.x, `${screen}: ${t.act} clipped left`).toBeGreaterThanOrEqual(0);
    expect(t.right, `${screen}: ${t.act} clipped right`).toBeLessThanOrEqual(1920);
  }
  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflowX, `${screen}: horizontal scroll`).toBeLessThanOrEqual(0);
}

async function focusIndicator(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const cs = getComputedStyle(el);
    return { act: el.getAttribute("data-act"), outline: parseFloat(cs.outlineWidth), style: cs.outlineStyle };
  });
}

test("every screen: ≥64 px remote targets inside the frame, no horizontal scroll (TV-005)", async ({ page, student }) => {
  test.setTimeout(60_000);
  await page.clock.install();
  // First launch (no profiles): the empty profile screen and the "Add explorer" editor.
  await page.goto(student.base + "/");
  await expect(page.getByText("Choose your explorer!")).toBeVisible();
  await expectTvTargets(page, "profiles (empty)");
  await act(page, "edit:0").click();
  await expectTvTargets(page, "edit profile");
  // Then the live two-profile fixture.
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [STORE, JSON.stringify(fixture[STORE])] as const);
  await page.goto(student.base + "/");
  await expect(page.getByText("Choose your explorer!")).toBeVisible();
  await expectTvTargets(page, "profiles");
  // Contrast is checked on the admin portal; the TV keeps the live visual design byte-for-byte (parity spec).
  expect((await staticChecks(page, { landmarks: false })).violations.filter((v) => !v.startsWith("contrast"))).toEqual([]);

  await act(page, "profile:0").click();
  await expectTvTargets(page, "subjects");
  await act(page, "subject:Math").click();
  await expectTvTargets(page, "math");
  await act(page, "multiplication").click();
  await expectTvTargets(page, "tables");
  await act(page, "table:3").click();
  await expectTvTargets(page, "worlds");
  await act(page, "world:puppy").click();
  await page.keyboard.press("ArrowUp"); // reveal lesson controls (TV-002)
  await expectTvTargets(page, "lesson controls");
  await act(page, "quiz").click();
  await expectTvTargets(page, "quiz");
  for (let q = 0; q < 3; q++) {
    await act(page, "answer:0").click();
    await act(page, "nextq").click();
  }
  await expect(page.getByText("WONDERFUL DISCOVERY!")).toBeVisible();
  await expectTvTargets(page, "complete");
});

test("arrow keys move a visible focus ring between targets without a mouse (TV-001, TV-005)", async ({ page, student }) => {
  await seedOnce(page, { [STORE]: JSON.stringify(fixture[STORE]) });
  await page.goto(student.base + "/");
  await expect(page.getByText("Choose your explorer!")).toBeVisible();
  const seen = new Set<string>();
  for (const key of ["ArrowRight", "ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"]) {
    await page.keyboard.press(key);
    const f = await focusIndicator(page);
    expect(f, `focus after ${key}`).not.toBeNull();
    expect(f!.act, `focus after ${key} is a remote target`).toBeTruthy();
    expect(f!.style).not.toBe("none");
    expect(f!.outline).toBeGreaterThanOrEqual(3);
    seen.add(f!.act!);
  }
  expect(seen.size).toBeGreaterThan(1);
  // Enter activates the focused target (no mouse).
  await page.keyboard.press("Enter");
  await expect(page.locator("#app")).not.toContainText("Choose your explorer!");
});

test("prefers-reduced-motion turns animations and transitions off (TV-005)", async ({ page, student }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(student.base + "/");
  const moving = await page.evaluate(() =>
    Array.from(document.querySelectorAll("*")).filter((el) => {
      const cs = getComputedStyle(el);
      const anim = cs.animationName !== "none" && parseFloat(cs.animationDuration) > 0.011;
      const trans = cs.transitionDuration.split(",").some((d) => parseFloat(d) > 0.011);
      return anim || trans;
    }).map((el) => el.tagName + "." + (el as HTMLElement).className));
  expect(moving).toEqual([]);
});

test("phone width: the layout reflows without horizontal scrolling (TV-005 mobile responsive)", async ({ page, student }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedOnce(page, { [STORE]: JSON.stringify(fixture[STORE]) });
  await page.goto(student.base + "/");
  await expect(page.getByText("Choose your explorer!")).toBeVisible();
  for (const step of [null, "profile:0", "subject:Math", "multiplication"]) {
    if (step) await act(page, step).click();
    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflowX, `after ${step ?? "load"}`).toBeLessThanOrEqual(0);
  }
});

test("lesson: controls hide after inactivity and come back on a remote key (TV-002)", async ({ page, student }) => {
  await seedOnce(page, { [STORE]: JSON.stringify(fixture[STORE]) });
  await page.clock.install();
  await page.goto(student.base + "/");
  await act(page, "profile:0").click();
  await act(page, "subject:Math").click();
  await act(page, "multiplication").click();
  await act(page, "table:1").click();
  await act(page, "world:puppy").click();
  await control(page, "pause");
  await page.clock.runFor(10_000);
  const shown = () => page.evaluate(() => document.getElementById("controls")?.className.includes("shown") ?? false);
  await control(page, "pause"); // resume
  await page.clock.runFor(10_000);
  expect(await shown()).toBe(false);
  await page.keyboard.press("ArrowUp");
  expect(await shown()).toBe(true);
});

test("checker self-test: the a11y checks catch known violations", async ({ page }) => {
  await page.setContent(`<html><head><title>t</title></head><body>
    <h1>One</h1><h1>Two</h1><h4>skip</h4>
    <input id="nolabel"><button></button><img src="x.png">
    <p style="color:#ccc;background:#fff">low contrast</p>
    <div id="dup"></div><div id="dup"></div><nav></nav>
  </body></html>`);
  const v = (await staticChecks(page)).violations.join("\n");
  for (const expected of ["lang", "exactly one visible h1", "heading level skipped", "form control without label", "without accessible name", "img without alt", "contrast", "duplicate id", "main landmark", "nav without accessible name"]) {
    expect(v).toContain(expected);
  }
});
