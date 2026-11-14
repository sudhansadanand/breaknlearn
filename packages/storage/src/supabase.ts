import { StorageError, assertValidBucket, assertValidKey, assertValidTtl, type StoragePort } from "./port";

/** Minimal fetch signature so callers can inject a test double. */
export type StorageFetch = (
  input: string,
  init: { method: string; headers: Record<string, string>; body?: Uint8Array | string },
) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer>; json(): Promise<unknown>; text(): Promise<string> }>;

const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");

/**
 * Supabase Storage via its REST API (`/storage/v1`), authenticated with the server-only service
 * role key. Buckets must be created private. NOT verified against a live Supabase project yet:
 * request shapes follow the Storage API docs and are covered only by fetch-double unit tests.
 */
export class SupabaseStorage implements StoragePort {
  private readonly base: string;

  constructor(
    url: string,
    private readonly serviceKey: string,
    private readonly fetchImpl: StorageFetch,
  ) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
      throw new StorageError("upstream", "Supabase URL must use https");
    }
    if (!serviceKey) throw new StorageError("upstream", "Supabase service role key is required");
    this.base = `${parsed.origin}/storage/v1`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.serviceKey}`, apikey: this.serviceKey, ...extra };
  }

  async put(bucket: string, key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    assertValidBucket(bucket);
    assertValidKey(key);
    const res = await this.fetchImpl(`${this.base}/object/${bucket}/${encodeKey(key)}`, {
      method: "POST",
      headers: this.headers({ "content-type": contentType, "x-upsert": "false", "cache-control": "no-store" }),
      body: bytes,
    });
    if (res.status === 409) throw new StorageError("exists", "Object already exists");
    if (!res.ok) throw new StorageError("upstream", `Storage upload failed (${res.status})`);
  }

  async get(bucket: string, key: string): Promise<Uint8Array | null> {
    assertValidBucket(bucket);
    assertValidKey(key);
    const res = await this.fetchImpl(`${this.base}/object/authenticated/${bucket}/${encodeKey(key)}`, { method: "GET", headers: this.headers() });
    // The Storage API answers 400 (with statusCode 404 in the body) or 404 for a missing object.
    if (res.status === 404 || res.status === 400) return null;
    if (!res.ok) throw new StorageError("upstream", `Storage download failed (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async signedUrl(bucket: string, key: string, ttlSeconds: number): Promise<string> {
    assertValidBucket(bucket);
    assertValidKey(key);
    assertValidTtl(ttlSeconds);
    const res = await this.fetchImpl(`${this.base}/object/sign/${bucket}/${encodeKey(key)}`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ expiresIn: ttlSeconds }),
    });
    if (!res.ok) throw new StorageError("upstream", `Storage signing failed (${res.status})`);
    const body = (await res.json()) as { signedURL?: unknown };
    if (typeof body.signedURL !== "string" || !body.signedURL.startsWith("/")) throw new StorageError("upstream", "Storage signing returned no URL");
    return `${this.base}${body.signedURL}`;
  }

  async remove(bucket: string, key: string): Promise<void> {
    assertValidBucket(bucket);
    assertValidKey(key);
    const res = await this.fetchImpl(`${this.base}/object/${bucket}`, {
      method: "DELETE",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ prefixes: [key] }),
    });
    if (!res.ok && res.status !== 404) throw new StorageError("upstream", `Storage delete failed (${res.status})`);
  }
}
