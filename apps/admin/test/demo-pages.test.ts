import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

const protoDir = resolve(__dirname, "../../prototype");

describe("school demo (/demo) static pages", () => {
  it("every /demo rewrite points at a page that exists, whose assets exist", async () => {
    const rewrites = (await nextConfig.rewrites?.()) as { beforeFiles: { source: string; destination: string }[] };
    const demo = rewrites.beforeFiles.filter((r) => r.source.startsWith("/demo"));
    expect(demo.length).toBeGreaterThanOrEqual(6);
    for (const { destination } of demo) {
      const page = join(protoDir, destination.replace(/^\/prototype\//, ""));
      expect(existsSync(page), destination).toBe(true);
      const html = readFileSync(page, "utf8");
      for (const [, asset] of html.matchAll(/(?:src|href)="\/prototype\/([^"]+)"/g)) {
        expect(existsSync(join(protoDir, asset!)), `${destination} → ${asset}`).toBe(true);
      }
    }
  });

  it("demo pages carry no prototype ribbon and make no network calls", () => {
    for (const f of ["demo.html", "teacher.html", "child.html", "growth.html", "class.html", "privacy.html"]) {
      expect(readFileSync(join(protoDir, f), "utf8"), f).not.toMatch(/class="ribbon"/);
    }
    for (const f of ["proto.js", "demo-nav.js", "teacher.js", "growth.js", "class.js", "privacy.js"]) {
      expect(readFileSync(join(protoDir, f), "utf8"), f).not.toMatch(/\bfetch\(|XMLHttpRequest|localStorage|sendBeacon/);
    }
  });
});
