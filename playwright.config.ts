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
    // STUDENT_DIR=legacy/live-snapshot-2026-11-14 runs the regression suite against the frozen live app.
    command: `node scripts/static-server.mjs ${process.env.STUDENT_DIR ?? "apps/student/dist"} 4173`,
    url: "http://127.0.0.1:4173/",
    reuseExistingServer: !process.env.CI,
  },
});
