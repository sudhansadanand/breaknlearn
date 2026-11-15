// Copies the static concept prototype (apps/prototype/*) into apps/admin/public/prototype/
// so the staging deployment serves it at /prototype. No data, no API calls, no accounts.
import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function copyPrototype(src = resolve(here, "../../prototype"), dest = resolve(here, "../public/prototype")) {
  mkdirSync(dest, { recursive: true });
  const copied = [];
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    if (!statSync(from).isFile()) continue;
    copyFileSync(from, join(dest, name));
    copied.push(name);
  }
  return copied;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`copied prototype files: ${copyPrototype().join(", ")}`);
}
