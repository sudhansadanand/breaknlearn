import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "../scripts/build.mjs";
import { es5Violations } from "../scripts/es5-check.mjs";

const SNAPSHOT = new URL("../../../legacy/live-snapshot-2026-11-14/", import.meta.url);
let dir = "";
let out = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "bnl-student-build-"));
  out = build(join(dir, "dist")).outDir;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const read = (name: string) => readFileSync(join(out, name), "utf8");

describe("built bundle", () => {
  it("ships exactly index.html, app.js, sw.js, logo.webp, music.wav (+ build.json)", async () => {
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(out).sort()).toEqual(["app.js", "build.json", "index.html", "logo.webp", "music.wav", "sw.js"]);
  });

  it("app.js and sw.js are ES5 (TypeScript-AST checker)", () => {
    expect(es5Violations(read("app.js"))).toEqual([]);
    expect(es5Violations(read("sw.js"))).toEqual([]);
  });

  it("app.js and sw.js parse with acorn ecmaVersion 5 when acorn is installed", async () => {
    type Acorn = { parse(src: string, o: { ecmaVersion: 5; sourceType: "script" }): unknown };
    const acorn: Acorn | null = await import(/* @vite-ignore */ "acorn" as string).then(
      (m) => m as Acorn,
      () => null, // not a declared dependency yet: requested in docs/adr/proposals/A5-student-integration.md
    );
    if (acorn === null) return;
    for (const f of ["app.js", "sw.js"]) expect(() => acorn.parse(read(f), { ecmaVersion: 5, sourceType: "script" })).not.toThrow();
  });

  it("the checker rejects ES2015+ syntax", () => {
    const bad = ["let a = 1;", "const b = 2;", "var f = () => 1;", "class A {}", "var s = `x`;", "var o = { a };", "var o = { m() {} };", "f(...xs);", "var [a] = b;", "for (var x of y) {}", "a?.b;", "a ?? b;", "function g(a = 1) {}", "async function h() {}", "function* k() {}", "var r = /x/u;", "import x from 'y';", "2 ** 3;"];
    for (const src of bad) expect(es5Violations(src), src).not.toEqual([]);
    expect(es5Violations("var a = function () { return [1, 2].map(function (x) { return x * 2; }); }; var o = { get v() { return 1; } };")).toEqual([]);
  });

  it("index.html is the live page byte-for-byte except the inline script → /app.js", () => {
    const live = readFileSync(new URL("index.html", SNAPSHOT), "utf8");
    const built = read("index.html");
    const strip = (s: string) => s.replace(/<script>\(function\(\)\{[\s\S]*?<\/script>|<script src="\/app\.js\?v=[0-9a-f]{12}"><\/script>/, "<script/>");
    expect(strip(built)).toBe(strip(live));
    expect(built).toMatch(/<script src="\/app\.js\?v=[0-9a-f]{12}"><\/script><\/body><\/html>$/);
  });

  it("logo.webp and music.wav are the live bytes", () => {
    for (const f of ["logo.webp", "music.wav"]) expect(readFileSync(join(out, f)).equals(readFileSync(new URL(f, SNAPSHOT)))).toBe(true);
  });

  it("the build id ties index, app.js and sw.js together", () => {
    const id = JSON.parse(read("build.json")).build_id as string;
    expect(read("index.html")).toContain(`/app.js?v=${id}`);
    expect(read("app.js")).toContain(`"/sw.js?v=" + BUILD_ID`);
    expect(read("app.js")).toContain(`"${id}"`);
    expect(read("sw.js")).toContain(`"${id}"`);
    expect(read("sw.js")).not.toContain("__BUILD_ID__");
  });
});
