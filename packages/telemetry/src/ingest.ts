/**
 * Batch triage for POST /telemetry/batch (M07). Pure: the server supplies the scope and what it
 * already stores; this decides accept / duplicate / reject and the ingest quality flag per event.
 * Rejected events are never stored; duplicates are acknowledged so clients can drop them.
 */
import type { LearningEvent } from "@bnl/contracts";
import { checkEvent, type DeviceScope, type RejectionCode } from "./validate";

/** `learning_events.quality_flag` values (A1 proposal #5, confirmed by A6; see docs/adr/proposals/A6-*.md). */
export const QUALITY_FLAGS = ["ok", "clamped", "late_arrival", "clock_adjusted", "sequence_gap", "suspect"] as const;
export type QualityFlag = (typeof QUALITY_FLAGS)[number];

/** Arrivals older than this (but inside the 72 h window) are flagged `late_arrival`. */
export const LATE_ARRIVAL_MS = 24 * 3_600_000;

export interface StoredSequence {
  readonly client_session_id: string;
  readonly client_sequence: number;
  readonly event_id: string;
}

export interface TriageInput {
  readonly events: readonly unknown[];
  readonly scope: DeviceScope;
  readonly now: Date;
  /** Already-stored (event_id) for this device among the batch's ids. */
  readonly storedEventIds: ReadonlySet<string>;
  /** Already-stored (session, sequence) slots for this device touching the batch's sessions. */
  readonly storedSequences: readonly StoredSequence[];
  /** Learner already bound to a stored session (client_session_id -> learner_id). */
  readonly sessionLearners: ReadonlyMap<string, string>;
}

export interface AcceptedEvent {
  readonly event: LearningEvent;
  readonly quality_flag: QualityFlag;
}

export interface Triage {
  readonly accepted: AcceptedEvent[];
  readonly duplicates: string[];
  readonly rejected: { event_id: string | null; code: RejectionCode }[];
}

const slotKey = (session: string, seq: number) => `${session}#${seq}`;

/** Heartbeat values that cannot be true together (playback is a subset of visible foreground time). */
export function isSuspectHeartbeat(e: LearningEvent): boolean {
  if (e.event_type !== "playback_heartbeat") return false;
  const p = e.payload;
  if (p.foreground === false && ((p.visible_ms ?? 0) > 0 || (p.playback_ms ?? 0) > 0)) return true;
  if (p.playing === false && (p.playback_ms ?? 0) > 0) return true;
  return (p.playback_ms ?? 0) > (p.visible_ms ?? 0);
}

export function triageBatch(input: TriageInput): Triage {
  const accepted: AcceptedEvent[] = [];
  const duplicates: string[] = [];
  const rejected: { event_id: string | null; code: RejectionCode }[] = [];
  const seenIds = new Set<string>();
  const slots = new Map<string, string>(input.storedSequences.map((s) => [slotKey(s.client_session_id, s.client_sequence), s.event_id]));
  const sessionLearner = new Map(input.sessionLearners);
  const checked: LearningEvent[] = [];

  for (const raw of input.events) {
    const r = checkEvent(raw, input.scope, input.now);
    if (!r.ok) {
      rejected.push({ event_id: r.event_id, code: r.code });
      continue;
    }
    const e = r.event;
    if (seenIds.has(e.event_id) || input.storedEventIds.has(e.event_id)) {
      if (!duplicates.includes(e.event_id)) duplicates.push(e.event_id);
      continue;
    }
    // One event per (session, sequence): a different id in an occupied slot is a client bug or a forgery.
    const slot = slotKey(e.client_session_id, e.client_sequence);
    const holder = slots.get(slot);
    if (holder !== undefined && holder !== e.event_id) {
      rejected.push({ event_id: e.event_id, code: "sequence_regression" });
      continue;
    }
    seenIds.add(e.event_id);
    slots.set(slot, e.event_id);
    checked.push(e);
  }

  const minSeq = new Map<string, number>();
  for (const k of slots.keys()) {
    const i = k.lastIndexOf("#");
    const sid = k.slice(0, i);
    const seq = Number(k.slice(i + 1));
    minSeq.set(sid, Math.min(minSeq.get(sid) ?? seq, seq));
  }
  for (const e of checked) {
    const bound = sessionLearner.get(e.client_session_id);
    if (bound === undefined) sessionLearner.set(e.client_session_id, e.learner_id);
    accepted.push({ event: e, quality_flag: qualityFlag(e, input.now, slots, minSeq, bound !== undefined && bound !== e.learner_id) });
  }
  return { accepted, duplicates, rejected };
}

/** Precedence: suspect > clock_adjusted > late_arrival > sequence_gap > ok. `clamped` is reserved for the reducer. */
function qualityFlag(
  e: LearningEvent,
  now: Date,
  slots: ReadonlyMap<string, string>,
  minSeq: ReadonlyMap<string, number>,
  learnerMismatch: boolean,
): QualityFlag {
  if (learnerMismatch || isSuspectHeartbeat(e)) return "suspect";
  const occurred = Date.parse(e.occurred_at);
  const sent = Date.parse(e.sent_at);
  if (occurred > sent || occurred > now.getTime()) return "clock_adjusted";
  if (now.getTime() - occurred > LATE_ARRIVAL_MS) return "late_arrival";
  // A gap: something earlier in this session is known, but not the immediate predecessor (snapshot at ingest).
  const first = minSeq.get(e.client_session_id) ?? e.client_sequence;
  if (e.client_sequence > first && !slots.has(slotKey(e.client_session_id, e.client_sequence - 1))) return "sequence_gap";
  return "ok";
}
