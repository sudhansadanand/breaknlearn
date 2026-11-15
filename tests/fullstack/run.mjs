#!/usr/bin/env node
/**
 * Full-stack local E2E (A9, P6): built admin (`next start`) + co-hosted student bundle + a throwaway Postgres from
 * scripts/db/test-db.mjs, with LOCAL dev auth and every feature flag on. Nothing here touches a real service.
 *
 *   pnpm build                         # once: builds the student bundle and the admin (.next)
 *   node tests/fullstack/run.mjs [playwright args]   e.g. --trace off
 *
 * The script re-executes itself inside the DB harness, generates throwaway secrets (never written to disk),
 * and runs Playwright with tests/fullstack/playwright.config.ts. Exit code = Playwright's.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

if (!process.env.BNL_TEST_DB_URL) {
  if (!existsSync(resolve(root, "apps/admin/.next/BUILD_ID"))) {
    console.error("fullstack: apps/admin is not built; run `pnpm build` first");
    process.exit(2);
  }
  const r = spawnSync(process.execPath, [resolve(root, "scripts/db/test-db.mjs"), "--", process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit", cwd: root });
  process.exit(r.status ?? 1);
}

const env = {
  ...process.env,
  FULLSTACK_PORT: process.env.FULLSTACK_PORT ?? String(3300 + Math.floor(Math.random() * 400)),
  BNL_DEV_AUTH_PASSWORD: `e2e-${randomBytes(12).toString("hex")}`,
  DEVICE_TOKEN_SIGNING_SECRET: randomBytes(32).toString("base64"),
};
const r = spawnSync(process.execPath, [resolve(root, "node_modules/@playwright/test/cli.js"), "test", "-c", resolve(here, "playwright.config.ts"), ...process.argv.slice(2)], { stdio: "inherit", cwd: root, env });
process.exit(r.status ?? 1);
