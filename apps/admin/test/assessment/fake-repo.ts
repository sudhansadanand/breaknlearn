/**
 * In-memory AssessmentRepo for route tests. Household scoping mimics RLS through the fake sql's DbContext;
 * scoring and attempt totals mimic bnl.score_answer and the 0006 attempt guard (answer keys stay in `bank`).
 */
import { randomUUID } from "node:crypto";
import { scoreSelection, tallyAttempt } from "@bnl/assessment";
import type { BankItem } from "@bnl/lesson-engine";
import { withoutAnswerKey } from "@bnl/lesson-engine";
import type { DbContext, DbRunner, Sql } from "../../src/server/db-port";
import type { AssessmentRepo, AttemptRow, ReviewRow } from "../../src/server/assessment";
import type { Store } from "../fakes";

export interface FakeLesson {
  id: string;
  topicId: string | null;
  versionId: string;
  versionNo: number;
  stableKey: string;
  config: Record<string, unknown>;
  live: boolean;
  bank: BankItem[];
}

export interface AssessmentStore {
  lessons: FakeLesson[];
  timezones: Record<string, string>;
  progress: { learnerId: string; lessonId: string }[];
  attempts: AttemptRow[];
  responses: { attemptId: string; householdId: string; questionVersionKey: string; selectedOptionId: string; correct: boolean; answeredAt: Date }[];
  reviews: (ReviewRow & { householdId: string })[];
  idem: { scope: string; key: string; ownerId: string; sha: string; status: number | null; body: unknown }[];
  /** Every scoreAnswer call (to prove correctness never came from the client). */
  scoreCalls: { attemptId: string; key: string; option: string }[];
}

export const emptyAssessmentStore = (lessons: FakeLesson[]): AssessmentStore => ({
  lessons, timezones: {}, progress: [], attempts: [], responses: [], reviews: [], idem: [], scoreCalls: [],
});

const ctxOf = (sql: Sql) => (sql as unknown as { ctx: DbContext }).ctx;
const hh = (sql: Sql): string => {
  const c = ctxOf(sql);
  if (c.kind !== "device") throw new Error("fake assessment repo: device context only");
  return c.householdId;
};
const clone = <T>(x: T): T => structuredClone(x);

/** Snapshots the assessment store per transaction so a throw rolls everything back. */
export function rollbackRunner(inner: DbRunner, as: AssessmentStore): DbRunner {
  return async (ctx, fn) => {
    const snap = structuredClone(as);
    try {
      return await inner(ctx, fn);
    } catch (err) {
      Object.assign(as, snap);
      throw err;
    }
  };
}

export function fakeAssessmentRepo(store: Store, as: AssessmentStore): AssessmentRepo {
  const visibleAttempt = (sql: Sql, id: string) => as.attempts.find((a) => a.id === id && a.householdId === hh(sql)) ?? null;
  return {
    async claimIdempotency(_sql, c) {
      const row = as.idem.find((r) => r.scope === c.scope && r.ownerId === c.ownerId && r.key === c.key);
      if (!row) {
        as.idem.push({ scope: c.scope, key: c.key, ownerId: c.ownerId, sha: c.requestSha256, status: null, body: null });
        return { kind: "new" };
      }
      if (row.sha !== c.requestSha256 || row.status === null) return { kind: "mismatch" };
      return { kind: "replay", status: row.status, body: clone(row.body) };
    },
    async completeIdempotency(_sql, c) {
      const row = as.idem.find((r) => r.scope === c.scope && r.ownerId === c.ownerId && r.key === c.key);
      if (row) Object.assign(row, { status: c.status, body: clone(c.body) });
    },
    async learnerInHousehold(sql, householdId, learnerId) {
      return householdId === hh(sql) && store.profiles.some((p) => p.id === learnerId && p.householdId === householdId);
    },
    async householdTimezone(sql, householdId) {
      return householdId === hh(sql) ? (as.timezones[householdId] ?? "Asia/Kolkata") : null;
    },
    async liveLesson(_sql, lessonId) {
      const l = as.lessons.find((x) => x.id === lessonId && x.live);
      return l ? { lessonId: l.id, topicId: l.topicId, versionId: l.versionId, versionNo: l.versionNo, stableKey: l.stableKey, config: clone(l.config) } : null;
    },
    async versionRef(_sql, versionId) {
      const l = as.lessons.find((x) => x.versionId === versionId);
      return l ? { versionId: l.versionId, versionNo: l.versionNo, stableKey: l.stableKey, config: clone(l.config) } : null;
    },
    async publicItems(_sql, versionId) {
      const l = as.lessons.find((x) => x.versionId === versionId);
      if (!l) throw Object.assign(new Error("lesson version not found"), { code: "P0002" });
      return l.bank.map((b) => clone(withoutAnswerKey(b))) as never;
    },
    async hasProgress(_sql, learnerId, lessonId) {
      return as.progress.some((p) => p.learnerId === learnerId && p.lessonId === lessonId);
    },
    async attemptByClientId(sql, clientAttemptId) {
      const a = as.attempts.find((x) => x.clientAttemptId === clientAttemptId && x.householdId === hh(sql));
      return a ? clone(a) : null;
    },
    async attemptForUpdate(sql, attemptId) {
      const a = visibleAttempt(sql, attemptId);
      return a ? clone(a) : null;
    },
    async learnerLessonAttempts(sql, learnerId, lessonId) {
      return as.attempts.filter((a) => a.householdId === hh(sql) && a.learnerId === learnerId && a.lessonId === lessonId).map(clone);
    },
    async insertAttempt(sql, a) {
      if (a.householdId !== hh(sql)) throw new Error("RLS: insert outside household");
      if (as.attempts.some((x) => x.clientAttemptId === a.clientAttemptId)) return null;
      const row: AttemptRow = {
        id: randomUUID(), householdId: a.householdId, learnerId: a.learnerId, deviceId: a.deviceId, lessonId: a.lessonId,
        lessonVersionId: a.lessonVersionId, clientAttemptId: a.clientAttemptId, stage: a.stage, seed: a.seed,
        questionKeys: [...a.questionKeys], startedAt: a.startedAt, finishedAt: a.finishedAt,
        totalQuestions: a.finishedAt ? a.questionKeys.length : 0, correctQuestions: 0,
      };
      as.attempts.push(row);
      return clone(row);
    },
    async finishAttempt(sql, attemptId, at) {
      const a = visibleAttempt(sql, attemptId);
      if (!a || a.finishedAt) throw new Error("attempt was not open while locked");
      const t = tallyAttempt(a.questionKeys, as.responses.filter((r) => r.attemptId === a.id).map((r) => ({ question_version_key: r.questionVersionKey, correct: r.correct })));
      Object.assign(a, { finishedAt: at, totalQuestions: t.total, correctQuestions: t.correct });
      return clone(a);
    },
    async responsesFor(sql, attemptIds) {
      return as.responses
        .filter((r) => attemptIds.includes(r.attemptId) && r.householdId === hh(sql))
        .map((r) => ({ attemptId: r.attemptId, questionVersionKey: r.questionVersionKey, correct: r.correct, answeredAt: r.answeredAt }));
    },
    async scoreAnswer(sql, p) {
      as.scoreCalls.push({ attemptId: p.attemptId, key: p.questionVersionKey, option: p.selectedOptionId });
      const a = visibleAttempt(sql, p.attemptId);
      if (!a) throw Object.assign(new Error("attempt not found"), { code: "P0002" });
      const item = as.lessons.find((l) => l.versionId === a.lessonVersionId)?.bank.find((b) => b.question_version_key === p.questionVersionKey);
      if (!item) throw Object.assign(new Error("question not found"), { code: "P0002" });
      if (!a.questionKeys.includes(p.questionVersionKey)) throw Object.assign(new Error("not in attempt"), { code: "22023" });
      const prior = as.responses.find((r) => r.attemptId === a.id && r.questionVersionKey === p.questionVersionKey);
      if (prior) return { correct: prior.correct, correctOptionId: item.correct_option_id, alreadyAnswered: true };
      if (a.finishedAt) throw Object.assign(new Error("finished"), { code: "55000" });
      const s = scoreSelection(item, p.selectedOptionId);
      if (s.kind !== "scored") throw Object.assign(new Error("unknown option"), { code: "22023" });
      as.responses.push({ attemptId: a.id, householdId: a.householdId, questionVersionKey: p.questionVersionKey, selectedOptionId: p.selectedOptionId, correct: s.correct, answeredAt: new Date() });
      return { correct: s.correct, correctOptionId: s.correct_option_id, alreadyAnswered: false };
    },
    async reviewsForLearner(sql, learnerId, lessonId) {
      return as.reviews
        .filter((r) => r.householdId === hh(sql) && r.learnerId === learnerId && (lessonId === undefined || r.lessonId === lessonId))
        .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())
        .map(({ householdId: _h, ...r }) => clone(r));
    },
    async insertReview(sql, r) {
      if (r.householdId !== hh(sql)) throw new Error("RLS: insert outside household");
      if (as.reviews.some((x) => x.learnerId === r.learnerId && x.lessonId === r.lessonId && x.status === "due")) return false;
      as.reviews.push({ id: randomUUID(), householdId: r.householdId, learnerId: r.learnerId, lessonId: r.lessonId, topicId: r.topicId, sourceAttemptId: r.sourceAttemptId, dueAt: r.dueAt, status: "due" });
      return true;
    },
    async completeOpenReviews(sql, learnerId, lessonId) {
      const open = as.reviews.filter((r) => r.householdId === hh(sql) && r.learnerId === learnerId && r.lessonId === lessonId && r.status === "due");
      for (const r of open) Object.assign(r, { status: "completed" });
      return open.length;
    },
  };
}
