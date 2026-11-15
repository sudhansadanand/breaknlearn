/**
 * Server-side progress merge (M09). Clocks are untrusted; revisions decide.
 * Identity: (learner, lesson, theme, attempt). Within an attempt completion is monotonic and
 * the furthest slide wins; a restart is a new attempt, never an overwrite.
 */
export interface ServerProgress {
  readonly slide_index: number;
  readonly position_seconds: number;
  readonly completed: boolean;
  readonly server_revision: number;
  readonly client_revision: number;
}

export interface IncomingProgress {
  readonly slide_index: number;
  readonly position_seconds: number;
  readonly completed: boolean;
  readonly client_revision: number;
  readonly base_server_revision: number | null;
}

export type MergeOutcome = { outcome: "applied" | "merged" | "stale_ignored"; next: ServerProgress };

export function mergeProgress(current: ServerProgress | null, incoming: IncomingProgress): MergeOutcome {
  if (!current) {
    return { outcome: "applied", next: { ...pick(incoming), server_revision: 1, client_revision: incoming.client_revision } };
  }
  const completed = current.completed || incoming.completed;
  const furthest = incoming.slide_index > current.slide_index || (incoming.slide_index === current.slide_index && incoming.position_seconds > current.position_seconds) ? incoming : current;
  const changed = completed !== current.completed || furthest !== current;
  if (incoming.client_revision <= current.client_revision && !changed) return { outcome: "stale_ignored", next: current };
  if (!changed) return { outcome: "stale_ignored", next: { ...current, client_revision: Math.max(current.client_revision, incoming.client_revision) } };
  const outcome = incoming.base_server_revision === current.server_revision ? "applied" : "merged";
  return {
    outcome,
    next: {
      slide_index: completed ? Math.max(furthest.slide_index, current.slide_index) : furthest.slide_index,
      position_seconds: furthest.position_seconds,
      completed,
      server_revision: current.server_revision + 1,
      client_revision: Math.max(current.client_revision, incoming.client_revision),
    },
  };
}

function pick(p: IncomingProgress) {
  return { slide_index: p.slide_index, position_seconds: p.position_seconds, completed: p.completed };
}
