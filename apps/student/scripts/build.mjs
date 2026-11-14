// Builds the student static bundle: dist/{index.html, app.js, sw.js, logo.webp, music.wav}.
// TypeScript sources are transpiled to ES5/CommonJS with the workspace TypeScript and joined into
// one IIFE with a tiny module loader (no bundler dependency). The output is checked for ES5 syntax.
// Usage: node scripts/build.mjs [--out <dir>]
/* global Buffer */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { es5Violations } from "./es5-check.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const srcDir = join(appDir, "src");

const COMPILER = {
  target: ts.ScriptTarget.ES5,
  module: ts.ModuleKind.CommonJS,
  alwaysStrict: true,
  removeComments: true,
  esModuleInterop: false,
  importHelpers: false,
  isolatedModules: true,
  newLine: ts.NewLineKind.LineFeed,
};

function transpile(file) {
  const out = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: COMPILER, fileName: file, reportDiagnostics: true });
  if (out.diagnostics?.length) throw new Error(`${file}: ${out.diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")).join("; ")}`);
  return out.outputText.replace(/\n\/\/# sourceMappingURL=.*$/, "");
}

/** Joins src/main.ts and everything it requires (relative imports only) into one ES5 IIFE. */
export function bundleApp(entry = "./main") {
  const modules = new Map();
  const queue = [entry];
  while (queue.length) {
    const id = queue.shift();
    if (modules.has(id)) continue;
    const code = transpile(join(srcDir, `${id.slice(2)}.ts`));
    modules.set(id, code);
    for (const m of code.matchAll(/require\("(\.\/[a-z0-9-]+)"\)/g)) if (!modules.has(m[1])) queue.push(m[1]);
    if (/require\("(?!\.\/)/.test(code)) throw new Error(`${id}: only relative imports can be bundled`);
  }
  const defs = [...modules].map(([id, code]) => `__m[${JSON.stringify(id)}]=function(require,module,exports){\n${code}\n};`).join("\n");
  return `/* BreakNLearn student app (ES5). Source: apps/student/src */\n(function(){\nvar __m={},__c={};\nfunction __r(n){if(__c[n])return __c[n].exports;var m=__c[n]={exports:{}};__m[n].call(m.exports,__r,m,m.exports);return m.exports}\n${defs}\n__r(${JSON.stringify(entry)});\n})();\n`;
}

export function build(outDir = join(appDir, "dist")) {
  const appJs = bundleApp();
  const swJs = transpile(join(srcDir, "sw.ts"));
  const indexTpl = readFileSync(join(srcDir, "index.html"), "utf8");
  const logo = readFileSync(join(appDir, "public/logo.webp"));
  const music = readFileSync(join(appDir, "public/music.wav"));
  const buildId = createHash("sha256").update(appJs).update(swJs).update(indexTpl).update(logo).update(music).digest("hex").slice(0, 12);
  const files = {
    "index.html": indexTpl.replaceAll("__BUILD_ID__", buildId),
    "app.js": appJs.replaceAll("__BUILD_ID__", buildId),
    "sw.js": swJs.replaceAll("__BUILD_ID__", buildId),
  };
  for (const name of ["app.js", "sw.js"]) {
    const v = es5Violations(files[name], name);
    if (v.length) throw new Error(`${name} is not ES5:\n  ${v.slice(0, 20).join("\n  ")}`);
  }
  // Write to a temporary sibling and swap, so concurrent readers never see a half-written bundle.
  const tmp = `${outDir}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(tmp, name), text);
  copyFileSync(join(appDir, "public/logo.webp"), join(tmp, "logo.webp"));
  copyFileSync(join(appDir, "public/music.wav"), join(tmp, "music.wav"));
  writeFileSync(join(tmp, "build.json"), JSON.stringify({ build_id: buildId }) + "\n");
  const old = `${outDir}.old-${process.pid}`;
  if (existsSync(outDir)) renameSync(outDir, old);
  renameSync(tmp, outDir);
  rmSync(old, { recursive: true, force: true });
  return { outDir, buildId, bytes: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.byteLength(v)])) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--out");
  const r = build(i > 0 ? resolve(process.argv[i + 1]) : undefined);
  console.log(`built ${r.outDir} (build ${r.buildId}) ${JSON.stringify(r.bytes)}`);
}
