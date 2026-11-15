import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("generated curriculum seed", () => {
  it("supabase/seed/0001_curriculum.sql matches the prototype JSON", () => {
    const script = fileURLToPath(new URL("../../../../scripts/db/gen-curriculum-seed.mjs", import.meta.url));
    const res = spawnSync(process.execPath, [script, "--check"], { encoding: "utf8" });
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
  });
});
