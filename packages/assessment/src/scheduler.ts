/**
 * Review scheduler (spec M08 "+3–7 days", M11 household timezone). Due dates fall at local midnight in the
 * household timezone (default Asia/Kolkata) and are stored in UTC. Reviews are gentle and optional: nothing
 * here penalises a missed review, and a missed review never becomes a zero score.
 */
import { DEFAULT_TIMEZONE, REVIEW_LADDER_DAYS, REVIEW_PASS_PCT, REVIEW_WINDOW_DAYS, type Stage } from "./policy";

const DAY_MS = 86_400_000;

/** The timezone if the runtime knows it, else the default. */
export function safeTimezone(tz: string | null | undefined): string {
  if (!tz) return DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

interface LocalParts { y: number; m: number; d: number; hh: number; mm: number; ss: number }

function localParts(instant: Date, tz: string): LocalParts {
  const out: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(instant)) if (p.type !== "literal") out[p.type] = Number(p.value);
  return { y: out.year ?? 0, m: out.month ?? 1, d: out.day ?? 1, hh: out.hour ?? 0, mm: out.minute ?? 0, ss: out.second ?? 0 };
}

/** UTC offset of `tz` at `instant`, in ms (local = utc + offset). */
function offsetMs(instant: Date, tz: string): number {
  const p = localParts(instant, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The instant local date (y, m, d) begins in `tz` (handles DST by re-checking the offset once). */
function localMidnight(y: number, m: number, d: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - offsetMs(new Date(guess), tz);
  const second = guess - offsetMs(new Date(t), tz);
  if (second !== t) t = second;
  return new Date(t);
}

/** Local calendar date (YYYY-MM-DD) of `instant` in `tz`. */
export function localDate(instant: Date, tz: string): string {
  const p = localParts(instant, safeTimezone(tz));
  return `${String(p.y).padStart(4, "0")}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** Start of the local day that is `days` calendar days after the local date of `instant`. */
export function startOfLocalDay(instant: Date, days: number, tz: string): Date {
  const zone = safeTimezone(tz);
  const p = localParts(instant, zone);
  const target = new Date(Date.UTC(p.y, p.m - 1, p.d) + days * DAY_MS);
  return localMidnight(target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate(), zone);
}

export interface ReviewPlan {
  readonly dueAt: Date;
  /** End of the review window (exclusive): the review is still offered afterwards, flagged `overdue`. */
  readonly windowEndsAt: Date;
  readonly intervalDays: number;
}

/** End of the window for a review due at `dueAt`. */
export function windowEnd(dueAt: Date, tz: string): Date {
  return startOfLocalDay(dueAt, REVIEW_WINDOW_DAYS + 1, tz);
}

/**
 * When the next delayed check is due after an attempt is finished.
 * - baseline: none (it precedes the lesson);
 * - immediate with at least one answer: first rung (+3 days);
 * - delayed: passed (≥ REVIEW_PASS_PCT) → one rung up from `passedDelayedStreak`, else back to the first rung;
 * - no answers: none (there is nothing to retain evidence about).
 */
export function nextReview(p: {
  stage: Stage;
  finishedAt: Date;
  answered: number;
  correct: number;
  /** Consecutive passed delayed checks for this learner and lesson BEFORE this attempt. */
  passedDelayedStreak: number;
  timezone: string;
}): ReviewPlan | null {
  if (p.stage === "baseline" || p.answered <= 0) return null;
  let rung = 0;
  if (p.stage === "delayed") {
    const passed = (100 * p.correct) / p.answered >= REVIEW_PASS_PCT;
    rung = passed ? Math.min(Math.max(0, p.passedDelayedStreak) + 1, REVIEW_LADDER_DAYS.length - 1) : 0;
  }
  const intervalDays = REVIEW_LADDER_DAYS[rung] ?? REVIEW_LADDER_DAYS[0] ?? 3;
  const dueAt = startOfLocalDay(p.finishedAt, intervalDays, p.timezone);
  return { dueAt, windowEndsAt: windowEnd(dueAt, p.timezone), intervalDays };
}

export interface ScheduledReview {
  readonly id: string;
  readonly lessonId: string | null;
  readonly topicId: string | null;
  readonly sourceAttemptId: string | null;
  readonly dueAt: Date;
  readonly status: "due" | "completed" | "dismissed";
}

export interface DueReview {
  readonly review_id: string;
  readonly lesson_id: string | null;
  readonly topic_id: string | null;
  readonly source_attempt_id: string | null;
  readonly due_at: string;
  readonly window_ends_at: string;
  readonly overdue: boolean;
}

/** Open reviews that are due at `now`, oldest first, plus the next future due date. */
export function dueReviews(rows: readonly ScheduledReview[], now: Date, timezone: string): { items: DueReview[]; next_due_at: string | null } {
  const open = rows.filter((r) => r.status === "due").slice().sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || (a.id < b.id ? -1 : 1));
  const items = open
    .filter((r) => r.dueAt.getTime() <= now.getTime())
    .map((r) => {
      const end = windowEnd(r.dueAt, timezone);
      return {
        review_id: r.id,
        lesson_id: r.lessonId,
        topic_id: r.topicId,
        source_attempt_id: r.sourceAttemptId,
        due_at: r.dueAt.toISOString(),
        window_ends_at: end.toISOString(),
        overdue: now.getTime() >= end.getTime(),
      };
    });
  const next = open.find((r) => r.dueAt.getTime() > now.getTime());
  return { items, next_due_at: next ? next.dueAt.toISOString() : null };
}

/** Consecutive passed delayed checks, most recent first (input: finished delayed attempts in any order). */
export function passedDelayedStreak(delayed: readonly { finishedAt: Date; answered: number; correct: number }[]): number {
  let streak = 0;
  for (const a of delayed.slice().sort((x, y) => y.finishedAt.getTime() - x.finishedAt.getTime())) {
    if (a.answered > 0 && (100 * a.correct) / a.answered >= REVIEW_PASS_PCT) streak++;
    else break;
  }
  return streak;
}
