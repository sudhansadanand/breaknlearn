import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson as pkgCanonical } from "../../../packages/student-progress/src";
import { canonicalJson, isoNow, isUuid, sha256Hex, uuid4 } from "../src/util";

describe("ES5 helpers", () => {
  it("sha256Hex equals node:crypto for ASCII, emoji, multi-block and empty input", () => {
    const samples = ["", "abc", "🧑‍🚀 Ravi · ×3", "x".repeat(55), "x".repeat(56), "y".repeat(64), "z".repeat(1000), JSON.stringify({ a: "é", b: [1, 2] })];
    for (const s of samples) expect(sha256Hex(s), s.slice(0, 10)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
  });

  it("canonicalJson is identical to @bnl/student-progress", () => {
    const v = { b: 1, a: [{ z: null, y: "🦊", x: undefined }, 2.5, true], c: { e: { d: "q\"uote" } } };
    expect(canonicalJson(v)).toBe(pkgCanonical(v));
    expect(canonicalJson(null)).toBe(pkgCanonical(null));
  });

  it("uuid4 produces RFC 4122 v4 ids, with and without an injected random source", () => {
    for (let i = 0; i < 50; i++) expect(isUuid(uuid4())).toBe(true);
    expect(uuid4(() => 0.5)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("isoNow matches Date.prototype.toISOString", () => {
    for (const t of [0, 1762990000000, 1762990000123]) expect(isoNow(t)).toBe(new Date(t).toISOString());
  });
});
