/**
 * Accessibility of the guardian/admin portal (TV-005 for adult pages, spec §11.11): focused automated checks from
 * tests/a11y/checks.ts on every portal page, rendered by the built app against the throwaway DB.
 * The owner is temporarily granted content roles so the lesson pages render their editor (not just "no access").
 */
import { expect, test } from "@playwright/test";
import { keyboardFocusChecks, staticChecks } from "../a11y/checks";
import { OWNER, guardianContext, sqlJson } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  sqlJson(`insert into bnl.staff_roles (auth_user_id, role) select '${OWNER.userId}', r from unnest(array['editor','reviewer']) r
           where not exists (select 1 from bnl.staff_roles s where s.auth_user_id = '${OWNER.userId}' and s.role = r and s.revoked_at is null)`);
});
test.afterAll(() => {
  sqlJson(`update bnl.staff_roles set revoked_at = now() where auth_user_id = '${OWNER.userId}' and revoked_at is null`);
});

test("login page", async ({ page }) => {
  await page.goto("/admin/login");
  const s = await staticChecks(page, { landmarks: false });
  expect(s.violations).toEqual([]);
  expect((await keyboardFocusChecks(page, 6)).violations).toEqual([]);
  // A failed login is announced (role=alert) and does not leak which part was wrong.
  await page.getByLabel("Email").fill("nobody@bnl.test");
  await page.getByLabel("Password").fill("wrong-password-123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("alert")).not.toContainText(/email not found|no such user/i);
});

test("SEC-009: repeated failed sign-ins for one email are rate limited (429) without revealing the account", async ({ request }) => {
  const statuses: number[] = [];
  for (let i = 0; i < 7; i++) {
    const r = await request.post("/api/v1/auth/login", {
      headers: { origin: `http://127.0.0.1:${process.env.FULLSTACK_PORT}`, "x-csrf-token": "t".repeat(43), cookie: `bnl_csrf=${"t".repeat(43)}`, "x-forwarded-for": "198.51.100.250" },
      data: { email: "guardian@bnl.test", password: `wrong-password-${i}` },
    });
    statuses.push(r.status());
  }
  expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
  expect(statuses.slice(5)).toEqual([429, 429]);
});

const PAGES = ["/admin", "/admin/devices", "/admin/children", "/admin/curriculum", "/admin/imports", "/admin/lessons", "/admin/analytics", "/admin/privacy"];

for (const path of PAGES) {
  test(`portal page ${path}`, async ({ browser }) => {
    const page = await (await guardianContext(browser)).newPage();
    await page.goto(path);
    await expect(page.locator("main#main")).toBeVisible();
    const s = await staticChecks(page);
    expect(s.violations, path).toEqual([]);
    const k = await keyboardFocusChecks(page, 30);
    expect(k.violations, path).toEqual([]);
  });
}

test("a lesson editor page", async ({ browser }) => {
  const page = await (await guardianContext(browser)).newPage();
  const id = sqlJson<string>(`select to_json(id) from bnl.lessons where stable_key = 'grade2.math.multiplication.table-3'`);
  await page.goto(`/admin/lessons/${id}`);
  await expect(page.locator("main#main")).toBeVisible();
  expect((await staticChecks(page)).violations).toEqual([]);
  expect((await keyboardFocusChecks(page, 40)).violations).toEqual([]);
});

test("portal works at 200% zoom-equivalent width without horizontal scrolling of the page", async ({ browser }) => {
  const page = await (await guardianContext(browser, { viewport: { width: 640, height: 900 } })).newPage();
  for (const path of ["/admin", "/admin/devices", "/admin/children", "/admin/analytics", "/admin/privacy"]) {
    await page.goto(path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, path).toBeLessThanOrEqual(1);
  }
});
