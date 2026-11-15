/** In-memory AnalyticsRepo that mimics RLS: adult contexts only see their households' rows. */
import type { Sql } from "../../src/server/db-port";
import type { AnalyticsRepo, LessonRow, RecommendationRow, ReviewRow, SessionRow, SnapshotRow } from "../../src/server/analytics/repo";
import type { Store } from "../fakes";

export interface AnalyticsStore {
  snapshots: (SnapshotRow & { householdId: string })[];
  sessions: (SessionRow & { householdId: string })[];
  reviews: (ReviewRow & { householdId: string })[];
  recommendations: (RecommendationRow & { supersededAt: Date | null })[];
  lessons: LessonRow[];
  timezones: Record<string, string>;
}

export const emptyAnalyticsStore = (): AnalyticsStore => ({ snapshots: [], sessions: [], reviews: [], recommendations: [], lessons: [], timezones: {} });

type Ctx = { kind: string; userId?: string };
const ctxOf = (sql: Sql) => (sql as unknown as { ctx: Ctx }).ctx;

export function fakeAnalyticsRepo(store: Store, a: AnalyticsStore): AnalyticsRepo {
  const visible = (sql: Sql, householdId: string) => {
    const ctx = ctxOf(sql);
    if (ctx.kind === "job") return true;
    if (ctx.kind !== "adult") return false;
    return store.memberships.some((m) => m.userId === ctx.userId && m.active && m.householdId === householdId);
  };
  const scoped = <T extends { householdId: string; learnerId: string }>(sql: Sql, rows: T[], hh: string, ids: readonly string[]) =>
    rows.filter((r) => visible(sql, r.householdId) && r.householdId === hh && ids.includes(r.learnerId));
  return {
    async householdTimezone(sql, hh) {
      return visible(sql, hh) ? (a.timezones[hh] ?? "Asia/Kolkata") : null;
    },
    async latestSnapshots(sql, hh, ids) {
      const rows = scoped(sql, a.snapshots, hh, ids).sort((x, y) => y.scoreDate.localeCompare(x.scoreDate));
      const seen = new Set<string>();
      return rows.filter((r) => {
        const k = `${r.learnerId}|${r.topicId}|${r.lessonId}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    },
    async sessions(sql, hh, ids, from, to) {
      return scoped(sql, a.sessions, hh, ids).filter((s) => s.startedAt >= from && s.startedAt < to);
    },
    async openReviews(sql, hh, ids) {
      return scoped(sql, a.reviews, hh, ids);
    },
    async activeRecommendations(sql, hh, ids) {
      return scoped(sql, a.recommendations, hh, ids).filter((r) => r.supersededAt === null);
    },
    async setDismissed(sql, hh, id, at) {
      const r = a.recommendations.find((x) => x.id === id && x.householdId === hh && visible(sql, x.householdId) && x.supersededAt === null);
      if (!r) return null;
      (r as { dismissedAt: Date | null }).dismissedAt = at;
      return { ...r };
    },
    async lessons() {
      return a.lessons;
    },
  };
}
