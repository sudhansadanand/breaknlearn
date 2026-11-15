/**
 * Data access for the learning endpoints and jobs. Handlers own the rules; this is thin SQL.
 * Every method runs inside the caller's `withDevice` / `withAdultHousehold` / job transaction,
 * so RLS (ADR-0005) scopes it independently of the handler checks.
 */
import type { ThemeKey } from "@bnl/contracts";
import type { QualityFlag } from "@bnl/telemetry";
import type { Sql } from "../db-port";

export interface IdempotencyClaim {
  readonly scope: string;
  readonly key: string;
  /** Device id (device calls) or auth user id (adult calls). */
  readonly ownerId: string;
  readonly householdId: string | null;
  readonly requestSha256: string;
  readonly now: Date;
}

export type IdempotencyState =
  | { readonly kind: "new" }
  | { readonly kind: "replay"; readonly status: number; readonly body: unknown }
  | { readonly kind: "mismatch" };

export interface SessionUpsert {
  readonly householdId: string;
  readonly learnerId: string;
  readonly deviceId: string;
  readonly clientSessionId: string;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
}

export interface EventInsert {
  readonly eventId: string;
  readonly householdId: string;
  readonly learnerId: string;
  readonly deviceId: string;
  readonly sessionId: string;
  readonly clientSessionId: string;
  readonly clientSequence: number;
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly lessonId: string | null;
  readonly lessonVersionId: string | null;
  readonly slideId: string | null;
  readonly occurredAt: string;
  readonly sentAt: string;
  readonly receivedAt: Date;
  readonly payload: Record<string, unknown>;
  readonly qualityFlag: QualityFlag;
}

export interface ProgressKey {
  readonly learnerId: string;
  readonly lessonId: string;
  readonly themeKey: ThemeKey;
  readonly attemptId: string;
}

export interface ProgressRow {
  readonly id: string;
  readonly learnerId: string;
  readonly lessonId: string;
  readonly lessonVersionId: string | null;
  readonly themeKey: ThemeKey | null;
  readonly attemptId: string;
  readonly slideId: string | null;
  readonly positionSeconds: number;
  readonly completed: boolean;
  readonly clientRevision: number;
  readonly serverRevision: number;
  readonly updatedAt: Date;
}

export interface ProgressWrite extends ProgressKey {
  readonly householdId: string;
  readonly lessonVersionId: string | null;
  readonly slideId: string | null;
  readonly positionSeconds: number;
  readonly completed: boolean;
  readonly clientRevision: number;
}

export interface MigrationRunRow {
  readonly id: string;
  readonly receipt: unknown;
}

export interface LearningRepo {
  claimIdempotency(sql: Sql, c: IdempotencyClaim): Promise<IdempotencyState>;
  completeIdempotency(sql: Sql, c: Omit<IdempotencyClaim, "requestSha256" | "householdId" | "now"> & { status: number; body: unknown }): Promise<void>;

  learnerIdsInHousehold(sql: Sql, householdId: string): Promise<string[]>;
  /** Lessons visible in this context (devices: published at some point). */
  knownLessonIds(sql: Sql, ids: readonly string[]): Promise<string[]>;
  /** Version id -> lesson id for visible versions among `ids`. */
  knownVersions(sql: Sql, ids: readonly string[]): Promise<Map<string, string>>;

  storedEventIds(sql: Sql, ids: readonly string[]): Promise<string[]>;
  storedSequences(sql: Sql, deviceId: string, clientSessionIds: readonly string[]): Promise<{ client_session_id: string; client_sequence: number; event_id: string }[]>;
  sessionLearners(sql: Sql, deviceId: string, clientSessionIds: readonly string[]): Promise<Map<string, string>>;
  /** Upsert keyed by (device_id, client_session_id); returns session ids by client_session_id. */
  upsertSessions(sql: Sql, rows: readonly SessionUpsert[]): Promise<Map<string, string>>;
  /** `on conflict (event_id) do nothing`; returns the ids actually inserted. */
  insertEvents(sql: Sql, rows: readonly EventInsert[]): Promise<string[]>;

  getProgressForUpdate(sql: Sql, k: ProgressKey): Promise<ProgressRow | null>;
  progressForLearners(sql: Sql, learnerIds: readonly string[], lessonIds: readonly string[]): Promise<ProgressRow[]>;
  /** Null when the identity already exists (concurrent insert). */
  insertProgress(sql: Sql, w: ProgressWrite): Promise<ProgressRow | null>;
  /** Optimistic: null when server_revision moved since it was read. */
  updateProgress(sql: Sql, id: string, expectedServerRevision: number, w: ProgressWrite): Promise<ProgressRow | null>;
  listProgress(sql: Sql, learnerId: string, afterId: string | null, limit: number): Promise<ProgressRow[]>;

  findMigrationRun(sql: Sql, householdId: string, migrationRunId: string, fingerprint: string): Promise<MigrationRunRow | null>;
  /** Null when (household, run, fingerprint) already exists. */
  insertMigrationRun(sql: Sql, r: { householdId: string; deviceId: string; migrationRunId: string; fingerprint: string }): Promise<string | null>;
  setMigrationReceipt(sql: Sql, id: string, receipt: unknown): Promise<void>;
  aliasesForDevice(sql: Sql, deviceId: string): Promise<{ localProfileId: string; learnerId: string }[]>;
  insertAlias(sql: Sql, a: { householdId: string; deviceId: string; localProfileId: string; learnerId: string; migrationRunServerId: string; fingerprint: string }): Promise<void>;
}
