/** In-memory LearningRepo for route tests. Household scoping mimics RLS via the fake sql's DbContext. */
import { randomUUID } from "node:crypto";
import type { DbContext, DbRunner, Sql } from "../../src/server/db-port";
import type { EventInsert, LearningRepo, ProgressRow, ProgressWrite } from "../../src/server/learning";
import type { Store } from "../fakes";

export interface LearningStore {
  idem: { scope: string; key: string; ownerId: string; sha: string; status: number | null; body: unknown; expiresAt: number }[];
  lessons: { id: string; versions: string[] }[];
  sessions: { id: string; householdId: string; deviceId: string; clientSessionId: string; learnerId: string; startedAt: Date; endedAt: Date | null }[];
  events: EventInsert[];
  progress: (ProgressRow & { householdId: string })[];
  runs: { id: string; householdId: string; runId: string; fp: string; receipt: unknown }[];
  aliases: { deviceId: string; localProfileId: string; learnerId: string }[];
}

export const emptyLearningStore = (lessons: { id: string; versions: string[] }[]): LearningStore => ({ idem: [], lessons, sessions: [], events: [], progress: [], runs: [], aliases: [] });

const ctxOf = (sql: Sql) => (sql as unknown as { ctx: DbContext }).ctx;
const hhOf = (sql: Sql): string => {
  const c = ctxOf(sql);
  if (c.kind !== "device") throw new Error("fake learning repo: device context only");
  return c.householdId;
};

/** Snapshots both stores per transaction so a throw rolls everything back. */
export function rollbackRunner(inner: DbRunner, store: Store, ls: LearningStore): DbRunner {
  return async (ctx, fn) => {
    const snap = structuredClone(ls);
    try {
      return await inner(ctx, fn);
    } catch (err) {
      Object.assign(ls, snap);
      throw err;
    }
  };
}

export function fakeLearningRepo(store: Store, ls: LearningStore): LearningRepo {
  const write = (w: ProgressWrite, prev: ProgressRow | null, now: Date): ProgressRow & { householdId: string } => ({
    id: prev?.id ?? randomUUID(),
    householdId: w.householdId,
    learnerId: w.learnerId,
    lessonId: w.lessonId,
    lessonVersionId: w.lessonVersionId ?? prev?.lessonVersionId ?? null,
    themeKey: w.themeKey,
    attemptId: w.attemptId,
    slideId: w.slideId,
    positionSeconds: w.positionSeconds,
    completed: (prev?.completed ?? false) || w.completed,
    clientRevision: w.clientRevision,
    serverRevision: prev ? prev.serverRevision + 1 : 1,
    updatedAt: now,
  });
  return {
    async claimIdempotency(_sql, c) {
      const row = ls.idem.find((r) => r.scope === c.scope && r.ownerId === c.ownerId && r.key === c.key);
      if (!row || row.expiresAt <= c.now.getTime()) {
        ls.idem = ls.idem.filter((r) => r !== row);
        ls.idem.push({ scope: c.scope, key: c.key, ownerId: c.ownerId, sha: c.requestSha256, status: null, body: null, expiresAt: c.now.getTime() + 86_400_000 });
        return { kind: "new" };
      }
      if (row.sha !== c.requestSha256 || row.status === null) return { kind: "mismatch" };
      return { kind: "replay", status: row.status, body: structuredClone(row.body) };
    },
    async completeIdempotency(_sql, c) {
      const row = ls.idem.find((r) => r.scope === c.scope && r.ownerId === c.ownerId && r.key === c.key);
      if (row) Object.assign(row, { status: c.status, body: structuredClone(c.body) });
    },
    async learnerIdsInHousehold(sql, hid) {
      const c = ctxOf(sql);
      if (c.kind === "device" && c.householdId !== hid) return [];
      return store.profiles.filter((p) => p.householdId === hid).map((p) => p.id);
    },
    async knownLessonIds(_sql, ids) {
      return ls.lessons.filter((l) => ids.includes(l.id)).map((l) => l.id);
    },
    async knownVersions(_sql, ids) {
      return new Map(ls.lessons.flatMap((l) => l.versions.filter((v) => ids.includes(v)).map((v) => [v, l.id] as const)));
    },
    async storedEventIds(sql, ids) {
      const hid = hhOf(sql);
      return ls.events.filter((e) => e.householdId === hid && ids.includes(e.eventId)).map((e) => e.eventId);
    },
    async storedSequences(_sql, deviceId, sids) {
      return ls.events.filter((e) => e.deviceId === deviceId && sids.includes(e.clientSessionId)).map((e) => ({ client_session_id: e.clientSessionId, client_sequence: e.clientSequence, event_id: e.eventId }));
    },
    async sessionLearners(_sql, deviceId, sids) {
      return new Map(ls.sessions.filter((s) => s.deviceId === deviceId && sids.includes(s.clientSessionId)).map((s) => [s.clientSessionId, s.learnerId]));
    },
    async upsertSessions(_sql, rows) {
      const out = new Map<string, string>();
      for (const r of rows) {
        let s = ls.sessions.find((x) => x.deviceId === r.deviceId && x.clientSessionId === r.clientSessionId);
        if (!s) {
          s = { id: randomUUID(), householdId: r.householdId, deviceId: r.deviceId, clientSessionId: r.clientSessionId, learnerId: r.learnerId, startedAt: r.startedAt, endedAt: r.endedAt };
          ls.sessions.push(s);
        }
        out.set(r.clientSessionId, s.id);
      }
      return out;
    },
    async insertEvents(_sql, rows) {
      const ids: string[] = [];
      for (const r of rows) {
        if (ls.events.some((e) => e.eventId === r.eventId)) continue;
        ls.events.push(r);
        ids.push(r.eventId);
      }
      return ids;
    },
    async getProgressForUpdate(sql, k) {
      const hid = hhOf(sql);
      return ls.progress.find((p) => p.householdId === hid && p.learnerId === k.learnerId && p.lessonId === k.lessonId && p.themeKey === k.themeKey && p.attemptId === k.attemptId) ?? null;
    },
    async progressForLearners(sql, learners, lessons) {
      const hid = hhOf(sql);
      return ls.progress.filter((p) => p.householdId === hid && learners.includes(p.learnerId) && lessons.includes(p.lessonId));
    },
    async insertProgress(_sql, w) {
      if (ls.progress.some((p) => p.learnerId === w.learnerId && p.lessonId === w.lessonId && p.themeKey === w.themeKey && p.attemptId === w.attemptId)) return null;
      const row = write(w, null, new Date());
      ls.progress.push(row);
      return row;
    },
    async updateProgress(_sql, id, rev, w) {
      const i = ls.progress.findIndex((p) => p.id === id && p.serverRevision === rev && p.householdId === w.householdId);
      const prev = ls.progress[i];
      if (!prev) return null;
      if (prev.completed && !w.completed) throw new Error("trigger: completion cannot be reverted");
      const row = write(w, prev, new Date());
      ls.progress[i] = row;
      return row;
    },
    async listProgress(_sql, learner, afterId, limit) {
      return ls.progress.filter((p) => p.learnerId === learner && (afterId === null || p.id > afterId)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit);
    },
    async findMigrationRun(_sql, hid, runId, fp) {
      const r = ls.runs.find((x) => x.householdId === hid && x.runId === runId && x.fp === fp);
      return r ? { id: r.id, receipt: structuredClone(r.receipt) } : null;
    },
    async insertMigrationRun(_sql, r) {
      if (ls.runs.some((x) => x.householdId === r.householdId && x.runId === r.migrationRunId && x.fp === r.fingerprint)) return null;
      const id = randomUUID();
      ls.runs.push({ id, householdId: r.householdId, runId: r.migrationRunId, fp: r.fingerprint, receipt: {} });
      return id;
    },
    async setMigrationReceipt(_sql, id, receipt) {
      const r = ls.runs.find((x) => x.id === id);
      if (r) r.receipt = structuredClone(receipt);
    },
    async aliasesForDevice(_sql, deviceId) {
      return ls.aliases.filter((a) => a.deviceId === deviceId).map((a) => ({ localProfileId: a.localProfileId, learnerId: a.learnerId }));
    },
    async insertAlias(_sql, a) {
      if (!ls.aliases.some((x) => x.deviceId === a.deviceId && x.localProfileId === a.localProfileId)) ls.aliases.push({ deviceId: a.deviceId, localProfileId: a.localProfileId, learnerId: a.learnerId });
    },
  };
}
