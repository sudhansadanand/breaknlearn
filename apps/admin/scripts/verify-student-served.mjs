/* global fetch, Buffer */
// After `pnpm build`: starts `next start` and proves `/`, `/logo.webp` and `/music.wav`
// and the bundle scripts are served byte-for-byte equal to apps/student/dist (ADR-0006), and that
// logo/music are still the live snapshot's bytes.
// Usage: node scripts/verify-student-served.mjs [port]
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const dist = resolve(appDir, "../student/dist");
const snapshot = resolve(appDir, "../../legacy/live-snapshot-2026-11-14");
const port = Number(process.argv[2] ?? 3199);
const { build_id: buildId } = JSON.parse(readFileSync(resolve(dist, "build.json"), "utf8"));
const files = [
  ["/", resolve(dist, "index.html")],
  ["/index.html", resolve(dist, "index.html")],
  [`/app.js?v=${buildId}`, resolve(dist, "app.js")],
  ["/sw.js", resolve(dist, "sw.js")],
  ["/logo.webp", resolve(snapshot, "logo.webp")],
  ["/music.wav", resolve(snapshot, "music.wav")],
];

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const nextBin = resolve(appDir, "node_modules/next/dist/bin/next");
// Static files need no secrets; the server is started with none so nothing sensitive is involved.
const server = spawn(process.execPath, [nextBin, "start", "-p", String(port), "-H", "127.0.0.1"], {
  cwd: appDir,
  stdio: ["ignore", "pipe", "pipe"],
  env: { PATH: process.env.PATH, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" },
});
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/logo.webp`);
      if (r.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`next start did not become ready:\n${log}`);
}

let failures = 0;
try {
  await waitReady();
  for (const [path, file] of files) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    const served = Buffer.from(await res.arrayBuffer());
    const expected = readFileSync(file);
    let ok = res.status === 200 && sha(served) === sha(expected);
    if (path === "/sw.js" && res.headers.get("cache-control") !== "no-cache") ok = false;
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"} ${path} -> ${file.split("/").slice(-2).join("/")} status=${res.status} bytes=${served.length}/${expected.length} sha256=${sha(served).slice(0, 16)}`);
  }
} finally {
  server.kill("SIGTERM");
}
if (failures > 0) {
  console.error(`${failures} served file(s) differ from the student build`);
  process.exit(1);
}
console.log("student bytes served unchanged");
