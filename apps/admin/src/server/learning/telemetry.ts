/**
 * POST /api/v1/telemetry/batch (M07, spec §7). Device credential only; household is derived from
 * the verified token. Each event is validated against server-derived scope; accepted events are
 * inserted once (`on conflict (event_id) do nothing`), duplicates and rejections are acknowledged
 * per event, rejected events are never stored. Sessions are upserted per (device, client_session_id);
 * time totals are recomputed by the session aggregation job.
 */
import { HttpError } from "@bnl/auth";
import { TELEMETRY_BATCH_MAX, TELEMETRY_BATCH_MAX_BYTES, TelemetryAck } from "@bnl/contracts";
import { triageBatch, type AcceptedEvent } from "@bnl/telemetry";
import { verifyDeviceBearer, withDevice } from "../authn";
import { json, validationFailed, type Ctx } from "../http";
import { requireDeviceConsent } from "../privacy/gate";
import { enforceLearningRateLimit, readBoundedJson, requireIdempotencyKey, telemetryEnabled, uniqueUuids } from "./common";
import { REPLAY_HEADER, idempotent, requestSha } from "./idempotency";
import { learningRepo, type EventInsert, type SessionUpsert } from "./index";

function eventsOf(body: unknown): unknown[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw validationFailed([{ path: [], code: "invalid_type" }]);
  const keys = Object.keys(body);
  if (keys.some((k) => k !== "events")) throw validationFailed([{ path: [], code: "unrecognized_keys" }]);
  const events = (body as { events?: unknown }).events;
  if (!Array.isArray(events)) throw validationFailed([{ path: ["events"], code: "invalid_type" }]);
  if (events.length === 0) throw validationFailed([{ path: ["events"], code: "too_small" }]);
  if (events.length > TELEMETRY_BATCH_MAX) {
    throw new HttpError(413, "payload_too_large", `At most ${TELEMETRY_BATCH_MAX} events per batch`, { max_events: TELEMETRY_BATCH_MAX });
  }
  return events;
}

const field = (raw: unknown, name: string): unknown => (typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)[name] : undefined);

function sessionsFrom(accepted: readonly AcceptedEvent[], householdId: string, deviceId: string, bound: ReadonlyMap<string, string>): SessionUpsert[] {
  const by = new Map<string, { learner: string; start: number; end: number | null }>();
  for (const { event: e } of accepted) {
    const at = Date.parse(e.occurred_at);
    const cur = by.get(e.client_session_id) ?? { learner: bound.get(e.client_session_id) ?? e.learner_id, start: at, end: null };
    cur.start = Math.min(cur.start, at);
    if (e.event_type === "session_ended") cur.end = Math.max(cur.end ?? at, at);
    by.set(e.client_session_id, cur);
  }
  return [...by].map(([clientSessionId, s]) => ({
    householdId,
    learnerId: s.learner,
    deviceId,
    clientSessionId,
    startedAt: new Date(s.start),
    endedAt: s.end === null ? null : new Date(s.end),
  }));
}

export async function telemetryBatchHandler(req: Request, c: Ctx): Promise<Response> {
  // Fail closed: ingestion is off unless explicitly enabled (spec §10.5 gradual exposure).
  if (!telemetryEnabled()) throw new HttpError(503, "feature_disabled", "Telemetry ingestion is not enabled");
  const claims = await verifyDeviceBearer(req, c);
  const key = requireIdempotencyKey(req);
  await enforceLearningRateLimit(c, "telemetryByDevice", claims.sub);
  const body = await readBoundedJson(req, TELEMETRY_BATCH_MAX_BYTES);
  const events = eventsOf(body);
  const now = c.deps.now();
  const repo = learningRepo();
  const householdId = claims.hid;
  const deviceId = claims.sub;

  const result = await withDevice(c, claims, async (sql) => {
    // A9-PRIV-01: checked before the replay cache, so a withdrawal stops ingestion on the very next batch.
    await requireDeviceConsent(sql, ["learning_data", "telemetry"]);
    return idempotent(sql, repo, { scope: "telemetry.batch", key, ownerId: deviceId, householdId, requestSha256: requestSha(body), now }, async () => {
      const [learners, lessons, versions] = await Promise.all([
        repo.learnerIdsInHousehold(sql, householdId),
        repo.knownLessonIds(sql, uniqueUuids(events.map((e) => field(e, "lesson_id")))),
        repo.knownVersions(sql, uniqueUuids(events.map((e) => field(e, "lesson_version_id")))),
      ]);
      const sessionIds = uniqueUuids(events.map((e) => field(e, "client_session_id")));
      const [storedIds, storedSequences, sessionLearners] = await Promise.all([
        repo.storedEventIds(sql, uniqueUuids(events.map((e) => field(e, "event_id")))),
        repo.storedSequences(sql, deviceId, sessionIds),
        repo.sessionLearners(sql, deviceId, sessionIds),
      ]);
      const triage = triageBatch({
        events,
        scope: { deviceId, learnerIds: new Set(learners), knownLessonIds: new Set(lessons), lessonVersions: versions },
        now,
        storedEventIds: new Set(storedIds),
        storedSequences,
        sessionLearners,
      });

      const sessionRowIds = await repo.upsertSessions(sql, sessionsFrom(triage.accepted, householdId, deviceId, sessionLearners));
      const rows: EventInsert[] = triage.accepted.map(({ event: e, quality_flag }) => {
        const sessionId = sessionRowIds.get(e.client_session_id);
        if (!sessionId) throw new Error("session upsert returned no id");
        return {
          eventId: e.event_id,
          householdId,
          learnerId: e.learner_id,
          deviceId,
          sessionId,
          clientSessionId: e.client_session_id,
          clientSequence: e.client_sequence,
          eventType: e.event_type,
          schemaVersion: e.schema_version,
          lessonId: e.lesson_id ?? null,
          lessonVersionId: e.lesson_version_id ?? null,
          slideId: e.slide_id ?? null,
          occurredAt: e.occurred_at,
          sentAt: e.sent_at,
          receivedAt: now,
          payload: e.payload,
          qualityFlag: quality_flag,
        };
      });
      const inserted = new Set(await repo.insertEvents(sql, rows));
      // An id that lost the insert race (or already exists outside this household) is a duplicate, never re-stored.
      const lateDuplicates = rows.filter((r) => !inserted.has(r.eventId)).map((r) => r.eventId);
      const ack = TelemetryAck.parse({
        accepted: rows.filter((r) => inserted.has(r.eventId)).map((r) => r.eventId),
        duplicates: [...triage.duplicates, ...lateDuplicates],
        rejected: triage.rejected,
      });
      return { status: 200, body: ack };
    });
  });
  return json(c, result.body, result.status, result.replayed ? { [REPLAY_HEADER]: "true" } : {});
}
