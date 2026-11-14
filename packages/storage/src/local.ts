import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import {
  StorageError,
  assertValidBucket,
  assertValidKey,
  assertValidTtl,
  type StoragePort,
} from "./port";

export interface LocalFsStorageOptions {
  /** HMAC key for signed URLs (at least 32 bytes). */
  readonly signingKey: Uint8Array;
  /** Absolute or same-origin URL of the route that serves signed local objects. */
  readonly baseUrl: string;
  readonly now?: () => Date;
}

export interface SignedObjectRef {
  readonly bucket: string;
  readonly key: string;
}

const MIN_SIGNING_KEY_BYTES = 32;

function signature(key: Uint8Array, bucket: string, objectKey: string, exp: number): string {
  return createHmac("sha256", key).update(`bnl-local-storage/v1\n${bucket}\n${objectKey}\n${exp}`).digest("base64url");
}

/**
 * Filesystem-backed storage for local development and tests. Every resolved path must stay under
 * `rootDir/<bucket>/`; keys are validated before any filesystem call and symlinks are never followed.
 * Signed URLs are HMAC-signed local URLs with an expiry; serve them only through a route that calls
 * {@link LocalFsStorage.verifySignedUrl}.
 */
export class LocalFsStorage implements StoragePort {
  private readonly root: string;
  private readonly signingKey: Uint8Array;
  private readonly baseUrl: string;
  private readonly now: () => Date;

  constructor(rootDir: string, options: LocalFsStorageOptions) {
    if (!isAbsolute(rootDir)) throw new StorageError("invalid_key", "LocalFsStorage rootDir must be absolute");
    if (options.signingKey.byteLength < MIN_SIGNING_KEY_BYTES) {
      throw new StorageError("invalid_key", `LocalFsStorage signing key must be at least ${MIN_SIGNING_KEY_BYTES} bytes`);
    }
    this.root = resolve(rootDir);
    this.signingKey = options.signingKey;
    this.baseUrl = options.baseUrl;
    this.now = options.now ?? (() => new Date());
  }

  /** Resolves bucket/key to a path under the root, or throws. */
  pathFor(bucket: string, key: string): string {
    assertValidBucket(bucket);
    assertValidKey(key);
    const bucketDir = resolve(this.root, bucket);
    const full = resolve(bucketDir, key);
    if (!full.startsWith(bucketDir + sep) || !bucketDir.startsWith(this.root + sep)) {
      throw new StorageError("invalid_key", "Storage key escapes the bucket");
    }
    return full;
  }

  /** Refuses to traverse symlinks anywhere between the bucket directory and the object. */
  private async assertNoSymlinks(bucket: string, full: string): Promise<void> {
    const bucketDir = resolve(this.root, bucket);
    let current = full;
    while (current.length > bucketDir.length) {
      const st = await lstat(current).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return null;
        throw err;
      });
      if (st?.isSymbolicLink()) throw new StorageError("invalid_key", "Storage path contains a symlink");
      current = dirname(current);
    }
  }

  async put(bucket: string, key: string, bytes: Uint8Array, _contentType: string): Promise<void> {
    const full = this.pathFor(bucket, key);
    await this.assertNoSymlinks(bucket, full);
    await mkdir(dirname(full), { recursive: true, mode: 0o700 });
    const tmp = `${full}.${randomBytes(8).toString("hex")}.tmp`;
    const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let moved = false;
    try {
      await fh.writeFile(bytes);
      await fh.close();
      // Never overwrite: link-free check then rename (single-process dev/test use).
      const existing = await lstat(full).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return null;
        throw err;
      });
      if (existing) throw new StorageError("exists", "Object already exists");
      await rename(tmp, full);
      moved = true;
    } finally {
      if (!moved) await rm(tmp, { force: true });
    }
  }

  async get(bucket: string, key: string): Promise<Uint8Array | null> {
    const full = this.pathFor(bucket, key);
    await this.assertNoSymlinks(bucket, full);
    const fh = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    if (!fh) return null;
    try {
      return new Uint8Array(await fh.readFile());
    } finally {
      await fh.close();
    }
  }

  async signedUrl(bucket: string, key: string, ttlSeconds: number): Promise<string> {
    this.pathFor(bucket, key);
    assertValidTtl(ttlSeconds);
    const exp = Math.floor(this.now().getTime() / 1000) + ttlSeconds;
    const q = new URLSearchParams({ b: bucket, k: key, e: String(exp), s: signature(this.signingKey, bucket, key, exp) });
    return `${this.baseUrl}?${q.toString()}`;
  }

  /** Validates a signed URL's query; null when tampered, malformed or expired. */
  verifySignedUrl(query: URLSearchParams): SignedObjectRef | null {
    const bucket = query.get("b");
    const key = query.get("k");
    const e = query.get("e");
    const s = query.get("s");
    if (!bucket || !key || !e || !s || !/^[0-9]{1,12}$/.test(e)) return null;
    try {
      this.pathFor(bucket, key);
    } catch (err) {
      if (err instanceof StorageError) return null;
      throw err;
    }
    const exp = Number(e);
    if (exp * 1000 <= this.now().getTime()) return null;
    const expected = Buffer.from(signature(this.signingKey, bucket, key, exp));
    const given = Buffer.from(s);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    return { bucket, key };
  }

  async remove(bucket: string, key: string): Promise<void> {
    const full = this.pathFor(bucket, key);
    await this.assertNoSymlinks(bucket, full);
    await unlink(full).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });
  }
}
