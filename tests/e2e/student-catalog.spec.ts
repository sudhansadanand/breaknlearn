/**
 * P3 gate: 10 tables × 6 worlds on the built student bundle (CAT-003/004, TV-003). Every world of
 * every table autoplays its ten slides in order at 7 s, shows F×n with F·n pictures, ends in the
 * quiz, and is recorded complete; the table card then reads "★ All six themes complete".
 */
import { WORLDS, act, countEmoji, createProfile, expect, readJson, STORE, test } from "../fixtures/student/server";

test.use({ serviceWorkers: "block" });

for (let f = 1; f <= 10; f++) {
  test(`×${f}: all six worlds play 10 slides at 7 s, quiz, completion`, async ({ page, student }) => {
    test.setTimeout(90_000);
    await page.clock.install();
    await page.goto(student.base + "/");
    await createProfile(page, 0, "Asha", 2, 0);
    await act(page, "subject:Math").click();
    await act(page, "multiplication").click();
    await act(page, `table:${f}`).click();
    await expect(page.locator(".tile h3")).toHaveText(WORLDS.map((w) => w.name));
    for (const w of WORLDS) {
      await act(page, `world:${w.id}`).click();
      for (let n = 1; n <= 10; n++) {
        await expect(page.locator(".formula")).toHaveText(`${f} × ${n} = ${f * n}`);
        await expect(page.locator(".crumb")).toHaveText(`Asha · ×${f} · ${w.name} · Slide ${n} / 10`);
        const objects = (await page.locator(".objects").textContent()) ?? "";
        expect(countEmoji(objects, w.icon), `${f}x${n} ${w.id}`).toBe(f * n);
        await expect(page.locator(".objects .group")).toHaveCount(n);
        await page.clock.runFor(n === 1 ? 7_200 : 7_000);
      }
      await expect(page.getByText("PICTURE QUIZ")).toBeVisible();
      const store = await readJson(page, STORE);
      expect(store.profiles[0].lessons[`times-${f}:${w.id}`]).toMatchObject({ table: f, complete: true, slideId: "step-10", topicId: `multiplication-${f}` });
      await act(page, "themes").click();
      await expect(page.locator(`[data-act="world:${w.id}"] .sub`)).toHaveText("★ Completed · Replay");
    }
    await act(page, "back").click();
    await expect(page.locator(`[data-act="table:${f}"] .sub`)).toHaveText("★ All six themes complete");
  });
}
