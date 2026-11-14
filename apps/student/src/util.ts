/**
 * ES5-safe helpers shared by the student bundle. Everything here must run on old LG webOS
 * engines: no Promise, no TextEncoder, no WebCrypto assumptions, no ES2015 built-ins.
 */

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** In-memory store used when localStorage is unavailable (private mode, quota, tests). */
export function memoryStore(): KeyValueStore {
  const data: { [k: string]: string | undefined } = {};
  return {
    getItem: function (k) {
      const v = Object.prototype.hasOwnProperty.call(data, k) ? data[k] : undefined;
      return v === undefined ? null : v;
    },
    setItem: function (k, v) {
      data[k] = String(v);
    },
    removeItem: function (k) {
      data[k] = undefined;
    },
  };
}

/** localStorage wrapped so that every access failure degrades instead of throwing. */
export function safeStore(backing: KeyValueStore | null): KeyValueStore {
  const fallback = memoryStore();
  return {
    getItem: function (k) {
      try {
        return backing ? backing.getItem(k) : fallback.getItem(k);
      } catch {
        return fallback.getItem(k);
      }
    },
    setItem: function (k, v) {
      try {
        if (backing) backing.setItem(k, v);
        else fallback.setItem(k, v);
      } catch {
        fallback.setItem(k, v);
      }
    },
    removeItem: function (k) {
      try {
        if (backing) backing.removeItem(k);
      } catch {
        /* ignore */
      }
      fallback.removeItem(k);
    },
  };
}

export function isArray(x: unknown): x is unknown[] {
  return Object.prototype.toString.call(x) === "[object Array]";
}

export function isObject(x: unknown): x is { [k: string]: unknown } {
  return x !== null && typeof x === "object" && !isArray(x);
}

/** JSON.parse that never throws; returns `d` for missing or corrupt values. */
export function parseJson(text: string | null, d: unknown): unknown {
  if (text === null || text === undefined || text === "") return d;
  try {
    const x = JSON.parse(text);
    return x === null ? d : x;
  } catch {
    return d;
  }
}

export function readJson(store: KeyValueStore, key: string, d: unknown): unknown {
  return parseJson(store.getItem(key), d);
}

export function writeJson(store: KeyValueStore, key: string, v: unknown): boolean {
  try {
    store.setItem(key, JSON.stringify(v));
    return true;
  } catch {
    return false;
  }
}

/**
 * Canonical JSON with sorted keys, identical to `canonicalJson` in @bnl/student-progress
 * (undefined members skipped). Used for the legacy fingerprint.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (isArray(value)) {
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) parts.push(canonicalJson(value[i]));
    return "[" + parts.join(",") + "]";
  }
  const obj = value as { [k: string]: unknown };
  const keys = Object.keys(obj).sort();
  const out: string[] = [];
  for (let j = 0; j < keys.length; j++) {
    const k = keys[j];
    if (obj[k] === undefined) continue;
    out.push(JSON.stringify(k) + ":" + canonicalJson(obj[k]));
  }
  return "{" + out.join(",") + "}";
}

/** UTF-8 bytes of a JS string without TextEncoder. */
export function utf8Bytes(s: string): number[] {
  const bin = unescape(encodeURIComponent(s));
  const out: number[] = [];
  for (let i = 0; i < bin.length; i++) out.push(bin.charCodeAt(i));
  return out;
}

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** SHA-256 hex of the UTF-8 encoding of `text` (pure JS; same result as WebCrypto/node:crypto). */
export function sha256Hex(text: string): string {
  const bytes = utf8Bytes(text);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w: number[] = new Array(64);
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = (bytes[off + i * 4] << 24) | (bytes[off + i * 4 + 1] << 16) | (bytes[off + i * 4 + 2] << 8) | bytes[off + i * 4 + 3];
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0;
    H[1] = (H[1] + b) | 0;
    H[2] = (H[2] + c) | 0;
    H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0;
    H[5] = (H[5] + f) | 0;
    H[6] = (H[6] + g) | 0;
    H[7] = (H[7] + h) | 0;
  }
  let hex = "";
  for (let i = 0; i < 8; i++) hex += ("00000000" + (H[i] >>> 0).toString(16)).slice(-8);
  return hex;
}

interface CryptoLike {
  getRandomValues(a: Uint8Array): Uint8Array;
}

/** RFC 4122 v4 UUID; uses crypto.getRandomValues when the engine has it. */
export function uuid4(random?: () => number): string {
  const b: number[] = [];
  const g = typeof window !== "undefined" ? (window as unknown as { crypto?: CryptoLike }).crypto : undefined;
  if (!random && g && typeof g.getRandomValues === "function" && typeof Uint8Array !== "undefined") {
    const arr = new Uint8Array(16);
    g.getRandomValues(arr);
    for (let i = 0; i < 16; i++) b.push(arr[i]);
  } else {
    const r = random || Math.random;
    for (let i = 0; i < 16; i++) b.push(Math.floor(r() * 256) & 255);
  }
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  let s = "";
  for (let i = 0; i < 16; i++) {
    s += ("0" + b[i].toString(16)).slice(-2);
    if (i === 3 || i === 5 || i === 7 || i === 9) s += "-";
  }
  return s;
}

export function isUuid(x: unknown): x is string {
  return typeof x === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
}

/** ISO-8601 UTC without relying on Date.prototype.toISOString quirks. */
export function isoNow(ms: number): string {
  const d = new Date(ms);
  const p = function (n: number, w: number) {
    let s = String(n);
    while (s.length < w) s = "0" + s;
    return s;
  };
  return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1, 2) + "-" + p(d.getUTCDate(), 2) + "T" + p(d.getUTCHours(), 2) + ":" + p(d.getUTCMinutes(), 2) + ":" + p(d.getUTCSeconds(), 2) + "." + p(d.getUTCMilliseconds(), 3) + "Z";
}

export function indexOf<T>(list: readonly T[], x: T): number {
  for (let i = 0; i < list.length; i++) if (list[i] === x) return i;
  return -1;
}

/** Copy of `obj` without `key` (avoids dynamic `delete`). */
export function without<T>(obj: { [k: string]: T }, key: string): { [k: string]: T } {
  const out: { [k: string]: T } = {};
  for (const k in obj) if (Object.prototype.hasOwnProperty.call(obj, k) && k !== key) out[k] = obj[k];
  return out;
}
