/** Analytics API with in-memory fakes: auth, household scoping, no-store, evidence wording, dismiss/restore. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError, ELS_WEIGHTS_VERSION, MULTIPLICATION_LESSON_IDS, MULTIPLICATION_TOPIC_ID, Recommendation } from "@bnl/contracts";
import * as summary from "../../src/app/api/v1/admin/analytics/summary/route";
import * as scores from "../../src/app/api/v1/admin/analytics/learning-scores/route";
import * as recs from "../../src/app/api/v1/admin/recommendations/route";
import * as dismiss from "../../src/app/api/v1/admin/recommendations/[id]/dismiss/route";
import { setAnalyticsRepoForTesting } from "../../src/server/analytics";
import { computeEls, evidenceRecord, NO_STAGE_EVIDENCE } from "../../src/server/analytics/intelligence";
import { setDepsForTesting } from "../../src/server/deps";
import { GUARDIAN_A, HH_A, HH_B, OUTSIDER, OWNER_A, OWNER_B, makeTestEnv, req, type TestEnv } from "../fakes";
import { emptyAnalyticsStore, fakeAnalyticsRepo, type AnalyticsStore } from "./fake-repo";

const A1 = "c1000000-0000-4000-8000-0000000000a1";
const A2 = "c1000000-0000-4000-8000-0000000000a2";
const B1 = "c1000000-0000-4000-8000-0000000000b1";
const T3 = MULTIPLICATION_LESSON_IDS[3]!;
const REC_A = "e1000000-0000-4000-8000-0000000000a1";
const REC_B = "e1000000-0000-4000-8000-0000000000b1";

let env: TestEnv;
let as: AnalyticsStore;

const st = (pct: number, n: number, p: string) => ({ total: n, correct: Math.round((pct / 100) * n), questionKeys: Array.from({ length: n }, (_, i) => `${p}${i}`) });
function snap(learnerId: string, householdId: string, lessonId: string | null, delayed: boolean) {
  const score = computeEls({ learnerId, topicId: MULTIPLICATION_TOPIC_ID, baseline: null, immediate: st(80, 3, "i"), delayed: delayed ? st(100, 3, "d") : null, completion: { completedSlides: 10, assignedSlides: 10 }, computedAt: new Date("2026-11-13T23:59:59.999Z") });
  const stages = { baseline: NO_STAGE_EVIDENCE, immediate: { status: "observed" as const, reason: null, questions: 3 }, retention: delayed ? { status: "observed" as const, reason: null, questions: 3 } : { status: "insufficient_evidence" as const, reason: "no_attempt", questions: 0 } };
  return { householdId, learnerId, topicId: MULTIPLICATION_TOPIC_ID, lessonId, scoreDate: "2026-11-13", score, evidence: evidenceRecord(score, stages, lessonId ? [lessonId] : []) };
}

beforeEach(() => {
  env = makeTestEnv();
  as = emptyAnalyticsStore();
  setDepsForTesting(env.deps);
  setAnalyticsRepoForTesting(fakeAnalyticsRepo(env.store, as));
  for (const [id, householdId, slot] of [[A1, HH_A, 1], [A2, HH_A, 2], [B1, HH_B, 1]] as const) {
    env.store.profiles.push({ id, householdId, slot, displayName: `Kid ${slot}`, grade: 2, avatarId: "fox", preferences: {}, updatedAt: env.clock.now });
  }
  as.snapshots.push(snap(A1, HH_A, T3, false), snap(A1, HH_A, null, false), snap(B1, HH_B, T3, true));
  as.sessions.push(
    { householdId: HH_A, learnerId: A1, startedAt: new Date("2026-11-13T10:00:00Z"), playbackMs: 600_000, foregroundEstimatedMs: 650_000, interactionCount: 5 },
    { householdId: HH_B, learnerId: B1, startedAt: new Date("2026-11-13T10:00:00Z"), playbackMs: 999_000, foregroundEstimatedMs: 999_000, interactionCount: 9 },
  );
  as.reviews.push({ householdId: HH_A, id: "f1000000-0000-4000-8000-0000000000a1", learnerId: A1, lessonId: T3, topicId: MULTIPLICATION_TOPIC_ID, dueAt: new Date("2026-11-12T18:30:00Z") });
  const rec = (id: string, householdId: string, learnerId: string) => ({
    id, householdId, learnerId, topicId: MULTIPLICATION_TOPIC_ID, lessonId: T3, reasonCode: "delayed_review_due", suggestedLessonId: T3,
    computedAt: new Date("2026-11-13T23:59:59.999Z"), dismissedAt: null, detail: { rules_version: "rules-v1" }, supersededAt: null,
  });
  as.recommendations.push(rec(REC_A, HH_A, A1), rec(REC_B, HH_B, B1));
});
afterEach(() => {
  setDepsForTesting(null);
  setAnalyticsRepoForTesting(null);
});

const get = (h: (r: Request) => Promise<Response>, path: string, session?: string) => h(req("GET", path, session ? { session } : {}));
const doDismiss = (id: string, o: { session?: string; body?: unknown; csrf?: boolean } = {}) =>
  dismiss.POST(req("POST", `/api/v1/admin/recommendations/${id}/dismiss`, { ...o }), { params: Promise.resolve({ id }) });

describe("auth and scoping", () => {
  const reads = [
    ["summary", summary.GET, "/api/v1/admin/analytics/summary"],
    ["learning-scores", scores.GET, "/api/v1/admin/analytics/learning-scores"],
    ["recommendations", recs.GET, "/api/v1/admin/recommendations"],
  ] as const;

  it.each(reads)("%s: 401 without or with a forged session, no-store, no DB access", async (_n, h, path) => {
    for (const session of [undefined, "forged"]) {
      const res = await get(h, path, session);
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(ApiError.parse(await res.json()).error.code).toBe("unauthorized");
    }
    expect(env.contexts).toHaveLength(0);
  });

  it.each(reads)("%s: an adult with no household gets 403", async (_n, h, path) => {
    expect((await get(h, path, env.auth.sessionFor(OUTSIDER))).status).toBe(403);
  });

  it.each(reads)("%s: another household's learner is 404 (not 200, not 403)", async (_n, h, path) => {
    const res = await get(h, `${path}?learner_id=${B1}`, env.auth.sessionFor(OWNER_A));
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).not.toContain(B1);
  });

  it.each(reads)("%s: own household only, under the adult DB context", async (_n, h, path) => {
    const res = await get(h, path, env.auth.sessionFor(GUARDIAN_A));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(text).not.toContain(B1);
    expect(text).not.toContain(REC_B);
    expect(env.contexts.every((c) => c.kind === "adult")).toBe(true);
  });

  it("invalid query parameters are 422 without echoing values", async () => {
    const owner = env.auth.sessionFor(OWNER_A);
    for (const q of ["learner_id=nope", "from=2026-13-01", "from=2026-11-10&to=2026-11-01", "from=2020-01-01&to=2026-11-01"]) {
      const res = await get(summary.GET, `/api/v1/admin/analytics/summary?${q}`, owner);
      expect(res.status, q).toBe(422);
      expect(await res.text()).not.toContain("nope");
    }
  });
});

describe("summary content", () => {
  it("shows ×1–×10 with 'Not enough evidence yet' instead of 0, and keeps time separate from scores", async () => {
    const res = await get(summary.GET, `/api/v1/admin/analytics/summary?learner_id=${A1}`, env.auth.sessionFor(OWNER_A));
    const body = (await res.json()) as { scores_as_of: string; children: { tables: { table: number; started: boolean; retention: { text: string; value: number | null }; mastery: { value: number | null }; score: number | null }[]; activity: Record<string, unknown>; due_reviews: unknown[]; recommendations: { action: string; why: string }[] }[] };
    expect(body.scores_as_of).toBe("2026-11-13");
    const [child] = body.children;
    expect(child!.tables.map((t) => t.table)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const t3 = child!.tables[2]!;
    expect(t3.started).toBe(true);
    expect(t3.mastery.value).toBeCloseTo(66.67, 1);
    expect(t3.retention).toMatchObject({ text: "Not enough evidence yet", value: null });
    const t4 = child!.tables[3]!;
    expect(t4).toMatchObject({ started: false, score: null });
    expect(t4.mastery.value).toBeNull();
    // Time is reported, but only in the activity block.
    expect(child!.activity).toMatchObject({ playback_ms: 600_000, foreground_estimated_ms: 650_000, interaction_count: 5, active_days: 1 });
    expect(String(child!.activity.note)).toMatch(/not part of any score/);
    expect(child!.due_reviews).toHaveLength(1);
    expect(child!.recommendations[0]!.action).toBe("A gentle review of ×3 table is ready");
  });

  it("learning-scores: items are frozen-contract topic scores; lessons are additive", async () => {
    const res = await get(scores.GET, "/api/v1/admin/analytics/learning-scores", env.auth.sessionFor(OWNER_A));
    const body = (await res.json()) as { items: { topic_id: string; weights_version: string; components: { R: number | null } }[]; lessons: { lesson_id: string }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ topic_id: MULTIPLICATION_TOPIC_ID, weights_version: ELS_WEIGHTS_VERSION, components: { R: null } });
    expect(body.lessons.map((l) => l.lesson_id)).toEqual([T3]);
  });

  it("recommendations: contract fields plus explanation", async () => {
    const res = await get(recs.GET, `/api/v1/admin/recommendations?learner_id=${A1}`, env.auth.sessionFor(OWNER_A));
    const body = (await res.json()) as { items: Record<string, unknown>[] };
    expect(body.items).toHaveLength(1);
    expect(() => Recommendation.parse(body.items[0])).not.toThrow();
    expect(body.items[0]).toMatchObject({ reason_code: "delayed_review_due", lesson_id: T3, why: expect.stringMatching(/never scored as zero/) });
  });
});

describe("dismiss (reversible)", () => {
  it("401 without a session and 403 without CSRF", async () => {
    expect((await doDismiss(REC_A, { csrf: true })).status).toBe(401);
    expect((await doDismiss(REC_A, { session: env.auth.sessionFor(OWNER_A), csrf: false })).status).toBe(403);
    expect(as.recommendations[0]!.dismissedAt).toBeNull();
  });

  it("another household's recommendation is 404 and unchanged", async () => {
    const res = await doDismiss(REC_B, { session: env.auth.sessionFor(OWNER_A) });
    expect(res.status).toBe(404);
    expect(as.recommendations[1]!.dismissedAt).toBeNull();
    expect((await doDismiss("not-a-uuid", { session: env.auth.sessionFor(OWNER_A) })).status).toBe(404);
  });

  it("dismisses, restores, and audits without names", async () => {
    const owner = env.auth.sessionFor(OWNER_B);
    const d = await doDismiss(REC_B, { session: owner });
    expect(d.status).toBe(200);
    expect(((await d.json()) as { dismissed_at: string | null }).dismissed_at).toBe(env.clock.now.toISOString());
    const u = await doDismiss(REC_B, { session: owner, body: { undo: true } });
    expect(((await u.json()) as { dismissed_at: string | null }).dismissed_at).toBeNull();
    expect(env.store.audit.map((a) => a.action)).toEqual(["recommendation.dismissed", "recommendation.restored"]);
    expect(JSON.stringify(env.store.audit)).not.toMatch(/Kid/);
  });

  it("rejects unknown body keys", async () => {
    expect((await doDismiss(REC_A, { session: env.auth.sessionFor(OWNER_A), body: { undo: true, extra: 1 } })).status).toBe(422);
  });
});
