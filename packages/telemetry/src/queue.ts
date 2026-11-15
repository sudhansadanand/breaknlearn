/**
 * Durable client queue (M07). Storage is injected (IndexedDB in the TV app, memory in tests).
 * Flush every 25 events or 30 s; on failure retry with exponential backoff + jitter; bounded size
 * (oldest heartbeats dropped first, learning-correctness events never dropped silently).
 */
import { CLIENT_FLUSH_EVERY_EVENTS, CLIENT_FLUSH_EVERY_MS, TELEMETRY_BATCH_MAX, type LearningEvent, type TelemetryAck } from "@bnl/contracts";

export interface QueueStorage {
  load(): Promise<LearningEvent[]>;
  save(events: LearningEvent[]): Promise<void>;
}

export interface Transport {
  send(events: LearningEvent[], idempotencyKey: string): Promise<TelemetryAck>;
}

export const QUEUE_MAX_EVENTS = 5000;
const PRESERVE = new Set(["answer_submitted", "quiz_completed", "lesson_completed", "quiz_started", "lesson_started"]);

export class TelemetryQueue {
  private events: LearningEvent[] = [];
  private failures = 0;
  private nextAttemptAt = 0;
  private flushing: Promise<void> | null = null;
  dropped = 0;

  constructor(
    private readonly storage: QueueStorage,
    private readonly transport: Transport,
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
  ) {}

  async init(): Promise<void> {
    this.events = await this.storage.load();
  }

  get size(): number {
    return this.events.length;
  }

  async enqueue(e: LearningEvent): Promise<void> {
    if (this.events.some((x) => x.event_id === e.event_id)) return;
    this.events.push(e);
    while (this.events.length > QUEUE_MAX_EVENTS) {
      const i = this.events.findIndex((x) => !PRESERVE.has(x.event_type));
      if (i < 0) break; // only learning-evidence events left: keep them, never silently drop
      this.events.splice(i, 1);
      this.dropped++;
    }
    await this.storage.save(this.events);
  }

  shouldFlush(lastFlushAt: number): boolean {
    return this.events.length >= CLIENT_FLUSH_EVERY_EVENTS || (this.events.length > 0 && this.now() - lastFlushAt >= CLIENT_FLUSH_EVERY_MS);
  }

  backoffMs(): number {
    if (this.failures === 0) return 0;
    const base = Math.min(5 * 60_000, 1000 * 2 ** Math.min(this.failures, 8));
    return Math.round(base / 2 + this.random() * (base / 2));
  }

  /** Sends one batch. Accepted/duplicate/rejected ids are removed (rejections are terminal); network errors keep everything. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.doFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    if (this.events.length === 0 || this.now() < this.nextAttemptAt) return;
    const batch = this.events.slice(0, TELEMETRY_BATCH_MAX);
    const first = batch[0];
    if (!first) return;
    const key = `tb-${first.event_id}-${batch.length}`;
    try {
      const ack = await this.transport.send(batch, key);
      const done = new Set<string>([...ack.accepted, ...ack.duplicates, ...ack.rejected.map((r) => r.event_id).filter((x): x is string => x !== null)]);
      this.events = this.events.filter((e) => !done.has(e.event_id));
      this.failures = 0;
      this.nextAttemptAt = 0;
    } catch {
      this.failures++;
      this.nextAttemptAt = this.now() + this.backoffMs();
    }
    await this.storage.save(this.events);
  }
}
