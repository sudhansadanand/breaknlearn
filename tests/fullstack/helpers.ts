/** Shared helpers for the full-stack specs: superuser SQL via psql (setup/assertions only), login, jobs. */
import { expect, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PSQL = `${process.env.BNL_PG_BIN ?? "/usr/lib/postgresql/16/bin"}/psql`;
export const ROOT = resolve(__dirname, "../..");
export const OWNER = { email: "owner@bnl.test", userId: "11111111-1111-4111-8111-111111111111" };
export const HH_A = "aaaaaaaa-0000-4000-8000-00000000000a";

/** Runs SQL as the harness superuser and returns the JSON value of the single result cell. */
export function sqlJson<T = unknown>(query: string): T {
  const out = execFileSync(PSQL, ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d", process.env.BNL_TEST_ADMIN_URL!, "-c", query], { encoding: "utf8" });
  const text = out.trim();
  return (text === "" ? null : JSON.parse(text)) as T;
}

export async function login(page: Page, email = OWNER.email): Promise<void> {
  await page.goto("/admin/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(process.env.BNL_DEV_AUTH_PASSWORD!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

/** Runs one scheduled job script exactly as cron would, against the throwaway DB (bnl_app login). */
export function runJob(script: string, args: string[]): Record<string, unknown> {
  const out = execFileSync(process.execPath, [resolve(ROOT, "scripts/jobs", script), ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", BNL_JOB_DB_URL: process.env.BNL_TEST_DB_URL! },
  });
  const last = out.trim().split("\n").filter(Boolean).pop() ?? "{}";
  return JSON.parse(last) as Record<string, unknown>;
}

export const act = (page: Page, a: string) => page.locator(`[data-act="${a}"]`);

/**
 * One real sign-in per run, reused through storageState: login is rate limited (5/15 min per email, SEC-009),
 * which a spec suite that signs in on every test would trip (that limit is itself asserted in 02-admin-a11y).
 */
let statePath: string | null = null;
export async function guardianContext(browser: Browser, opts: BrowserContextOptions = {}): Promise<BrowserContext> {
  if (!statePath) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await login(page);
    statePath = join(tmpdir(), `bnl-fullstack-state-${process.env.FULLSTACK_PORT ?? "x"}.json`);
    await ctx.storageState({ path: statePath });
    await ctx.close();
  }
  return browser.newContext({ ...opts, storageState: statePath });
}
