import { createHash } from "node:crypto";

/** RFC 4122 version-5 (SHA-1, name-based) UUID; deterministic so re-imports address the same rows. */
export function uuidV5(namespace: string, name: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  if (ns.length !== 16) throw new Error("uuidV5: namespace must be a UUID");
  const hash = createHash("sha1").update(ns).update(name, "utf8").digest();
  const b = hash.subarray(0, 16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x50;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Namespace for legacy-import attempt ids (A6). Fixed forever: changing it would duplicate imports. */
export const LEGACY_ATTEMPT_NAMESPACE = "3a6f0c52-6d1b-4f7e-9b0a-6a6c2f1e5d01";

/** One legacy attempt per (learner, lesson, theme), independent of the run, so any re-import merges (MIG-004). */
export function legacyAttemptId(learnerId: string, lessonId: string, themeKey: string): string {
  return uuidV5(LEGACY_ATTEMPT_NAMESPACE, `legacy-import:${learnerId}:${lessonId}:${themeKey}`);
}
