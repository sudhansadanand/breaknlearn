/**
 * Session reducer (spec §7). Turns deduplicated events into time metrics that are honest:
 * - estimated active playback = sum of heartbeat `playback_ms` where foreground && playing
 * - foreground estimate       = sum of heartbeat `visible_ms` where foreground
 * Each contribution is already capped at 30 s by the schema (and again here); hidden/paused heartbeats add 0;
 * duplicates (same event_id) count once; ordering uses client_sequence within a session, never wall clocks.
 */
import { HEARTBEAT_CAP_MS, type LearningEvent } from "@bnl/contracts";

const clampMs = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(HEARTBEAT_CAP_MS, v)) : 0);

export interface SessionMetrics {
  readonly client_session_id: string;
  readonly learner_id: string;
  readonly started_at: string;
  readonly last_activity_at: string;
  readonly playback_ms: number;
  readonly foreground_estimated_ms: number;
  readonly interaction_count: number;
  readonly slides_completed: ReadonlySet<string>;
  readonly lessons_completed: ReadonlySet<string>;
}

const INTERACTIONS = new Set(["slide_entered", "playback_paused", "playback_resumed", "answer_submitted", "profile_selected", "lesson_started"]);

export function reduceSessions(events: readonly LearningEvent[]): Map<string, SessionMetrics> {
  const seen = new Set<string>();
  const bySession = new Map<string, LearningEvent[]>();
  for (const e of events) {
    if (seen.has(e.event_id)) continue;
    seen.add(e.event_id);
    const list = bySession.get(e.client_session_id) ?? [];
    list.push(e);
    bySession.set(e.client_session_id, list);
  }
  const out = new Map<string, SessionMetrics>();
  for (const [sid, list] of bySession) {
    list.sort((a, b) => a.client_sequence - b.client_sequence);
    const head = list[0];
    if (!head) continue;
    let playback = 0;
    let foreground = 0;
    let interactions = 0;
    const slides = new Set<string>();
    const lessons = new Set<string>();
    let first = head.occurred_at;
    let last = first;
    for (const e of list) {
      if (e.occurred_at < first) first = e.occurred_at;
      if (e.occurred_at > last) last = e.occurred_at;
      if (e.event_type === "playback_heartbeat") {
        const p = e.payload;
        const visible = clampMs(p.visible_ms);
        if (p.foreground === true) foreground += visible;
        // Playback is a subset of visible foreground time; never credit more playback than visibility.
        if (p.foreground === true && p.playing === true) playback += Math.min(clampMs(p.playback_ms), visible);
      }
      if (INTERACTIONS.has(e.event_type)) interactions++;
      // A slide counts as genuinely completed only when exited after being entered in this session.
      if (e.event_type === "slide_exited" && e.slide_id && e.lesson_id && list.some((x) => x.event_type === "slide_entered" && x.slide_id === e.slide_id && x.client_sequence < e.client_sequence)) {
        slides.add(`${e.lesson_id}:${e.payload.theme_key ?? "-"}:${e.slide_id}`);
      }
      if (e.event_type === "lesson_completed" && e.lesson_id) lessons.add(`${e.lesson_id}:${e.payload.theme_key ?? "-"}`);
    }
    out.set(sid, {
      client_session_id: sid,
      learner_id: head.learner_id,
      started_at: first,
      last_activity_at: last,
      playback_ms: playback,
      foreground_estimated_ms: foreground,
      interaction_count: interactions,
      slides_completed: slides,
      lessons_completed: lessons,
    });
  }
  return out;
}

/** Distinct activity days in the household time zone (TEL-007). */
export function activeDays(timestamps: readonly string[], timeZone = "Asia/Kolkata"): string[] {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return [...new Set(timestamps.map((t) => fmt.format(new Date(t))))].sort();
}
