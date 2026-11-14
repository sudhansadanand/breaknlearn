/**
 * P0 gate `existing_student_regression_fixture`: pins the behaviour of the live
 * student app (apps/student/public == legacy/live-snapshot-2026-11-14) so every
 * later milestone can prove it did not break it. Covers CAT-001..004, MIG-001/002/003,
 * TV-001..003 as far as headless Chromium can (TV-006 stays a manual LG check).
 */
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const STORE = "breaknlearn.profiles.v1";
const WORLDS = [
  { id: "puppy", name: "Puppy Park", icon: "🐶" },
  { id: "candy", name: "Candy Land", icon: "🍬" },
  { id: "unicorn", name: "Unicorn Sky", icon: "🦄" },
  { id: "school", name: "School Box", icon: "✏️" },
  { id: "treat", name: "Treat Time", icon: "🍦" },
  { id: "farm", name: "Animal Farm", icon: "🐴" },
];
const G2 = ["English", "Math", "Tamil", "Hindi", "Science", "Aadritha", "Music"];
const G6 = ["English", "Math", "Tamil", "Hindi", "Physics", "Chemistry", "Biology", "History & Civics", "Geography", "Western Violin", "Carnatic Violin", "Aadritha"];

const act = (page: Page, a: string) => page.locator(`[data-act="${a}"]`);

async function seed(page: Page, value: unknown) {
  await page.addInitScript(
    ([k, v]) => {
      if (!sessionStorage.getItem("seeded")) {
        localStorage.setItem(k as string, JSON.stringify(v));
        sessionStorage.setItem("seeded", "1");
      }
    },
    [STORE, value],
  );
}

async function createProfile(page: Page, slot: number, name: string, grade: 2 | 6, avatarIndex: number) {
  await act(page, `edit:${slot}`).click();
  await page.fill("#childName", name);
  await act(page, `grade:${grade}`).click();
  await act(page, `avatar:${avatarIndex}`).click();
  await act(page, "save-profile").click();
}

/** Lesson controls are hidden until a remote key is pressed (TV-002); reveal them like a remote would. */
async function control(page: Page, a: string) {
  await page.keyboard.press("ArrowUp");
  await expect(page.locator("#controls")).toHaveClass(/shown/);
  await act(page, a).click();
}

const readStore = (page: Page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), STORE);

function countEmoji(text: string, emoji: string) {
  return text.split(emoji).length - 1;
}

test.describe("live app regression", () => {
  test("MIG-001: two independent profiles persist across reload", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Choose your explorer!")).toBeVisible();
    await expect(page.getByText("Add Explorer 1")).toBeVisible();
    await expect(page.getByText("Add Explorer 2")).toBeVisible();
    await createProfile(page, 0, "Asha", 2, 0);
    await act(page, "profiles").click();
    await createProfile(page, 1, "Ravi", 6, 9);
    await page.reload();
    await expect(page.locator(".profile")).toHaveCount(2);
    const store = await readStore(page);
    expect(store.profiles.map((p: { id: string; name: string; grade: number; avatar: string }) => [p.id, p.name, p.grade, p.avatar])).toEqual([
      ["child-1", "Asha", 2, "🦊"],
      ["child-2", "Ravi", 6, "🧑‍🚀"],
    ]);
    expect(store.activeId).toBe("child-2");
  });

  test("CAT-001/002: exact subject tiles per grade; only Grade 2 Math is live", async ({ page }) => {
    await page.goto("/");
    await createProfile(page, 0, "Asha", 2, 0);
    await expect(page.locator(".tile h3")).toHaveText(G2);
    for (const s of G2) {
      const sub = page.locator(`[data-act="subject:${encodeURIComponent(s)}"] .sub`);
      await expect(sub).toHaveText(s === "Math" ? "Multiplication Tables available" : "Coming soon");
    }
    await act(page, "subject:English").click();
    await expect(page.getByText("Coming soon!")).toBeVisible();
    await act(page, "subjects").click();
    await act(page, "profiles").click();
    await createProfile(page, 1, "Ravi", 6, 1);
    await expect(page.locator(".tile h3")).toHaveText(G6);
    await expect(page.locator(".tile.stub")).toHaveCount(G6.length); // no Grade 6 playable lesson
    await act(page, "subject:Math").click();
    await expect(page.getByText("Coming soon!")).toBeVisible();
  });

  test("CAT-003: Grade 2 Math -> tables x1..x10 -> six worlds each", async ({ page }) => {
    await page.goto("/");
    await createProfile(page, 0, "Asha", 2, 0);
    await act(page, "subject:Math").click();
    await act(page, "multiplication").click();
    await expect(page.locator(".table-card h3")).toHaveText(Array.from({ length: 10 }, (_, i) => `${i + 1} Times Table`));
    for (let t = 1; t <= 10; t++) {
      await act(page, `table:${t}`).click();
      await expect(page.getByRole("heading", { name: `Pick a world for ×${t}!` })).toBeVisible();
      await expect(page.locator(".tile h3")).toHaveText(WORLDS.map((w) => w.name));
      await act(page, "back").click();
    }
  });

  test("CAT-004: every fact for x1..x10 shows the right product and picture count", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/");
    await createProfile(page, 0, "Asha", 2, 0);
    await act(page, "subject:Math").click();
    await act(page, "multiplication").click();
    for (let f = 1; f <= 10; f++) {
      const world = WORLDS[(f - 1) % WORLDS.length]!;
      await act(page, `table:${f}`).click();
      await act(page, `world:${world.id}`).click();
      for (let n = 1; n <= 10; n++) {
        await expect(page.locator(".formula")).toHaveText(`${f} × ${n} = ${f * n}`);
        const objects = (await page.locator(".objects").textContent()) ?? "";
        expect(countEmoji(objects, world.icon), `${f}x${n} ${world.id}`).toBe(f * n);
        await expect(page.locator(".objects .group")).toHaveCount(n);
        if (n < 10) await control(page, "next");
      }
      await control(page, "themes");
      await act(page, "back").click();
    }
  });

  test("TV-003: 7-second autoplay in order; pause stops time; slide 10 leads to quiz", async ({ page }) => {
    await page.clock.install();
    await page.goto("/");
    await createProfile(page, 0, "Asha", 2, 0);
    await act(page, "subject:Math").click();
    await act(page, "multiplication").click();
    await act(page, "table:7").click();
    await act(page, "world:puppy").click();
    await expect(page.locator(".formula")).toHaveText("7 × 1 = 7");
    await page.clock.runFor(6_000);
    await expect(page.locator(".formula")).toHaveText("7 × 1 = 7");
    await page.clock.runFor(1_500);
    await expect(page.locator(".formula")).toHaveText("7 × 2 = 14");
    await page.keyboard.press(" "); // Play/Pause
    await expect(page.getByText("Paused")).toBeVisible();
    await page.clock.runFor(60_000);
    await expect(page.locator(".formula")).toHaveText("7 × 2 = 14");
    await page.keyboard.press(" ");
    for (let n = 3; n <= 10; n++) {
      await page.clock.runFor(7_500);
      await expect(page.locator(".formula")).toHaveText(`7 × ${n} = ${7 * n}`);
    }
    await page.clock.runFor(7_500);
    await expect(page.getByText("PICTURE QUIZ")).toBeVisible();
    const store = await readStore(page);
    expect(store.profiles[0].lessons["times-7:puppy"]).toMatchObject({ table: 7, complete: true, topicId: "multiplication-7" });
  });

  test("quiz: 3 questions, 4 unique options, exactly one correct", async ({ page }) => {
    await page.goto("/");
    await createProfile(page, 0, "Asha", 2, 0);
    await act(page, "subject:Math").click();
    await act(page, "multiplication").click();
    for (const f of [1, 2, 9, 10]) {
      await act(page, `table:${f}`).click();
      await act(page, "world:candy").click();
      await control(page, "quiz");
      for (let q = 1; q <= 3; q++) {
        await expect(page.locator(".crumb")).toContainText(`Quiz ${q} / 3`);
        const groups = await page.locator(".objects .group").count();
        const options = (await page.locator(".quiz-answers button").allTextContents()).map(Number);
        expect(options).toHaveLength(4);
        expect(new Set(options).size).toBe(4);
        expect(options.filter((o) => o === groups * f)).toHaveLength(1);
        expect(options.every((o) => o > 0)).toBe(true);
        await page.locator(".quiz-answers button").first().click();
        await act(page, "nextq").click();
      }
      await expect(page.getByText("You did it, Asha!")).toBeVisible();
      await act(page, "tables").click();
    }
  });

  test("MIG-002/003: live-shaped storage restores profiles, per-table/per-world resume and bare x3 keys", async ({ page }) => {
    const fixture = JSON.parse(readFileSync("tests/fixtures/legacy/profiles-v1-two-children.json", "utf8"));
    await seed(page, fixture[STORE]);
    await page.goto("/");
    await expect(page.locator(".profile strong")).toHaveText(["Asha", "Ravi"]);
    await act(page, "profile:0").click();
    await act(page, "subject:Math").click();
    await act(page, "multiplication").click();
    await expect(page.locator('[data-act="table:1"] .sub')).toHaveText("1 of 6 worlds complete");
    await act(page, "table:3").click();
    await expect(page.locator(".resume h3")).toHaveText("🍬 Candy Land · ×3");
    await expect(page.locator(".resume p")).toHaveText("Slide 4 of 10");
    await expect(page.locator('[data-act="world:farm"] .sub')).toHaveText("↻ Resume at 3 × 6");
    await act(page, "back").click();
    await act(page, "table:4").click();
    await expect(page.locator('[data-act="world:farm"] .sub')).toHaveText("10 visual slides"); // bare key is x3 only
    const store = await readStore(page);
    expect(store.profiles[1].lessons["times-3:unicorn"].slideId).toBe("step-7");
    expect(store.profiles[0].lessons.farm.slideId).toBe("three-6"); // never rewritten by reading
  });

  test("TV-001: remote keys - arrows move focus, Enter selects, Back returns", async ({ page }) => {
    await page.goto("/");
    await createProfile(page, 0, "Asha", 2, 0);
    await page.locator('[data-act="subject:English"]').focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator('[data-act="subject:Math"]')).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Choose a topic" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { name: "What shall we explore?" })).toBeVisible();
  });

  test("TV-005: primary targets are at least 64px tall at 1080p", async ({ page }) => {
    await page.goto("/");
    for (const b of await page.locator("button").all()) {
      const box = await b.boundingBox();
      if (box) expect(box.height).toBeGreaterThanOrEqual(64);
    }
  });
});
