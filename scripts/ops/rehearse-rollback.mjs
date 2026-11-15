#!/usr/bin/env node
/**
 * Local ROLLBACK REHEARSAL (A9, P6 gate `rollback_rehearsed`). Never touches Vercel, Supabase or the live site.
 *
 * One browser profile (so localStorage and the service worker persist exactly like a TV) on one origin
 * http://127.0.0.1:<port> goes through:
 *   1. CURRENT   `next start` of the built admin: proves `/`, app.js, sw.js, logo, music are the current build's
 *                bytes; a child uses the app (legacy two-profile fixture + one lesson opened); the SW installs.
 *   2. KILL      same build with FEATURE_STUDENT_SW=false: the TV unregisters its worker and wipes bnl-student-*.
 *   3. ROLLBACK  the frozen legacy snapshot bytes (legacy/live-snapshot-2026-11-14) on the same origin: every file
 *                is byte-identical to the snapshot, the legacy app runs, both profiles and every localStorage key
 *                written before are preserved verbatim (nothing cleared or reset).
 *   4. FORWARD   back to the current build: new bundle loads, storage still intact.
 * A second, independent profile rehearses the emergency path when the kill switch could NOT be run first:
 *   E1. CURRENT with an active SW → E2. ROLLBACK = legacy bytes + the emergency self-unregistering /sw.js from
 *   apps/student/README.md → the worker removes itself and its caches; the legacy app runs; storage intact.
 *
 *   node scripts/ops/rehearse-rollback.mjs [--skip-build] [--port 3290]
 * Exit 0 = rehearsal passed. Prints one JSON summary line (also the evidence for docs/ops/ROLLBACK.md).
 */
/* global fetch, Buffer, localStorage, navigator, caches, document */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ADMIN = join(ROOT, "apps/admin");
const DIST = join(ROOT, "apps/student/dist");
const LEGACY = join(ROOT, "legacy/live-snapshot-2026-11-14");
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1] || 3290) || 3290;
const BASE = `http://127.0.0.1:${port}`;
const STORE = "breaknlearn.profiles.v1";
const fixture = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/legacy/profiles-v1-two-children.json"), "utf8"));
const EMERGENCY_SW = `self.addEventListener("install", function (e) { self.skipWaiting(); });
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (k) {
    return Promise.all(k.filter(function (n) { return n.indexOf("bnl-student-") === 0; }).map(function (n) { return caches.delete(n); }));
  }).then(function () { return self.registration.unregister(); }));
});
`;

const sha = (b) => createHash("sha256").update(b).digest("hex");
const log = (m) => console.error(`[rehearse-rollback] ${m}`);
const steps = [];
function check(name, ok, detail = "") {
  steps.push({ name, ok, ...(detail ? { detail } : {}) });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) throw new Error(`rehearsal step failed: ${name} ${detail}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function build() {
  for (const [cmd, a] of [["pnpm", ["build:student"]], ["pnpm", ["--filter", "@bnl/admin", "build"]]]) {
    log(`$ ${cmd} ${a.join(" ")}`);
    const r = spawnSync(cmd, a, { cwd: ROOT, stdio: "inherit" });
    if (r.status !== 0) throw new Error(`${cmd} ${a.join(" ")} failed`);
  }
}

/** Throwaway, local-only configuration: no database, no real auth provider is ever contacted. */
function nextEnv(extra) {
  return {
    PATH: process.env.PATH, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1",
    ADMIN_ORIGIN: BASE, APP_ORIGIN: BASE,
    DEVICE_TOKEN_SIGNING_SECRET: randomBytes(32).toString("base64"),
    SUPABASE_URL: "http://127.0.0.1:9", // unroutable placeholder; no adult sign-in happens in this rehearsal
    FEATURE_STUDENT_PAIRED: "false", FEATURE_TELEMETRY: "false",
    ...extra,
  };
}

async function startServer(kind, extraEnv = {}, staticRoot = LEGACY) {
  const child = kind === "next"
    ? spawn(process.execPath, [join(ADMIN, "node_modules/next/dist/bin/next"), "start", "-p", String(port), "-H", "127.0.0.1"], { cwd: ADMIN, env: nextEnv(extraEnv), stdio: ["ignore", "pipe", "pipe"] })
    : spawn(process.execPath, [join(ROOT, "scripts/static-server.mjs"), staticRoot, String(port)], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`${BASE}/logo.webp`);
      if (r.ok) return { child, out: () => out };
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  child.kill("SIGKILL");
  throw new Error(`${kind} server did not start:\n${out}`);
}
async function stopServer(s) {
  if (!s) return;
  const done = new Promise((r) => s.child.once("exit", r));
  s.child.kill("SIGTERM");
  await Promise.race([done, sleep(5000)]);
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${BASE}/logo.webp`);
      await sleep(100);
    } catch {
      return;
    }
  }
}

async function servedMatches(pairs) {
  const bad = [];
  for (const [path, file] of pairs) {
    const res = await fetch(`${BASE}${path}`, { cache: "no-store" });
    const body = Buffer.from(await res.arrayBuffer());
    if (res.status !== 200 || sha(body) !== sha(readFileSync(file))) bad.push(`${path} status=${res.status} sha=${sha(body).slice(0, 12)}`);
  }
  return bad;
}

const currentFiles = () => {
  const { build_id: id } = JSON.parse(readFileSync(join(DIST, "build.json"), "utf8"));
  return [["/", join(DIST, "index.html")], [`/app.js?v=${id}`, join(DIST, "app.js")], ["/sw.js", join(DIST, "sw.js")], ["/logo.webp", join(DIST, "logo.webp")], ["/music.wav", join(DIST, "music.wav")]];
};
// Deployable files only (SNAPSHOT.md is provenance, never served by the live site).
const legacyFiles = () => readdirSync(LEGACY).filter((f) => !f.startsWith(".") && !f.endsWith(".md")).map((f) => [f === "index.html" ? "/" : `/${f}`, join(LEGACY, f)]);

const dumpStorage = (page) => page.evaluate(() => {
  const o = {};
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); }
  return o;
});
const swState = (page) => page.evaluate(async () => ({
  regs: "serviceWorker" in navigator ? (await navigator.serviceWorker.getRegistrations()).length : -1,
  caches: (await caches.keys()).filter((k) => k.indexOf("bnl-student-") === 0).length,
  controlled: !!navigator.serviceWorker?.controller,
}));
const isNewBundle = (page) => page.evaluate(() => !!document.querySelector('script[src^="/app.js"]'));
async function waitFor(fn, pred, ms = 15000) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) { v = await fn(); if (pred(v)) return v; await sleep(250); }
  return v;
}

/** Profile names the live app renders on the explorer screen. */
async function profileNames(page) {
  await page.getByText("Choose your explorer!").waitFor({ timeout: 10000 });
  return page.locator('[data-act^="profile:"] strong').allTextContents();
}

async function useAppAsChild(page) {
  await page.goto(`${BASE}/`);
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [STORE, JSON.stringify(fixture[STORE])]);
  await page.reload();
  const names = await profileNames(page);
  await page.locator('[data-act="profile:0"]').click();
  await page.locator('[data-act="subject:Math"]').click();
  await page.locator('[data-act="multiplication"]').click();
  await page.locator('[data-act="table:2"]').click();
  await page.locator('[data-act="world:candy"]').click();
  await page.keyboard.press("Escape"); // remote Back: leave the lesson (persists lastTheme/lastTable)
  await page.goto(`${BASE}/`);
  return names;
}

async function mainRehearsal() {
  const dir = mkdtempSync(join(tmpdir(), "bnl-rollback-tv-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 1920, height: 1080 } });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  let server;
  try {
    // 1. CURRENT
    server = await startServer("next", { FEATURE_STUDENT_SW: "true" });
    check("current: served bytes equal apps/student/dist", (await servedMatches(currentFiles())).length === 0, (await servedMatches(currentFiles())).join("; "));
    const names = await useAppAsChild(page);
    check("current: two profiles render", names.length === 2, names.join(", "));
    check("current: new bundle is running", await isNewBundle(page));
    const sw = await waitFor(() => swState(page), (s) => s.regs > 0);
    check("current: service worker registered", sw.regs > 0, JSON.stringify(sw));
    const before = await dumpStorage(page);
    check("current: legacy backup taken before any write", typeof before["breaknlearn.legacy-backup.v1"] === "string");

    // 2. KILL SWITCH
    await stopServer(server);
    server = await startServer("next", { FEATURE_STUDENT_SW: "false" });
    await page.goto(`${BASE}/`);
    const killed = await waitFor(async () => { await page.reload(); return swState(page); }, (s) => s.regs === 0 && s.caches === 0);
    check("kill switch: FEATURE_STUDENT_SW=false unregisters the worker and wipes bnl-student-* caches", killed.regs === 0 && killed.caches === 0, JSON.stringify(killed));
    const killedStore = await dumpStorage(page);
    check("kill switch: only the cached server flags changed in storage", Object.keys(before).every((k) => k === "breaknlearn.student-config.v1" || killedStore[k] === before[k]));
    const beforeRollback = killedStore;

    // 3. ROLLBACK to the frozen legacy bytes, same origin
    await stopServer(server);
    server = await startServer("static", {}, LEGACY);
    const legacyBad = await servedMatches(legacyFiles());
    check("rollback: every served file is byte-identical to legacy/live-snapshot-2026-11-14", legacyBad.length === 0, legacyBad.join("; "));
    await page.goto(`${BASE}/`);
    check("rollback: legacy app is running (inline script, no app.js)", !(await isNewBundle(page)));
    const legacyNames = await profileNames(page);
    check("rollback: both profiles still present with the same names", JSON.stringify(legacyNames) === JSON.stringify(names), legacyNames.join(", "));
    const afterRollback = await dumpStorage(page);
    const lost = Object.keys(beforeRollback).filter((k) => !(k in afterRollback));
    check("rollback: no localStorage key lost", lost.length === 0, lost.join(","));
    const changed = Object.keys(beforeRollback).filter((k) => k !== STORE && afterRollback[k] !== beforeRollback[k]);
    check("rollback: every non-profile key byte-identical (backup, flags, queues)", changed.length === 0, changed.join(","));
    check("rollback: breaknlearn.profiles.v1 content unchanged by the legacy app", JSON.stringify(JSON.parse(afterRollback[STORE])) === JSON.stringify(JSON.parse(beforeRollback[STORE])));

    // 4. FORWARD again
    await stopServer(server);
    server = await startServer("next", { FEATURE_STUDENT_SW: "true" });
    check("forward: served bytes equal the current build again", (await servedMatches(currentFiles())).length === 0);
    await page.goto(`${BASE}/`);
    check("forward: new bundle is running", await isNewBundle(page));
    const fwdNames = await profileNames(page);
    check("forward: profiles intact", JSON.stringify(fwdNames) === JSON.stringify(names));
    const afterForward = await dumpStorage(page);
    check("forward: legacy backup unchanged (never overwritten)", afterForward["breaknlearn.legacy-backup.v1"] === before["breaknlearn.legacy-backup.v1"]);
  } finally {
    await stopServer(server);
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function emergencyRehearsal() {
  const dir = mkdtempSync(join(tmpdir(), "bnl-rollback-tv2-"));
  const legacyPlusSw = mkdtempSync(join(tmpdir(), "bnl-rollback-legacy-sw-"));
  for (const f of readdirSync(LEGACY)) copyFileSync(join(LEGACY, f), join(legacyPlusSw, f));
  writeFileSync(join(legacyPlusSw, "sw.js"), EMERGENCY_SW);
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 1920, height: 1080 } });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  let server;
  try {
    server = await startServer("next", { FEATURE_STUDENT_SW: "true" });
    await useAppAsChild(page);
    const sw = await waitFor(async () => { await page.reload(); return swState(page); }, (s) => s.regs > 0 && s.controlled && s.caches > 0);
    check("emergency: current bundle with an active, controlling SW and a populated cache", sw.regs > 0 && sw.controlled && sw.caches > 0, JSON.stringify(sw));
    const before = await dumpStorage(page);
    await stopServer(server);
    server = await startServer("static", {}, legacyPlusSw);
    const bad = await servedMatches(legacyFiles());
    check("emergency: legacy files byte-identical (plus only the emergency /sw.js)", bad.length === 0, bad.join("; "));
    await page.goto(`${BASE}/`);
    const gone = await waitFor(async () => {
      await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); if (r) await r.update().catch(() => undefined); });
      await page.reload();
      return swState(page);
    }, (s) => s.regs === 0 && s.caches === 0, 30000);
    check("emergency: worker removed itself and its caches", gone.regs === 0 && gone.caches === 0, JSON.stringify(gone));
    check("emergency: legacy app running", !(await isNewBundle(page)));
    const after = await dumpStorage(page);
    check("emergency: storage preserved", Object.keys(before).every((k) => k === STORE ? JSON.stringify(JSON.parse(after[k])) === JSON.stringify(JSON.parse(before[k])) : after[k] === before[k]));
  } finally {
    await stopServer(server);
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(legacyPlusSw, { recursive: true, force: true });
  }
}

const started = Date.now();
let code = 0;
try {
  if (!args.includes("--skip-build")) build();
  await mainRehearsal();
  await emergencyRehearsal();
} catch (err) {
  code = 1;
  log(err instanceof Error ? err.message : String(err));
}
console.log(JSON.stringify({ rehearsal: "rollback", ok: code === 0, port, steps: steps.length, failed: steps.filter((s) => !s.ok).map((s) => s.name), duration_ms: Date.now() - started }));
process.exit(code);
