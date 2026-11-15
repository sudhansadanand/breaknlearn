/**
 * Playwright worker fixture for the student e2e specs: builds apps/student into a temp dir (or uses
 * STUDENT_DIST when set) and serves it on a random local port. Independent of playwright.config's
 * webServer, which still serves the frozen snapshot for the legacy regression.
 */
import { test as base, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const BUILD_SCRIPT = resolve(__dirname, "../../../apps/student/scripts/build.mjs");
function build(outDir: string): string {
  // Run as a child process: Playwright loads specs as CommonJS and cannot import the ESM build script.
  execFileSync(process.execPath, [BUILD_SCRIPT, "--out", outDir], { stdio: "pipe" });
  return outDir;
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".webp": "image/webp", ".wav": "audio/wave", ".json": "application/json" };

function serve(root: string): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let path = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!path.startsWith(root)) return void res.writeHead(403).end();
    try {
      if (statSync(path).isDirectory()) path = join(path, "index.html");
      const body = readFileSync(path);
      res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream", "cache-control": "no-cache" }).end(body);
    } catch {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "not_found", message: "Not found", request_id: "static" } }));
    }
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => {
    const addr = server.address();
    ok({ server, base: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}` });
  }));
}

const LEGACY_DIR = resolve(__dirname, "../../../legacy/live-snapshot-2026-11-14");

export const test = base.extend<object, { student: { base: string; dir: string }; live: { base: string } }>({
  /** The frozen live snapshot, served the same way, for side-by-side parity checks. */
  live: [
    // eslint-disable-next-line no-empty-pattern -- Playwright fixture signature
    async ({}, use) => {
      const { server, base } = await serve(LEGACY_DIR);
      await use({ base });
      await new Promise((ok) => server.close(ok));
    },
    { scope: "worker" },
  ],
  student: [
    // eslint-disable-next-line no-empty-pattern -- Playwright fixture signature
    async ({}, use) => {
      const tmp = process.env.STUDENT_DIST ? null : mkdtempSync(join(tmpdir(), "bnl-student-e2e-"));
      const dir = process.env.STUDENT_DIST ? resolve(process.env.STUDENT_DIST) : build(join(tmp!, "dist"));
      const { server, base } = await serve(dir);
      await use({ base, dir });
      await new Promise((ok) => server.close(ok));
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    },
    { scope: "worker" },
  ],
});
export { expect } from "@playwright/test";

export const STORE = "breaknlearn.profiles.v1";
export const BACKUP = "breaknlearn.legacy-backup.v1";
export const WORLDS = [
  { id: "puppy", name: "Puppy Park", icon: "🐶" },
  { id: "candy", name: "Candy Land", icon: "🍬" },
  { id: "unicorn", name: "Unicorn Sky", icon: "🦄" },
  { id: "school", name: "School Box", icon: "✏️" },
  { id: "treat", name: "Treat Time", icon: "🍦" },
  { id: "farm", name: "Animal Farm", icon: "🐴" },
];

export const act = (page: Page, a: string) => page.locator(`[data-act="${a}"]`);

export async function createProfile(page: Page, slot: number, name: string, grade: 2 | 6, avatarIndex: number) {
  await act(page, `edit:${slot}`).click();
  await page.fill("#childName", name);
  await act(page, `grade:${grade}`).click();
  await act(page, `avatar:${avatarIndex}`).click();
  await act(page, "save-profile").click();
}

/** Seeds localStorage once per browser session (survives reloads without re-seeding). */
export async function seedOnce(page: Page, values: Record<string, string>) {
  await page.addInitScript((v) => {
    if (!sessionStorage.getItem("seeded")) {
      for (const k of Object.keys(v)) localStorage.setItem(k, v[k] as string);
      sessionStorage.setItem("seeded", "1");
    }
  }, values);
}

export const dumpStorage = (page: Page) =>
  page.evaluate(() => {
    const out: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) as string;
      out[k] = localStorage.getItem(k) as string;
    }
    return out;
  });

export const readJson = (page: Page, key: string) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), key);

export const countEmoji = (text: string, emoji: string) => text.split(emoji).length - 1;

/** Lesson controls are hidden until a remote key is pressed (TV-002). */
export async function control(page: Page, a: string) {
  await page.keyboard.press("ArrowUp");
  await act(page, a).click();
}
