import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { config, middleware } from "../src/middleware";
import nextConfig from "../next.config";
// @ts-expect-error -- plain ESM build script without type declarations
import { copyStudent } from "../scripts/copy-student.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

describe("security headers (middleware)", () => {
  it("admin pages get a nonce CSP without unsafe-inline scripts, DENY framing, no-referrer, no-store", () => {
    const res = middleware(new NextRequest("http://localhost:3000/admin/login"));
    const csp = res.headers.get("content-security-policy")!;
    const scriptSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src"))!;
    expect(scriptSrc).toMatch(/'nonce-[A-Za-z0-9_-]{16,}'/);
    expect(scriptSrc).not.toContain("unsafe-inline");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("permissions-policy")).toMatch(/camera=\(\).*microphone=\(\).*geolocation=\(\)/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    // Issues the double-submit CSRF cookie (readable by same-origin JS).
    expect(res.headers.get("set-cookie")).toMatch(/bnl_csrf=[A-Za-z0-9_-]{40,}/);
    expect(res.headers.get("set-cookie")).not.toMatch(/HttpOnly/i);
  });

  it("nonces differ per request", () => {
    const a = middleware(new NextRequest("http://localhost:3000/admin/login")).headers.get("content-security-policy");
    const b = middleware(new NextRequest("http://localhost:3000/admin/login")).headers.get("content-security-policy");
    expect(a).not.toBe(b);
  });

  it("API responses are no-store with a locked-down CSP", () => {
    for (const path of ["/api/v1/admin/me", "/api/v1/devices", "/api/v1/profiles"]) {
      const res = middleware(new NextRequest(`http://localhost:3000${path}`));
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
    }
  });

  it("does not match student URLs (their bytes and headers stay as live)", () => {
    expect(config.matcher).toEqual(["/admin", "/admin/:path*", "/api/:path*"]);
  });
});

describe("student co-hosting (ADR-0006)", () => {
  it("copy step reproduces the live snapshot byte-for-byte", () => {
    const dest = mkdtempSync(join(tmpdir(), "bnl-public-"));
    try {
      const copied: string[] = copyStudent(join(root, "apps/student/public"), dest);
      expect(copied.sort()).toEqual(["index.html", "logo.webp", "music.wav"]);
      for (const f of ["index.html", "logo.webp", "music.wav"]) {
        expect(sha(join(dest, f)), f).toBe(sha(join(root, "legacy/live-snapshot-2026-11-14", f)));
      }
      expect(readdirSync(dest).sort()).toEqual(["index.html", "logo.webp", "music.wav"]);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it("next.config rewrites / to the student index.html before routes and pages", async () => {
    expect(nextConfig.rewrites).toBeTypeOf("function");
    const rewrites = await nextConfig.rewrites?.();
    expect(rewrites).toEqual({ beforeFiles: [{ source: "/", destination: "/index.html" }] });
  });

  it("the build copy is gitignored and there is no app route for /", () => {
    expect(readFileSync(join(root, "apps/admin/.gitignore"), "utf8")).toMatch(/^\/public\/$/m);
    const appDir = join(root, "apps/admin/src/app");
    expect(readdirSync(appDir).filter((f) => /^page\.(t|j)sx?$/.test(f))).toEqual([]);
  });
});
