/**
 * Adult analytics API (OpenAPI M10/M11): household-scoped, cookie session, `Cache-Control: no-store`.
 * A learner or recommendation outside the caller's household is 404 (indistinguishable from "does not exist").
 */
import { HttpError, type AdultIdentity } from "@bnl/auth";
import { Recommendation, Uuid } from "@bnl/contracts";
import { z } from "zod";
import { requireAdult, requireCsrf, withAdultHousehold, type HouseholdMembership } from "../authn";
import type { Sql } from "../db-port";
import { json, readJson, validationFailed, type Ctx } from "../http";
import { buildDashboard, type ChildProfile, type Dashboard, type RecommendationView } from "./dashboard";
import { analyticsRepo, type RecommendationRow } from "./repo";
import { RECOMMENDATION_TEXT, type RecommendationCode } from "./intelligence";
import { requireFeature } from "../flags";

const DAY = 86_400_000;
export const DEFAULT_ACTIVITY_DAYS = 14;
const MAX_RANGE_DAYS = 400;
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const notFound = () => new HttpError(404, "not_found", "Not found");

export interface DashboardQuery {
  readonly learnerId?: string;
  readonly from?: Date;
  readonly to?: Date;
}

function parseQuery(req: Request): DashboardQuery {
  const q = new URL(req.url).searchParams;
  const issues: { path: string[]; code: string }[] = [];
  const out: { learnerId?: string; from?: Date; to?: Date } = {};
  const learner = q.get("learner_id");
  if (learner !== null) {
    if (Uuid.safeParse(learner).success) out.learnerId = learner.toLowerCase();
    else issues.push({ path: ["learner_id"], code: "invalid_string" });
  }
  for (const key of ["from", "to"] as const) {
    const v = q.get(key);
    if (v === null) continue;
    const d = new Date(`${v}T00:00:00Z`);
    if (!DATE.safeParse(v).success || Number.isNaN(d.getTime())) issues.push({ path: [key], code: "invalid_date" });
    else out[key] = key === "to" ? new Date(d.getTime() + DAY) : d;
  }
  if (out.from && out.to && (out.from >= out.to || out.to.getTime() - out.from.getTime() > MAX_RANGE_DAYS * DAY)) issues.push({ path: ["from"], code: "invalid_range" });
  if (issues.length) throw validationFailed(issues, "Query is invalid");
  return out;
}

/** Shared by the page and the API: one household, optionally one learner. */
export async function loadDashboard(sql: Sql, c: Ctx, m: HouseholdMembership, q: DashboardQuery = {}): Promise<Dashboard> {
  const repo = analyticsRepo();
  const now = c.deps.now();
  const profiles = await c.deps.repos.profiles.listForHousehold(sql, m.householdId);
  const children: ChildProfile[] = profiles
    .filter((p) => q.learnerId === undefined || p.id === q.learnerId)
    .map((p) => ({ id: p.id, displayName: p.displayName, slot: p.slot, grade: p.grade }));
  if (q.learnerId !== undefined && children.length === 0) throw notFound();
  const ids = children.map((ch) => ch.id);
  const to = q.to ?? now;
  const from = q.from ?? new Date(to.getTime() - DEFAULT_ACTIVITY_DAYS * DAY);
  return buildDashboard({
    now,
    timezone: (await repo.householdTimezone(sql, m.householdId)) ?? "Asia/Kolkata",
    children,
    snapshots: await repo.latestSnapshots(sql, m.householdId, ids),
    sessions: await repo.sessions(sql, m.householdId, ids, from, to),
    reviews: await repo.openReviews(sql, m.householdId, ids),
    recommendations: await repo.activeRecommendations(sql, m.householdId, ids),
    lessons: await repo.lessons(sql),
    activityFrom: from,
    activityTo: to,
  });
}

const withHousehold = <T>(c: Ctx, adult: AdultIdentity, fn: (sql: Sql, m: HouseholdMembership) => Promise<T>) => withAdultHousehold(c, adult, fn);

/** GET /api/v1/admin/analytics/summary?learner_id&from&to */
export async function summaryHandler(req: Request, c: Ctx): Promise<Response> {
  const adult = await requireAdult(req, c);
  // After authentication so unauthenticated callers always get 401 (SEC-001).
  requireFeature("FEATURE_SCORES", "Learning scores");
  const q = parseQuery(req);
  return json(c, await withHousehold(c, adult, (sql, m) => loadDashboard(sql, c, m, q)));
}

/** GET /api/v1/admin/analytics/learning-scores?learner_id — `items` = topic-level LearningScore (frozen schema); `lessons` additive. */
export async function learningScoresHandler(req: Request, c: Ctx): Promise<Response> {
  const adult = await requireAdult(req, c);
  requireFeature("FEATURE_SCORES", "Learning scores");
  const q = parseQuery(req);
  const body = await withHousehold(c, adult, async (sql, m) => {
    const profiles = (await c.deps.repos.profiles.listForHousehold(sql, m.householdId)).filter((p) => q.learnerId === undefined || p.id === q.learnerId);
    if (q.learnerId !== undefined && profiles.length === 0) throw notFound();
    const snaps = await analyticsRepo().latestSnapshots(sql, m.householdId, profiles.map((p) => p.id));
    return {
      items: snaps.filter((s) => s.lessonId === null).map((s) => s.score),
      lessons: snaps.filter((s) => s.lessonId !== null).map((s) => ({ lesson_id: s.lessonId, score_date: s.scoreDate, score: s.score, evidence: s.evidence })),
    };
  });
  return json(c, body);
}

function recView(r: RecommendationRow): z.infer<typeof Recommendation> & Pick<RecommendationView, "lesson_id" | "action" | "why" | "detail"> {
  const text = RECOMMENDATION_TEXT[r.reasonCode as RecommendationCode] ?? { action: "", why: "" };
  return {
    ...Recommendation.parse({
      id: r.id, learner_id: r.learnerId, topic_id: r.topicId, reason_code: r.reasonCode, suggested_lesson_id: r.suggestedLessonId,
      computed_at: r.computedAt.toISOString(), dismissed_at: r.dismissedAt === null ? null : r.dismissedAt.toISOString(),
    }),
    lesson_id: r.lessonId,
    action: text.action,
    why: text.why,
    detail: r.detail,
  };
}

/** GET /api/v1/admin/recommendations?learner_id */
export async function listRecommendationsHandler(req: Request, c: Ctx): Promise<Response> {
  const adult = await requireAdult(req, c);
  requireFeature("FEATURE_SCORES", "Learning scores");
  const q = parseQuery(req);
  const items = await withHousehold(c, adult, async (sql, m) => {
    const profiles = (await c.deps.repos.profiles.listForHousehold(sql, m.householdId)).filter((p) => q.learnerId === undefined || p.id === q.learnerId);
    if (q.learnerId !== undefined && profiles.length === 0) throw notFound();
    return (await analyticsRepo().activeRecommendations(sql, m.householdId, profiles.map((p) => p.id))).map(recView);
  });
  return json(c, { items });
}

/** Optional body: `{ "undo": true }` restores a dismissed recommendation (spec: reversible). */
export const DismissRequest = z.object({ undo: z.boolean().optional() }).strict();

/** POST /api/v1/admin/recommendations/{id}/dismiss */
export async function dismissRecommendationHandler(req: Request, c: Ctx, id: string): Promise<Response> {
  const adult = await requireAdult(req, c);
  requireFeature("FEATURE_SCORES", "Learning scores");
  requireCsrf(req, c);
  const hasBody = (req.headers.get("content-length") ?? "") !== "0" && (req.headers.get("content-type") ?? "") !== "";
  const body = hasBody ? await readJson(req, DismissRequest) : {};
  if (!Uuid.safeParse(id).success) throw notFound();
  const at = c.deps.now();
  const row = await withHousehold(c, adult, async (sql, m) => {
    const r = await analyticsRepo().setDismissed(sql, m.householdId, id.toLowerCase(), body.undo ? null : at);
    if (!r) throw notFound();
    await c.deps.repos.audit.insert(sql, {
      actorAuthId: adult.userId,
      householdId: m.householdId,
      action: body.undo ? "recommendation.restored" : "recommendation.dismissed",
      targetType: "recommendation",
      targetId: r.id,
      metadata: { reason_code: r.reasonCode, role: m.role },
    });
    return r;
  });
  return json(c, recView(row));
}
