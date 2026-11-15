// Verifies the frozen live snapshot is byte-identical to what was captured on 2026-11-14.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const expected = {
  "legacy/live-snapshot-2026-11-14/index.html": "efdc2af1303a4c9d757d3e3548dd8852616fa9e40b150eaeccaa38b41f21fe0c",
  "legacy/live-snapshot-2026-11-14/logo.webp": "1604101a803b7c226f296f43526701e89c2a1491d219a68d2f00992d889a342b",
  "legacy/live-snapshot-2026-11-14/music.wav": "5b6bc9e7458e900ad2ff70f8e46d8ea6b57debc8f00d4e1dadd5884227072a3b",
};
let failed = false;
for (const [path, sha] of Object.entries(expected)) {
  const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (actual !== sha) {
    console.error(`MISMATCH ${path}: ${actual}`);
    failed = true;
  } else console.log(`ok ${path}`);
}
process.exit(failed ? 1 : 0);
