/**
 * Private object storage port. Keys are always `<household or owner uuid>/<generated name>`;
 * caller-supplied filenames never become keys (spec §9: never expose uploader filenames).
 */
export interface StoragePort {
  /** Stores a new object. Never overwrites an existing key (throws StorageError `exists`). */
  put(bucket: string, key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** The object's bytes, or null when it does not exist. */
  get(bucket: string, key: string): Promise<Uint8Array | null>;
  /** A short-lived URL that lets the holder download the object once authorised by the server. */
  signedUrl(bucket: string, key: string, ttlSeconds: number): Promise<string>;
  /** Deletes the object; a missing object is not an error. */
  remove(bucket: string, key: string): Promise<void>;
}

export type StorageErrorCode = "invalid_key" | "invalid_bucket" | "exists" | "upstream" | "invalid_ttl";

export class StorageError extends Error {
  override readonly name = "StorageError";
  constructor(
    readonly code: StorageErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** `<uuid>/<path>`; the uuid prefix scopes the object to one household (or owner). */
export const KEY_PATTERN = /^[a-f0-9-]{36}\/[A-Za-z0-9._/-]+$/;
export const BUCKET_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
export const MAX_KEY_LENGTH = 512;
export const MAX_SIGNED_URL_TTL_SECONDS = 3600;

/** Rejects anything that could escape the bucket: `..`, empty or dot segments, absolute paths, odd characters. */
export function assertValidKey(key: string): void {
  if (typeof key !== "string" || key.length > MAX_KEY_LENGTH || !KEY_PATTERN.test(key)) {
    throw new StorageError("invalid_key", "Storage key is not valid");
  }
  const segments = key.split("/");
  for (const s of segments) {
    if (s === "" || s === "." || s === ".." || s.startsWith(".")) throw new StorageError("invalid_key", "Storage key is not valid");
  }
}

export function assertValidBucket(bucket: string): void {
  if (typeof bucket !== "string" || !BUCKET_PATTERN.test(bucket)) throw new StorageError("invalid_bucket", "Bucket name is not valid");
}

export function assertValidTtl(ttlSeconds: number): void {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_SIGNED_URL_TTL_SECONDS) {
    throw new StorageError("invalid_ttl", `Signed URL TTL must be 1..${MAX_SIGNED_URL_TTL_SECONDS} seconds`);
  }
}
