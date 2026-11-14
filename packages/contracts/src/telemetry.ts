import { z } from "zod";
import { IsoDateTime, Uuid } from "./common";
import { ThemeKey } from "./catalog";

export const EVENT_SCHEMA_VERSION = 1 as const;

export const EventType = z.enum([
  "app_opened",
  "profile_selected",
  "session_started",
  "lesson_started",
  "slide_entered",
  "slide_exited",
  "playback_paused",
  "playback_resumed",
  "playback_heartbeat",
  "quiz_started",
  "answer_submitted",
  "quiz_completed",
  "lesson_completed",
  "session_ended",
  "app_hidden",
  "sync_failed",
  "sync_succeeded",
]);
export type EventType = z.infer<typeof EventType>;

/** Max contribution of one heartbeat interval (spec §7). */
export const HEARTBEAT_CAP_MS = 30_000;

/**
 * Closed payload. No names, no free text. `is_correct` is intentionally absent:
 * correctness is computed server-side only (TEL-005).
 */
export const EventPayload = z
  .object({
    foreground: z.boolean(),
    playing: z.boolean(),
    visible_ms: z.number().int().min(0).max(HEARTBEAT_CAP_MS),
    playback_ms: z.number().int().min(0).max(HEARTBEAT_CAP_MS),
    theme_key: ThemeKey,
    slide_index: z.number().int().min(1).max(50),
    quiz_attempt_id: Uuid,
    attempt_stage: z.enum(["baseline", "immediate", "delayed"]),
    question_version_key: z.string().max(128),
    selected_option_id: z.string().max(128),
    reason_code: z.string().max(64).regex(/^[a-z0-9_]+$/),
  })
  .partial()
  .strict();

export const LearningEvent = z
  .object({
    event_id: Uuid,
    schema_version: z.literal(EVENT_SCHEMA_VERSION),
    event_type: EventType,
    occurred_at: IsoDateTime,
    sent_at: IsoDateTime,
    client_session_id: Uuid,
    client_sequence: z.number().int().min(0),
    learner_id: Uuid,
    device_id: Uuid,
    lesson_id: Uuid.optional(),
    lesson_version_id: Uuid.optional(),
    slide_id: z.string().max(128).optional(),
    payload: EventPayload,
  })
  .strict();
export type LearningEvent = z.infer<typeof LearningEvent>;

export const TELEMETRY_BATCH_MAX = 100;
export const TELEMETRY_BATCH_MAX_BYTES = 128 * 1024;
export const TELEMETRY_MAX_OFFLINE_HOURS = 72;
export const TELEMETRY_MAX_FUTURE_SKEW_MS = 5 * 60_000;
export const CLIENT_FLUSH_EVERY_EVENTS = 25;
export const CLIENT_FLUSH_EVERY_MS = 30_000;

export const TelemetryBatch = z.object({
  events: z.array(LearningEvent).min(1).max(TELEMETRY_BATCH_MAX),
});

export const RejectionCode = z.enum([
  "schema_invalid",
  "learner_not_in_household",
  "device_mismatch",
  "clock_skew_future",
  "too_old",
  "duration_out_of_range",
  "lesson_unknown",
  "sequence_regression",
]);

export const TelemetryAck = z.object({
  accepted: z.array(Uuid),
  duplicates: z.array(Uuid),
  rejected: z.array(z.object({ event_id: Uuid.nullable(), code: RejectionCode })),
});
export type TelemetryAck = z.infer<typeof TelemetryAck>;
