/**
 * Pure aggregation for the LIVE WORKER STREAM on a Running-lane card
 * (T11929 · M5).
 *
 * A Running card subscribes to a per-task SSE stream (the Studio
 * `/api/tasks/[id]/stream` endpoint, which mirrors the existing
 * `/api/tasks/events` `createSseStream` pattern). Each frame is one
 * {@link WorkerStreamFrame}; this module folds a sequence of frames into a
 * single render-ready {@link WorkerStreamView} — the output tail, the usage /
 * cost meter, the heartbeat, and the proof checkpoints (commit / PR / test).
 *
 * Keeping the fold pure + framework-free lets it be unit-tested under vitest's
 * node environment (mirroring {@link import('./agent-lifecycle-lane.js')}) and
 * keeps the Svelte card a thin renderer that owns only the EventSource
 * lifecycle (subscribe on open, unsubscribe on close, reconnect on drop).
 *
 * @task T11929
 * @epic T11559
 */

/** The kinds of frame a worker stream emits. */
export type WorkerStreamFrameKind =
  | 'connected'
  | 'output'
  | 'usage'
  | 'checkpoint'
  | 'heartbeat'
  | 'done';

/** A proof checkpoint a worker reaches — surfaced as a chip on the card. */
export type WorkerCheckpointKind = 'commit' | 'pr' | 'test';

/** Usage / cost snapshot carried by a `usage` frame. */
export interface WorkerUsageSnapshot {
  /** Cumulative input tokens for this worker's task. */
  inputTokens: number;
  /** Cumulative output tokens for this worker's task. */
  outputTokens: number;
  /** Cumulative total tokens (input + output). */
  totalTokens: number;
  /** Number of token-usage records aggregated. */
  records: number;
}

/** A proof checkpoint payload (commit sha / PR number / test result). */
export interface WorkerCheckpoint {
  /** Checkpoint kind. */
  kind: WorkerCheckpointKind;
  /** Short human-readable label (e.g. a sha7, `#123`, `42 passed`). */
  label: string;
  /** ISO timestamp the checkpoint was observed. */
  ts: string;
}

/**
 * One frame off the worker stream. The `data` shape is narrowed per `kind` at
 * the fold site; the union keeps the wire contract explicit + testable.
 */
export type WorkerStreamFrame =
  | { kind: 'connected'; ts: string }
  | { kind: 'output'; ts: string; line: string }
  | { kind: 'usage'; ts: string; usage: WorkerUsageSnapshot }
  | { kind: 'checkpoint'; ts: string; checkpoint: WorkerCheckpoint }
  | { kind: 'heartbeat'; ts: string }
  | { kind: 'done'; ts: string; reason?: string };

/** Live-connection state of the stream, driving the card's status dot. */
export type WorkerStreamStatus = 'connecting' | 'live' | 'stalled' | 'ended';

/** The folded, render-ready view-model for a worker stream. */
export interface WorkerStreamView {
  /** Connection state. */
  status: WorkerStreamStatus;
  /**
   * The tail of the worker's output — most-recent-last, capped at
   * {@link DEFAULT_OUTPUT_TAIL}. The card renders this in a mono scroll.
   */
  outputTail: string[];
  /** Latest usage / cost snapshot, or `null` until a `usage` frame arrives. */
  usage: WorkerUsageSnapshot | null;
  /** Proof checkpoints reached, in observation order. */
  checkpoints: WorkerCheckpoint[];
  /** ISO timestamp of the most recent frame of ANY kind (the heartbeat clock). */
  lastFrameTs: string | null;
}

/** How many output lines the tail retains (older lines roll off). */
export const DEFAULT_OUTPUT_TAIL = 200;

/**
 * The empty view-model — the initial state before any frame arrives.
 *
 * @returns A fresh {@link WorkerStreamView} in the `connecting` state.
 */
export function emptyWorkerStreamView(): WorkerStreamView {
  return {
    status: 'connecting',
    outputTail: [],
    usage: null,
    checkpoints: [],
    lastFrameTs: null,
  };
}

/**
 * Fold ONE frame into the running view-model, returning a NEW view (pure — never
 * mutates the input). The Svelte card holds the view in `$state` and reassigns
 * it per frame so reactivity fires.
 *
 * @param view - The current view-model.
 * @param frame - The frame to apply.
 * @param maxTail - Output-tail cap (defaults to {@link DEFAULT_OUTPUT_TAIL}).
 * @returns The next view-model.
 */
export function applyWorkerStreamFrame(
  view: WorkerStreamView,
  frame: WorkerStreamFrame,
  maxTail: number = DEFAULT_OUTPUT_TAIL,
): WorkerStreamView {
  const lastFrameTs = frame.ts;

  switch (frame.kind) {
    case 'connected':
      return { ...view, status: 'live', lastFrameTs };
    case 'heartbeat':
      return { ...view, status: 'live', lastFrameTs };
    case 'output': {
      const next = [...view.outputTail, frame.line];
      const outputTail = next.length > maxTail ? next.slice(next.length - maxTail) : next;
      return { ...view, status: 'live', outputTail, lastFrameTs };
    }
    case 'usage':
      return { ...view, status: 'live', usage: frame.usage, lastFrameTs };
    case 'checkpoint':
      return {
        ...view,
        status: 'live',
        checkpoints: [...view.checkpoints, frame.checkpoint],
        lastFrameTs,
      };
    case 'done':
      return { ...view, status: 'ended', lastFrameTs };
    default: {
      // Exhaustiveness guard — a new frame kind must be handled above.
      const _never: never = frame;
      return view;
    }
  }
}

/**
 * Format a {@link WorkerUsageSnapshot} into a compact meter string for the card,
 * e.g. `"12.4k tok · 3 calls"`. Returns a dash when no usage yet.
 *
 * @param usage - The usage snapshot, or `null`.
 * @returns A compact human-readable meter label.
 */
export function formatUsageMeter(usage: WorkerUsageSnapshot | null): string {
  if (!usage || usage.totalTokens === 0) return '— tokens';
  const tok =
    usage.totalTokens >= 1000
      ? `${(usage.totalTokens / 1000).toFixed(1)}k`
      : String(usage.totalTokens);
  const calls = usage.records === 1 ? '1 call' : `${usage.records} calls`;
  return `${tok} tok · ${calls}`;
}

/**
 * Decide whether a stream that last spoke at {@link lastFrameTs} is STALLED
 * (no frame within the staleness window) — drives a graceful "reconnecting"
 * affordance distinct from a clean `done`.
 *
 * @param view - The current view-model.
 * @param now - Current epoch ms (injectable for tests).
 * @param staleMs - Staleness threshold in ms.
 * @returns `true` when the stream is live-but-silent past the threshold.
 */
export function isStreamStalled(view: WorkerStreamView, now: number, staleMs: number): boolean {
  if (view.status === 'ended' || view.lastFrameTs === null) return false;
  const last = Date.parse(view.lastFrameTs);
  if (Number.isNaN(last)) return false;
  return now - last > staleMs;
}
