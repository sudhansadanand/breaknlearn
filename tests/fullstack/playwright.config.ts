/**
 * Full-stack E2E config (A9). Run through `node tests/fullstack/run.mjs`, which provides the throwaway database
 * (BNL_TEST_DB_URL / BNL_TEST_ADMIN_URL), the port and throwaway secrets. Serial: the specs share one database.
 */
import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const port = Number(process.env.FULLSTACK_PORT ?? 3399);
const base = `http://127.0.0.1:${port}`;
const root = resolve(__dirname, "../..");
const required = ["BNL_TEST_DB_URL", "BNL_TEST_ADMIN_URL", "BNL_DEV_AUTH_PASSWORD", "DEVICE_TOKEN_SIGNING_SECRET"];
for (const k of required) if (!process.env[k]) throw new Error(`${k} missing: run via node tests/fullstack/run.mjs`);

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  timeout: 180_000,
  use: { baseURL: base, trace: "off", viewport: { width: 1920, height: 1080 } },
  projects: [{ name: "fullstack-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1920, height: 1080 } } }],
  webServer: {
    command: `node ${join(root, "apps/admin/node_modules/next/dist/bin/next")} start -p ${port} -H 127.0.0.1`,
    cwd: join(root, "apps/admin"),
    url: `${base}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 90_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      // `next start` would default NODE_ENV to production, where dev auth and local storage are refused (by design).
      NODE_ENV: "test",
      NEXT_TELEMETRY_DISABLED: "1",
      ADMIN_ORIGIN: base,
      APP_ORIGIN: base,
      BNL_APP_DB_URL: process.env.BNL_TEST_DB_URL!,
      BNL_DB_PREPARE: "false",
      BNL_DB_POOL_MAX: "5",
      BNL_DEV_AUTH: "true",
      BNL_DEV_AUTH_PASSWORD: process.env.BNL_DEV_AUTH_PASSWORD!,
      DEVICE_TOKEN_SIGNING_SECRET: process.env.DEVICE_TOKEN_SIGNING_SECRET!,
      BNL_STORAGE_DRIVER: "local",
      BNL_LOCAL_STORAGE_DIR: mkdtempSync(join(tmpdir(), "bnl-fullstack-storage-")),
      FEATURE_PAIRING: "true",
      FEATURE_TELEMETRY: "true",
      FEATURE_CATALOG_API: "true",
      FEATURE_ASSESSMENTS: "true",
      FEATURE_SCORES: "true",
      FEATURE_STUDENT_PAIRED: "true",
      FEATURE_STUDENT_SW: "true",
      HOUSEHOLD_DEFAULT_TZ: "Asia/Kolkata",
    },
  },
});
