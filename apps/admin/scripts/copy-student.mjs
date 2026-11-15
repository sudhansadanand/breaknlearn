// Copies the built student bundle (apps/student/dist/*, run `pnpm build:student` first) into apps/admin/public/
// so one Next deployment serves `/`, `/logo.webp`, `/music.wav` byte-for-byte (ADR-0006).
import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function copyStudent(src = resolve(here, "../../student/dist"), dest = resolve(here, "../public")) {
  mkdirSync(dest, { recursive: true });
  const copied = [];
  for (const name of readdirSync(src)) {
    if (name === "build.json") continue;
    const from = join(src, name);
    if (!statSync(from).isFile()) throw new Error(`unexpected non-file in student dist/: ${name}`);
    copyFileSync(from, join(dest, name));
    copied.push(name);
  }
  if (!copied.includes("index.html")) throw new Error("student dist/ has no index.html");
  return copied;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const copied = copyStudent();
  console.log(`copied student files: ${copied.join(", ")}`);
}
