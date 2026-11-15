import type { Sql } from "../db-port";
import type { LearningRepo, ProgressRow } from "./repo";

type JsonParam = Parameters<Sql["json"]>[0];
const json = (sql: Sql, v: unknown) => sql.json(v as JsonParam);
const uuids = (sql: Sql, ids: readonly string[]) => sql.array([...ids]);

/** bnl.learner_progress; numeric/bigint cast so postgres.js returns JS numbers. */
const PROGRESS_COLS = `id, learner_id as "learnerId", lesson_id as "lessonId", lesson_version_id as "lessonVersionId",
  theme_key as "themeKey", attempt_id as "attemptId", slide_id as "slideId", position_seconds::float8 as "positionSeconds",
  completed, client_revision as "clientRevision", server_revision::int4 as "serverRevision", updated_at as "updatedAt"`;

const IDEMPOTENCY_TTL_HOURS = 24;

export const sqlLearningRepo: LearningRepo = {
  async claimIdempotency(sql, c) {
    const inserted = await sql<{ id: string }[]>`
      insert into bnl.idempotency_keys (key, scope, actor_or_device, household_id, request_sha256, expires_at)
      values (${c.key}, ${c.scope}, ${c.ownerId}, ${c.householdId}, ${c.requestSha256},
              ${new Date(c.now.getTime() + IDEMPOTENCY_TTL_HOURS * 3_600_000)})
      on conflict (scope, actor_or_device, key) do nothing
      returning id`;
    if (inserted.length > 0) return { kind: "new" };
    // A concurrent holder of the same key blocks the insert above until it commits, so the row is final here.
    const [row] = await sql<{ id: string; request_sha256: string; response: unknown; status_code: number | null; expires_at: Date }[]>`
      select id, request_sha256, response, status_code, expires_at from bnl.idempotency_keys
       where scope = ${c.scope} and actor_or_device = ${c.ownerId} and key = ${c.key}
       for update`;
    if (!row) throw new Error("idempotency key vanished after conflict");
    if (new Date(row.expires_at).getTime() <= c.now.getTime()) {
      await sql`
        update bnl.idempotency_keys
           set request_sha256 = ${c.requestSha256}, response = null, status_code = null,
               expires_at = ${new Date(c.now.getTime() + IDEMPOTENCY_TTL_HOURS * 3_600_000)}
         where id = ${row.id}`;
      return { kind: "new" };
    }
    if (row.request_sha256 !== c.requestSha256 || row.status_code === null) return { kind: "mismatch" };
    return { kind: "replay", status: row.status_code, body: row.response };
  },

  async completeIdempotency(sql, c) {
    await sql`
      update bnl.idempotency_keys set response = ${json(sql, c.body)}, status_code = ${c.status}
       where scope = ${c.scope} and actor_or_device = ${c.ownerId} and key = ${c.key}`;
  },

  async learnerIdsInHousehold(sql, householdId) {
    const rows = await sql<{ id: string }[]>`select id from bnl.learner_profiles where household_id = ${householdId}`;
    return rows.map((r) => r.id);
  },

  async knownLessonIds(sql, ids) {
    if (ids.length === 0) return [];
    const rows = await sql<{ id: string }[]>`select id from bnl.lessons where id = any(${uuids(sql, ids)}::uuid[])`;
    return rows.map((r) => r.id);
  },

  async knownVersions(sql, ids) {
    if (ids.length === 0) return new Map();
    const rows = await sql<{ id: string; lesson_id: string }[]>`
      select id, lesson_id from bnl.lesson_versions where id = any(${uuids(sql, ids)}::uuid[])`;
    return new Map(rows.map((r) => [r.id, r.lesson_id]));
  },

  async storedEventIds(sql, ids) {
    if (ids.length === 0) return [];
    const rows = await sql<{ event_id: string }[]>`
      select event_id from bnl.learning_events where event_id = any(${uuids(sql, ids)}::uuid[])`;
    return rows.map((r) => r.event_id);
  },

  async storedSequences(sql, deviceId, clientSessionIds) {
    if (clientSessionIds.length === 0) return [];
    return sql<{ client_session_id: string; client_sequence: number; event_id: string }[]>`
      select client_session_id, client_sequence::float8 as client_sequence, event_id from bnl.learning_events
       where device_id = ${deviceId} and client_session_id = any(${uuids(sql, clientSessionIds)}::uuid[])`;
  },

  async sessionLearners(sql, deviceId, clientSessionIds) {
    if (clientSessionIds.length === 0) return new Map();
    const rows = await sql<{ client_session_id: string; learner_id: string }[]>`
      select client_session_id, learner_id from bnl.learning_sessions
       where device_id = ${deviceId} and client_session_id = any(${uuids(sql, clientSessionIds)}::uuid[])`;
    return new Map(rows.map((r) => [r.client_session_id, r.learner_id]));
  },

  async upsertSessions(sql, rows) {
    if (rows.length === 0) return new Map();
    const payload = rows.map((r) => ({
      household_id: r.householdId,
      learner_id: r.learnerId,
      device_id: r.deviceId,
      client_session_id: r.clientSessionId,
      started_at: r.startedAt.toISOString(),
      ended_at: r.endedAt ? r.endedAt.toISOString() : null,
    }));
    const out = await sql<{ id: string; client_session_id: string }[]>`
      insert into bnl.learning_sessions as s (household_id, learner_id, device_id, client_session_id, started_at, ended_at)
      select household_id, learner_id, device_id, client_session_id, started_at, ended_at
        from jsonb_to_recordset(${json(sql, payload)}::jsonb)
          as r(household_id uuid, learner_id uuid, device_id uuid, client_session_id uuid, started_at timestamptz, ended_at timestamptz)
      on conflict (device_id, client_session_id) do update
         set started_at = least(s.started_at, excluded.started_at),
             ended_at = greatest(s.ended_at, excluded.ended_at)
      returning id, client_session_id`;
    return new Map(out.map((r) => [r.client_session_id, r.id]));
  },

  async insertEvents(sql, rows) {
    if (rows.length === 0) return [];
    const payload = rows.map((r) => ({
      event_id: r.eventId,
      household_id: r.householdId,
      learner_id: r.learnerId,
      device_id: r.deviceId,
      session_id: r.sessionId,
      client_session_id: r.clientSessionId,
      client_sequence: r.clientSequence,
      event_type: r.eventType,
      schema_version: r.schemaVersion,
      lesson_id: r.lessonId,
      lesson_version_id: r.lessonVersionId,
      slide_id: r.slideId,
      occurred_at: r.occurredAt,
      sent_at: r.sentAt,
      received_at: r.receivedAt.toISOString(),
      payload: r.payload,
      quality_flag: r.qualityFlag,
    }));
    const out = await sql<{ event_id: string }[]>`
      insert into bnl.learning_events (event_id, household_id, learner_id, device_id, session_id, client_session_id,
        client_sequence, event_type, schema_version, lesson_id, lesson_version_id, slide_id, occurred_at, sent_at,
        received_at, payload, quality_flag)
      select event_id, household_id, learner_id, device_id, session_id, client_session_id, client_sequence, event_type,
             schema_version, lesson_id, lesson_version_id, slide_id, occurred_at, sent_at, received_at, payload, quality_flag
        from jsonb_to_recordset(${json(sql, payload)}::jsonb)
          as r(event_id uuid, household_id uuid, learner_id uuid, device_id uuid, session_id uuid, client_session_id uuid,
               client_sequence bigint, event_type text, schema_version smallint, lesson_id uuid, lesson_version_id uuid,
               slide_id text, occurred_at timestamptz, sent_at timestamptz, received_at timestamptz, payload jsonb,
               quality_flag text)
      on conflict (event_id) do nothing
      returning event_id`;
    return out.map((r) => r.event_id);
  },

  async getProgressForUpdate(sql, k) {
    const rows = await sql<ProgressRow[]>`
      select ${sql.unsafe(PROGRESS_COLS)} from bnl.learner_progress
       where learner_id = ${k.learnerId} and lesson_id = ${k.lessonId} and theme_key = ${k.themeKey} and attempt_id = ${k.attemptId}
       for update`;
    return rows[0] ?? null;
  },

  async progressForLearners(sql, learnerIds, lessonIds) {
    if (learnerIds.length === 0 || lessonIds.length === 0) return [];
    return sql<ProgressRow[]>`
      select ${sql.unsafe(PROGRESS_COLS)} from bnl.learner_progress
       where learner_id = any(${uuids(sql, learnerIds)}::uuid[]) and lesson_id = any(${uuids(sql, lessonIds)}::uuid[])
       for update`;
  },

  async insertProgress(sql, w) {
    const rows = await sql<ProgressRow[]>`
      insert into bnl.learner_progress (household_id, learner_id, lesson_id, lesson_version_id, theme_key, attempt_id,
        slide_id, position_seconds, completed, client_revision)
      values (${w.householdId}, ${w.learnerId}, ${w.lessonId}, ${w.lessonVersionId}, ${w.themeKey}, ${w.attemptId},
              ${w.slideId}, ${w.positionSeconds}, ${w.completed}, ${w.clientRevision})
      on conflict (learner_id, lesson_id, theme_key, attempt_id) do nothing
      returning ${sql.unsafe(PROGRESS_COLS)}`;
    return rows[0] ?? null;
  },

  async updateProgress(sql, id, expectedServerRevision, w) {
    // The row trigger bumps server_revision and keeps completion monotonic (ADR-0005 #4).
    const rows = await sql<ProgressRow[]>`
      update bnl.learner_progress
         set lesson_version_id = coalesce(${w.lessonVersionId}::uuid, lesson_version_id), slide_id = ${w.slideId},
             position_seconds = ${w.positionSeconds}, completed = ${w.completed}, client_revision = ${w.clientRevision}
       where id = ${id} and household_id = ${w.householdId} and server_revision = ${expectedServerRevision}
       returning ${sql.unsafe(PROGRESS_COLS)}`;
    return rows[0] ?? null;
  },

  async listProgress(sql, learnerId, afterId, limit) {
    return sql<ProgressRow[]>`
      select ${sql.unsafe(PROGRESS_COLS)} from bnl.learner_progress
       where learner_id = ${learnerId} ${afterId ? sql`and id > ${afterId}` : sql``}
       order by id
       limit ${limit}`;
  },

  async findMigrationRun(sql, householdId, migrationRunId, fingerprint) {
    const rows = await sql<{ id: string; receipt: unknown }[]>`
      select id, receipt from bnl.migration_runs
       where household_id = ${householdId} and migration_run_id = ${migrationRunId} and legacy_fingerprint = ${fingerprint}`;
    return rows[0] ?? null;
  },

  async insertMigrationRun(sql, r) {
    const rows = await sql<{ id: string }[]>`
      insert into bnl.migration_runs (household_id, device_id, migration_run_id, legacy_fingerprint, status)
      values (${r.householdId}, ${r.deviceId}, ${r.migrationRunId}, ${r.fingerprint}, 'imported')
      on conflict (household_id, migration_run_id, legacy_fingerprint) do nothing
      returning id`;
    return rows[0]?.id ?? null;
  },

  async setMigrationReceipt(sql, id, receipt) {
    await sql`update bnl.migration_runs set receipt = ${json(sql, receipt)} where id = ${id}`;
  },

  async aliasesForDevice(sql, deviceId) {
    return sql<{ localProfileId: string; learnerId: string }[]>`
      select local_profile_id as "localProfileId", learner_id as "learnerId" from bnl.migration_aliases where device_id = ${deviceId}`;
  },

  async insertAlias(sql, a) {
    await sql`
      insert into bnl.migration_aliases (household_id, device_id, local_profile_id, learner_id, migration_run_id, legacy_fingerprint)
      values (${a.householdId}, ${a.deviceId}, ${a.localProfileId}, ${a.learnerId}, ${a.migrationRunServerId}, ${a.fingerprint})
      on conflict (device_id, local_profile_id) do nothing`;
  },
};
