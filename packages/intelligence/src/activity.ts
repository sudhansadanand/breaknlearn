/**
 * Activity context for dashboards (spec §7, M11). Kept apart from scoring on purpose: nothing here is an
 * input to ELS or to recommendations. Time is "estimated active playback", not verified attention.
 */
export interface SessionTotals {
  readonly startedAt: Date;
  readonly playbackMs: number;
  readonly foregroundEstimatedMs: number;
  readonly interactionCount: number;
}

export interface ActivitySummary {
  readonly sessions: number;
  /** Distinct local calendar days with a session, in the household timezone. */
  readonly active_days: number;
  readonly last_active_date: string | null;
  readonly playback_ms: number;
  readonly foreground_estimated_ms: number;
  readonly interaction_count: number;
}

/** YYYY-MM-DD of `d` in `timeZone`. */
export function localDate(d: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function summarizeActivity(sessions: readonly SessionTotals[], timeZone: string): ActivitySummary {
  const days = new Set(sessions.map((s) => localDate(s.startedAt, timeZone)));
  const sorted = [...days].sort();
  return {
    sessions: sessions.length,
    active_days: days.size,
    last_active_date: sorted.at(-1) ?? null,
    playback_ms: sessions.reduce((t, s) => t + s.playbackMs, 0),
    foreground_estimated_ms: sessions.reduce((t, s) => t + s.foregroundEstimatedMs, 0),
    interaction_count: sessions.reduce((t, s) => t + s.interactionCount, 0),
  };
}

/** "1 h 5 min", "12 min", "under 1 min". */
export function formatDuration(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return ms > 0 ? "under 1 min" : "0 min";
  const h = Math.floor(min / 60);
  return h > 0 ? `${h} h ${min % 60} min` : `${min} min`;
}
