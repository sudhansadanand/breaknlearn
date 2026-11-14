import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "off",
    viewport: { width: 1920, height: 1080 },
  },
  projects: [{ name: "tv-1080p-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1920, height: 1080 } } }],
  webServer: {
    command: "node scripts/static-server.mjs apps/student/public 4173",
    url: "http://127.0.0.1:4173/",
    reuseExistingServer: !process.env.CI,
  },
});
