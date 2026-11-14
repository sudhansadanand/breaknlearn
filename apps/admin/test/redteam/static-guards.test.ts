/**
 * A9 static red-team guards over the server source (unit suite, no DB):
 *  - R1 mitigation: no request path builds SQL from input. `sql.unsafe(...)` may only receive an UPPER_CASE
 *    module constant whose template has no `${}` interpolation (column lists), plus the fixed role switch in @bnl/db.
 *  - No secret, service key or password literal is shipped in source or in the student bundle sources.
 *  - Every FEATURE_* flag documented in .env.example is actually read by the code (rollout safety, spec §10.5).
 *    Flags that are documented but not enforced are FINDING A9-OPS-01 (it.fails until wired).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../../..");
const walk = (dir: string, exts: string[]): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === "node_modules" || name === ".next" || name === "dist" || name === "public") return [];
    return statSync(p).isDirectory() ? walk(p, exts) : exts.some((e) => p.endsWith(e)) ? [p] : [];
  });
const SERVER_SRC = [...walk(join(ROOT, "apps/admin/src"), [".ts", ".tsx"]), ...walk(join(ROOT, "packages"), [".ts"]).filter((f) => f.includes("/src/"))];

describe("R1: SQL is never built from input", () => {
  it("every .unsafe() call takes a fixed, interpolation-free constant", () => {
    const offenders: string[] = [];
    let calls = 0;
    for (const file of SERVER_SRC) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/\.unsafe\(([^)]*)\)/g)) {
        calls++;
        const arg = m[1]!.trim();
        const rel = relative(ROOT, file);
        if (rel === "packages/db/src/index.ts" && arg === "`set local role ${s.role}`") continue; // role from the fixed DB_ROLES map
        if (!/^[A-Z][A-Z0-9_]*$/.test(arg)) {
          offenders.push(`${rel}: unsafe(${arg})`);
          continue;
        }
        const def = new RegExp(`const ${arg}\\s*=\\s*(\`[^\`]*\`|"[^"]*"|'[^']*')`).exec(src);
        if (!def) offenders.push(`${rel}: ${arg} is not a module string constant`);
        else if (def[1]!.includes("${")) offenders.push(`${rel}: ${arg} interpolates`);
      }
    }
    expect(calls).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });

  it("no string-concatenated SQL is passed to postgres outside tagged templates", () => {
    const offenders = SERVER_SRC.filter((f) => /sql\s*\(\s*["'`]\s*(select|insert|update|delete)/i.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });
});

describe("no embedded credentials", () => {
  const files = [...SERVER_SRC, ...walk(join(ROOT, "apps/student/src"), [".ts"]), join(ROOT, ".env.example")];
  it("no JWT-looking tokens, private keys or Supabase service keys in source", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const s = readFileSync(f, "utf8");
      if (/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/.test(s)) offenders.push(`${relative(ROOT, f)}: JWT literal`);
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(s)) offenders.push(`${relative(ROOT, f)}: private key`);
      if (/sb_secret_[A-Za-z0-9]{10,}|service_role\s*[:=]\s*["'][A-Za-z0-9._-]{20,}/.test(s)) offenders.push(`${relative(ROOT, f)}: service key`);
    }
    expect(offenders).toEqual([]);
  });

  it(".env.example holds placeholders only for every secret", () => {
    const env = readFileSync(join(ROOT, ".env.example"), "utf8");
    const value = (k: string) => new RegExp(`^${k}=(.*)$`, "m").exec(env)?.[1] ?? "";
    for (const k of ["SUPABASE_SERVICE_ROLE_KEY", "DEVICE_TOKEN_SIGNING_SECRET", "SUPABASE_ANON_KEY"]) expect(value(k), k).toMatch(/^replace-with/);
    for (const k of ["SUPABASE_JWT_SECRET", "BNL_DEV_AUTH_PASSWORD"]) expect(value(k), k).toBe("");
    expect(value("BNL_DEV_AUTH")).toBe("false");
    for (const k of ["BNL_JOB_DB_URL", "BNL_APP_DB_URL"]) expect(value(k), k).toContain("replace-me");
  });

  it("the student bundle source never references server-only env names or admin endpoints with secrets", () => {
    const offenders = walk(join(ROOT, "apps/student/src"), [".ts"]).filter((f) =>
      /SERVICE_ROLE|DEVICE_TOKEN_SIGNING_SECRET|SUPABASE_JWT_SECRET|BNL_DEV_AUTH/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("feature flags documented in .env.example are enforced", () => {
  const env = readFileSync(join(ROOT, ".env.example"), "utf8");
  const flags = [...env.matchAll(/^(FEATURE_[A-Z_]+)=/gm)].map((m) => m[1]!);
  const source = SERVER_SRC.map((f) => readFileSync(f, "utf8")).join("\n");
  const UNENFORCED = new Set(["FEATURE_PAIRING", "FEATURE_CATALOG_API", "FEATURE_SCORES"]);

  it("the documented flag set is the reviewed one", () => {
    expect(flags.sort()).toEqual(["FEATURE_ASSESSMENTS", "FEATURE_CATALOG_API", "FEATURE_PAIRING", "FEATURE_SCORES", "FEATURE_STUDENT_PAIRED", "FEATURE_STUDENT_SW", "FEATURE_TELEMETRY"]);
  });

  for (const flag of ["FEATURE_ASSESSMENTS", "FEATURE_CATALOG_API", "FEATURE_PAIRING", "FEATURE_SCORES", "FEATURE_STUDENT_PAIRED", "FEATURE_STUDENT_SW", "FEATURE_TELEMETRY"]) {
    // A9-OPS-01: FEATURE_PAIRING / FEATURE_CATALOG_API / FEATURE_SCORES are documented as rollout gates but no
    // handler reads them, so pairing, the catalog API and analytics are live as soon as the admin is deployed.
    // Fix diff: docs/adr/proposals/A9-qa-ops.md §2. Remove `.fails` when wired.
    (UNENFORCED.has(flag) ? it.fails : it)(`${flag} is read by server code`, () => {
      expect(source).toContain(flag);
    });
  }
});
