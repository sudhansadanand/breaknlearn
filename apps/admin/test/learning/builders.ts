/** Request/event builders shared by the learning route tests (fakes) and real-DB integration tests. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { LearningEvent } from "@bnl/contracts";
import { legacyFingerprint } from "@bnl/student-progress";
import { ORIGIN } from "../fakes";

export interface DeviceReq {
  bearer?: string;
  idempotencyKey?: string | null;
  body?: unknown;
  rawBody?: string;
  contentType?: string;
  session?: string;
}

export function deviceRequest(method: string, path: string, o: DeviceReq = {}): Request {
  const headers = new Headers({ "x-forwarded-for": "203.0.113.9" });
  if (o.bearer) headers.set("authorization", `Bearer ${o.bearer}`);
  if (o.session) headers.set("cookie", `bnl_admin_session=${o.session}`);
  const key = o.idempotencyKey === undefined ? `idem-${randomUUID()}` : o.idempotencyKey;
  if (key !== null) headers.set("Idempotency-Key", key);
  let body: string | undefined;
  if (o.rawBody !== undefined || o.body !== undefined) {
    headers.set("content-type", o.contentType ?? "application/json");
    body = o.rawBody ?? JSON.stringify(o.body);
  }
  return new Request(`${ORIGIN}${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
}

export interface EventCtx {
  deviceId: string;
  learnerId: string;
  sessionId: string;
  lessonId?: string;
  base: number;
}

export function makeEvent(
  ctx: EventCtx,
  type: LearningEvent["event_type"],
  seq: number,
  payload: LearningEvent["payload"] = {},
  extra: Partial<LearningEvent> = {},
): LearningEvent {
  const at = new Date(ctx.base + seq * 1000).toISOString();
  return {
    event_id: randomUUID(),
    schema_version: 1,
    event_type: type,
    occurred_at: at,
    sent_at: at,
    client_session_id: ctx.sessionId,
    client_sequence: seq,
    learner_id: ctx.learnerId,
    device_id: ctx.deviceId,
    ...(ctx.lessonId ? { lesson_id: ctx.lessonId } : {}),
    payload,
    ...extra,
  };
}

export const heartbeat = (foreground: boolean, playing: boolean, visible: number, playback: number) => ({
  foreground,
  playing,
  visible_ms: visible,
  playback_ms: playback,
});

/** A legacy fixture's three localStorage keys (the `_comment` documentation key is not device data). */
export function legacyFixture(name: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../tests/fixtures/legacy/${name}`, import.meta.url)), "utf8")) as Record<string, unknown>;
  return {
    "breaknlearn.profiles.v1": parsed["breaknlearn.profiles.v1"] ?? null,
    "breaknlearn.progress.v1": parsed["breaknlearn.progress.v1"] ?? null,
    "learnbreak-x3-v4-progress": parsed["learnbreak-x3-v4-progress"] ?? null,
  };
}

export async function legacyBody(raw: Record<string, unknown>, mapping: { local_profile_id: string; learner_id: string }[], extra: Record<string, unknown> = {}) {
  return { migration_run_id: randomUUID(), legacy_fingerprint: await legacyFingerprint(raw), raw, profile_mapping: mapping, ...extra };
}
