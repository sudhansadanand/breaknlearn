/** Server-side envelope checks beyond the JSON schema (M07). Pure: the caller supplies the device scope. */
import {
  LearningEvent,
  TELEMETRY_MAX_FUTURE_SKEW_MS,
  TELEMETRY_MAX_OFFLINE_HOURS,
  type LearningEvent as Event,
} from "@bnl/contracts";
import { z } from "zod";

type RejectionCode = z.infer<typeof import("@bnl/contracts").RejectionCode>;

export interface DeviceScope {
  readonly deviceId: string;
  /** Learner ids that belong to the device's household (server-derived, never from the client). */
  readonly learnerIds: ReadonlySet<string>;
  /** Lesson ids that exist (any version); unknown ids are rejected. */
  readonly knownLessonIds: ReadonlySet<string>;
}

export type Checked = { ok: true; event: Event } | { ok: false; event_id: string | null; code: RejectionCode };

export function checkEvent(raw: unknown, scope: DeviceScope, now: Date): Checked {
  const parsed = LearningEvent.safeParse(raw);
  const rawId = typeof raw === "object" && raw !== null && "event_id" in raw ? String((raw as { event_id: unknown }).event_id) : null;
  const idOrNull = rawId && z.string().uuid().safeParse(rawId).success ? rawId : null;
  if (!parsed.success) return { ok: false, event_id: idOrNull, code: "schema_invalid" };
  const e = parsed.data;
  if (e.device_id !== scope.deviceId) return { ok: false, event_id: e.event_id, code: "device_mismatch" };
  if (!scope.learnerIds.has(e.learner_id)) return { ok: false, event_id: e.event_id, code: "learner_not_in_household" };
  if (e.lesson_id && !scope.knownLessonIds.has(e.lesson_id)) return { ok: false, event_id: e.event_id, code: "lesson_unknown" };
  const occurred = Date.parse(e.occurred_at);
  if (occurred - now.getTime() > TELEMETRY_MAX_FUTURE_SKEW_MS) return { ok: false, event_id: e.event_id, code: "clock_skew_future" };
  if (now.getTime() - occurred > TELEMETRY_MAX_OFFLINE_HOURS * 3_600_000) return { ok: false, event_id: e.event_id, code: "too_old" };
  if (Date.parse(e.sent_at) + TELEMETRY_MAX_FUTURE_SKEW_MS < occurred) return { ok: false, event_id: e.event_id, code: "clock_skew_future" };
  return { ok: true, event: e };
}
