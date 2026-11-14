/**
 * Offline-first default = the live app. Drives the frozen live snapshot and the new bundle side by
 * side with the same clock, the same Math.random sequence and the same remote keys, and requires
 * identical #app markup and identical breaknlearn.profiles.v1 after every step.
 */
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { expect, STORE, test } from "../fixtures/student/server";

test.use({ serviceWorkers: "block", actionTimeout: 5_000 });

const T0 = new Date("2026-11-14T10:00:00Z");

async function prepare(page: Page, seed: Record<string, string> | null) {
  await page.clock.install({ time: T0 });
  await page.addInitScript((s) => {
    let a = 12345;
    Math.random = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    if (s && !sessionStorage.getItem("seeded")) {
      for (const k of Object.keys(s)) localStorage.setItem(k, s[k] as string);
      sessionStorage.setItem("seeded", "1");
    }
  }, seed);
}

type Step = [string, (p: Page) => Promise<unknown>];
const click = (a: string): Step => [`click ${a}`, (p) => p.locator(`[data-act="${a}"]`).click()];
const key = (k: string): Step => [`key ${k}`, (p) => p.keyboard.press(k)];
const wait = (ms: number): Step => [`clock +${ms}ms`, (p) => p.clock.runFor(ms)];
const fill = (v: string): Step => [`fill ${v}`, (p) => p.fill("#childName", v)];
const reload: Step = ["reload", async (p) => {
  await p.reload();
  await p.locator("#app button").first().waitFor();
}];

async function compare(live: Page, mine: Page, steps: Step[]) {
  // Freeze time on both pages: from here on only explicit clock steps move it.
  for (const p of [live, mine]) await p.clock.pauseAt(new Date(T0.getTime() + 60_000));
  const snap = async (p: Page) => ({
    html: await p.locator("#app").innerHTML(),
    store: await p.evaluate((k) => localStorage.getItem(k), STORE),
    focus: await p.evaluate(() => document.activeElement?.getAttribute("data-act") ?? document.activeElement?.tagName ?? null),
  });
  expect(await snap(mine)).toEqual(await snap(live));
  for (const [label, run] of steps) {
    await run(live);
    await run(mine);
    const [a, b] = [await snap(live), await snap(mine)];
    expect(b, `after "${label}"`).toEqual(a);
  }
}

test("fresh device: profiles, edit, subjects, stub, tables, lesson, controls, quiz, complete", async ({ browser, live, student }) => {
  test.setTimeout(120_000);
  const lp = await browser.newPage();
  const mp = await browser.newPage();
  for (const p of [lp, mp]) await prepare(p, null);
  await lp.goto(live.base + "/");
  await mp.goto(student.base + "/");
  await compare(lp, mp, [
    click("edit:0"), fill("Asha <b>&"), click("grade:6"), click("grade:2"), click("avatar:9"), click("save-profile"),
    click("subject:English"), click("back"), click("subject:Math"), click("multiplication"), click("table:7"),
    click("world:puppy"), wait(6000), wait(1500), key("ArrowUp"), key("ArrowRight"), key("Enter"), key(" "), wait(30000), key(" "),
    wait(7500), key("ArrowLeft"), click("music"), click("music"), click("prev"), click("restart"), wait(3000), key("Escape"),
    click("continue"), key("ArrowUp"), click("quiz"), click("answer:0"), click("nextq"), click("answer:3"), click("nextq"), click("answer:1"), click("nextq"),
    click("restart"), key("ArrowUp"), click("themes"), click("back"), click("back"), click("back"), click("edit-current"), fill("Asha"), click("save-profile"),
    click("profiles"), click("edit:1"), fill("Ravi"), click("avatar:11"), click("save-profile"), click("subject:Math"), click("subjects"),
    click("profiles"), click("profile:0"), reload,
  ]);
});

test("legacy storage: resume banners, bare ×3 keys, replay of a completed world (live F2 behaviour kept locally)", async ({ browser, live, student }) => {
  test.setTimeout(120_000);
  const fixture = JSON.parse(readFileSync("tests/fixtures/legacy/profiles-v1-two-children.json", "utf8"));
  const seed = { [STORE]: JSON.stringify(fixture[STORE]) };
  const lp = await browser.newPage();
  const mp = await browser.newPage();
  for (const p of [lp, mp]) await prepare(p, seed);
  await lp.goto(live.base + "/");
  await mp.goto(student.base + "/");
  await compare(lp, mp, [
    click("profile:0"), click("subject:Math"), click("multiplication"), click("table:3"), click("continue"), wait(2000), key("Backspace"),
    click("world:farm"), key("Escape"), click("back"), click("table:1"), click("world:puppy"), key("Escape"), click("back"), click("table:4"),
    click("back"), click("back"), click("back"), click("profiles"), click("profile:1"), click("subject:Physics"), click("back"), reload,
  ]);
});
