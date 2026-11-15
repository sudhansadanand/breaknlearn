import { StorageError, assertValidBucket, assertValidKey, assertValidTtl, type StoragePort } from "./port";

/** In-memory storage for route tests. Signed URLs are opaque `memory://` strings with an expiry. */
export class MemoryStorage implements StoragePort {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  private id(bucket: string, key: string): string {
    assertValidBucket(bucket);
    assertValidKey(key);
    return `${bucket}/${key}`;
  }

  async put(bucket: string, key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const id = this.id(bucket, key);
    if (this.objects.has(id)) throw new StorageError("exists", "Object already exists");
    this.objects.set(id, { bytes: bytes.slice(), contentType });
  }

  async get(bucket: string, key: string): Promise<Uint8Array | null> {
    return this.objects.get(this.id(bucket, key))?.bytes.slice() ?? null;
  }

  async signedUrl(bucket: string, key: string, ttlSeconds: number): Promise<string> {
    const id = this.id(bucket, key);
    assertValidTtl(ttlSeconds);
    const exp = Math.floor(this.now().getTime() / 1000) + ttlSeconds;
    return `https://storage.invalid/signed/${id}?exp=${exp}`;
  }

  async remove(bucket: string, key: string): Promise<void> {
    this.objects.delete(this.id(bucket, key));
  }
}
