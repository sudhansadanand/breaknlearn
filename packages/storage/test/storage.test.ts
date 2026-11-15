import { mkdtempSync, rmSync, symlinkSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LocalFsStorage,
  MemoryStorage,
  MIME_DOCX,
  MIME_PDF,
  StorageError,
  SupabaseStorage,
  assertValidKey,
  isPlainText,
  sniffMime,
  type StorageFetch,
} from "../src";

const HH = "aaaaaaaa-0000-4000-8000-00000000000a";
const KEY = `${HH}/0f8fad5b-d9cb-469f-a165-70867728950e`;
const SIGNING = new Uint8Array(32).fill(7);

let root: string;
let clock: { now: Date };
let store: LocalFsStorage;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bnl-storage-"));
  clock = { now: new Date("2026-11-14T10:00:00Z") };
  store = new LocalFsStorage(root, { signingKey: SIGNING, baseUrl: "/api/v1/admin/imports/local-object", now: () => clock.now });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const bytes = (s: string) => new TextEncoder().encode(s);

describe("LocalFsStorage", () => {
  it("round-trips an object, never overwrites, and removes idempotently", async () => {
    await store.put("school-syllabi", KEY, bytes("hello"), "text/plain");
    expect(new TextDecoder().decode((await store.get("school-syllabi", KEY))!)).toBe("hello");
    await expect(store.put("school-syllabi", KEY, bytes("other"), "text/plain")).rejects.toMatchObject({ code: "exists" });
    expect(new TextDecoder().decode((await store.get("school-syllabi", KEY))!)).toBe("hello");
    await store.remove("school-syllabi", KEY);
    await store.remove("school-syllabi", KEY);
    expect(await store.get("school-syllabi", KEY)).toBeNull();
    // No temp files are left behind.
    expect(readdirSync(join(root, "school-syllabi", HH))).toEqual([]);
  });

  it.each([
    "../etc/passwd",
    `${HH}/../../etc/passwd`,
    `${HH}/a/../../b`,
    `${HH}/./x`,
    `${HH}//x`,
    `${HH}/.hidden`,
    `/${HH}/x`,
    `${HH}\\..\\x`,
    `${HH}/x%2e%2e`,
    "not-a-uuid/x",
    `${HH}/`,
    `${HH}/a b`,
    `${HH}/${"a".repeat(600)}`,
  ])("rejects traversal / malformed key %s", async (key) => {
    await expect(store.put("school-syllabi", key, bytes("x"), "text/plain")).rejects.toBeInstanceOf(StorageError);
    await expect(store.get("school-syllabi", key)).rejects.toBeInstanceOf(StorageError);
    await expect(store.signedUrl("school-syllabi", key, 60)).rejects.toBeInstanceOf(StorageError);
  });

  it.each(["..", "../x", "School", "a", "a/b"])("rejects bucket %s", async (bucket) => {
    await expect(store.put(bucket, KEY, bytes("x"), "text/plain")).rejects.toMatchObject({ code: "invalid_bucket" });
  });

  it("refuses to follow a symlinked household directory", async () => {
    const outside = mkdtempSync(join(tmpdir(), "bnl-outside-"));
    mkdirSync(join(root, "school-syllabi"), { recursive: true });
    symlinkSync(outside, join(root, "school-syllabi", HH));
    await expect(store.put("school-syllabi", KEY, bytes("x"), "text/plain")).rejects.toMatchObject({ code: "invalid_key" });
    expect(readdirSync(outside)).toEqual([]);
    rmSync(outside, { recursive: true, force: true });
  });

  it("signed URLs verify, expire, and reject tampering", async () => {
    await store.put("school-syllabi", KEY, bytes("x"), "text/plain");
    const url = await store.signedUrl("school-syllabi", KEY, 60);
    expect(url.startsWith("/api/v1/admin/imports/local-object?")).toBe(true);
    const q = new URLSearchParams(url.split("?")[1]);
    expect(store.verifySignedUrl(q)).toEqual({ bucket: "school-syllabi", key: KEY });

    const otherKey = new URLSearchParams(q);
    otherKey.set("k", `${HH}/another`);
    expect(store.verifySignedUrl(otherKey)).toBeNull();
    const longer = new URLSearchParams(q);
    longer.set("e", String(Number(q.get("e")) + 3600));
    expect(store.verifySignedUrl(longer)).toBeNull();
    const badSig = new URLSearchParams(q);
    badSig.set("s", "A".repeat(43));
    expect(store.verifySignedUrl(badSig)).toBeNull();
    const traversal = new URLSearchParams(q);
    traversal.set("k", "../../etc/passwd");
    expect(store.verifySignedUrl(traversal)).toBeNull();

    clock.now = new Date(clock.now.getTime() + 61_000);
    expect(store.verifySignedUrl(q)).toBeNull();
  });

  it("signed URLs from another signing key do not verify", async () => {
    const other = new LocalFsStorage(root, { signingKey: new Uint8Array(32).fill(9), baseUrl: "/x", now: () => clock.now });
    const q = new URLSearchParams((await other.signedUrl("school-syllabi", KEY, 60)).split("?")[1]);
    expect(store.verifySignedUrl(q)).toBeNull();
  });

  it("bounds TTL and requires a strong key and absolute root", async () => {
    await expect(store.signedUrl("school-syllabi", KEY, 0)).rejects.toMatchObject({ code: "invalid_ttl" });
    await expect(store.signedUrl("school-syllabi", KEY, 7200)).rejects.toMatchObject({ code: "invalid_ttl" });
    expect(() => new LocalFsStorage(root, { signingKey: new Uint8Array(8), baseUrl: "/x" })).toThrow(StorageError);
    expect(() => new LocalFsStorage("relative/dir", { signingKey: SIGNING, baseUrl: "/x" })).toThrow(StorageError);
  });

  it("keeps files inside the bucket directory", async () => {
    await store.put("school-syllabi", `${HH}/nested/file.csv`, bytes("x"), "text/csv");
    expect(existsSync(join(root, "school-syllabi", HH, "nested", "file.csv"))).toBe(true);
    expect(store.pathFor("school-syllabi", KEY).startsWith(join(root, "school-syllabi"))).toBe(true);
  });
});

describe("assertValidKey", () => {
  it("accepts generated keys", () => {
    expect(() => assertValidKey(KEY)).not.toThrow();
    expect(() => assertValidKey(`${HH}/2026/x-y_z.pdf`)).not.toThrow();
  });
});

describe("MemoryStorage", () => {
  it("never overwrites and validates keys", async () => {
    const m = new MemoryStorage();
    await m.put("school-syllabi", KEY, bytes("a"), "text/plain");
    await expect(m.put("school-syllabi", KEY, bytes("b"), "text/plain")).rejects.toMatchObject({ code: "exists" });
    await expect(m.get("school-syllabi", "../x")).rejects.toBeInstanceOf(StorageError);
    expect(await m.signedUrl("school-syllabi", KEY, 30)).toMatch(/^https:\/\/storage\.invalid\//);
  });
});

describe("SupabaseStorage (fetch double; not verified against a live project)", () => {
  function fake(responses: { status: number; body?: unknown }[]) {
    const calls: { url: string; method: string; headers: Record<string, string>; body?: unknown }[] = [];
    const f: StorageFetch = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body });
      const r = responses.shift() ?? { status: 500 };
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        arrayBuffer: async () => new TextEncoder().encode(String(r.body ?? "")).buffer as ArrayBuffer,
        json: async () => r.body,
        text: async () => String(r.body ?? ""),
      };
    };
    return { f, calls };
  }

  it("uses the REST endpoints with the service key and never upserts", async () => {
    const { f, calls } = fake([{ status: 200 }, { status: 200, body: "abc" }, { status: 200, body: { signedURL: "/object/sign/school-syllabi/x?token=t" } }, { status: 200 }]);
    const s = new SupabaseStorage("https://proj.supabase.co", "service-key", f);
    await s.put("school-syllabi", KEY, bytes("abc"), "text/plain");
    expect(new TextDecoder().decode((await s.get("school-syllabi", KEY))!)).toBe("abc");
    expect(await s.signedUrl("school-syllabi", KEY, 60)).toBe("https://proj.supabase.co/storage/v1/object/sign/school-syllabi/x?token=t");
    await s.remove("school-syllabi", KEY);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST https://proj.supabase.co/storage/v1/object/school-syllabi/${KEY}`,
      `GET https://proj.supabase.co/storage/v1/object/authenticated/school-syllabi/${KEY}`,
      `POST https://proj.supabase.co/storage/v1/object/sign/school-syllabi/${KEY}`,
      "DELETE https://proj.supabase.co/storage/v1/object/school-syllabi",
    ]);
    expect(calls[0]!.headers["x-upsert"]).toBe("false");
    expect(calls[0]!.headers.authorization).toBe("Bearer service-key");
    expect(calls[2]!.body).toBe(JSON.stringify({ expiresIn: 60 }));
  });

  it("maps missing objects to null, conflicts to exists, and validates before any request", async () => {
    const { f, calls } = fake([{ status: 400 }, { status: 409 }]);
    const s = new SupabaseStorage("https://proj.supabase.co", "k", f);
    expect(await s.get("school-syllabi", KEY)).toBeNull();
    await expect(s.put("school-syllabi", KEY, bytes("x"), "text/plain")).rejects.toMatchObject({ code: "exists" });
    await expect(s.get("school-syllabi", "../../x")).rejects.toMatchObject({ code: "invalid_key" });
    expect(calls).toHaveLength(2);
    expect(() => new SupabaseStorage("http://proj.supabase.co", "k", f)).toThrow(StorageError);
  });
});

describe("sniffMime", () => {
  it("detects PDF by %PDF-", () => {
    expect(sniffMime(bytes("%PDF-1.7\n..."))).toEqual({ kind: "pdf", mime: MIME_PDF });
    expect(sniffMime(bytes(" %PDF-1.7"))?.kind).toBe("text");
  });

  it("detects DOCX only when the zip contains word/document.xml", () => {
    expect(sniffMime(makeZip(["[Content_Types].xml", "word/document.xml"]))).toEqual({ kind: "docx", mime: MIME_DOCX });
    expect(sniffMime(makeZip(["[Content_Types].xml", "xl/workbook.xml"]))).toBeNull();
    expect(sniffMime(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).toBeNull();
  });

  it("accepts UTF-8 text and rejects binary / NUL / invalid UTF-8", () => {
    expect(sniffMime(bytes("﻿chapter_no,title\r\n1,Shapes"))?.kind).toBe("text");
    expect(sniffMime(bytes("தமிழ் பாடம் 1"))?.kind).toBe("text");
    expect(sniffMime(new Uint8Array([0x41, 0x00, 0x42]))).toBeNull();
    expect(sniffMime(new Uint8Array([0xc3, 0x28]))).toBeNull();
    expect(sniffMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(isPlainText(new Uint8Array())).toBe(false);
  });
});

/** Builds a stored (uncompressed) zip with empty entries. */
function makeZip(names: string[]): Uint8Array {
  const enc = new TextEncoder();
  const local: number[] = [];
  const central: number[] = [];
  const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
  const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
  for (const name of names) {
    const nb = [...enc.encode(name)];
    const offset = local.length;
    local.push(...le32(0x04034b50), ...le16(20), ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32(0), ...le32(0), ...le32(0), ...le16(nb.length), ...le16(0), ...nb);
    central.push(...le32(0x02014b50), ...le16(20), ...le16(20), ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32(0), ...le32(0), ...le32(0), ...le16(nb.length), ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32(0), ...le32(offset), ...nb);
  }
  const eocd = [...le32(0x06054b50), ...le16(0), ...le16(0), ...le16(names.length), ...le16(names.length), ...le32(central.length), ...le32(local.length), ...le16(0)];
  return new Uint8Array([...local, ...central, ...eocd]);
}
