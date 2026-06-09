/**
 * Pure aggregation for the LIVE WORKER STREAM rendered on a focused Running-lane
 * card in the `cleo tui` cockpit (T11936 · M5).
 *
 * A focused Running card subscribes to the gateway SSE stream
 * (`GET /v1/orchestrate/events`, T11921) and folds the sequence of
 * {@link import('@cleocode/contracts/gateway').GatewayStreamEvent} frames into a
 * single render-ready {@link WorkerStreamView}: the worker output tail, the
 * usage / cost meter, the heartbeat clock, and any proof checkpoints. The fold
 * mirrors the Studio worker-stream fold (relate T11936 ↔ T11929) so the terminal
 * and web surfaces render the SAME live-worker semantics from the SAME wire
 * frames — one stream contract, two renderers, zero divergence.
 *
 * This module is deliberately FRAMEWORK-FREE — no pi-tui, no `node:http`, no
 * gateway client. It takes already-decoded {@link GatewayStreamEvent} frames and
 * returns plain view-models + render lines, so the fold + the meter formatting
 * are trivially unit-testable under vitest's node environment without a TTY, a
 * socket, or the optional pi-tui dep. The SSE socket lifecycle (subscribe on
 * focus, unsubscribe on blur/close, degrade when the daemon is down) lives in
 * the {@link import('./sse-client.js') | SSE client} and is wired by the cockpit.
 *
 * ## Frame mapping (gateway `GatewayStreamEvent` → worker view)
 *
 * The gateway emits a generic `{ kind: 'data' | 'done' | 'error', seq, data }`
 * frame. The cockpit's running-worker source carries the lifecycle payload in
 * `data`; this fold narrows that payload defensively (every field optional, read
 * with a type guard) so a heartbeat tick, an output line, a usage snapshot, and
 * a checkpoint all route to the right slot, and an unrecognised `data` frame is
 * treated as a heartbeat (it still proves the stream is live) rather than
 * crashing the view.
 *
 * @task T11936
 * @epic T11916
 * @see packages/studio/src/lib/components/tasks/worker-stream.ts — the Studio fold (relate T11929)
 */

import type { GatewayStreamEvent } from '@cleocode/contracts/gateway';

/** Live-connection state of the stream, driving the panel's status indicator. */
export type WorkerStreamStatus = 'connecting' | 'live' | 'stalled' | 'ended' | 'error';

/** Usage / cost snapshot folded from `usage`-bearing frames. */
export interface WorkerUsageSnapshot {
  /** Cumulative input tokens for this worker's task. */
  readonly inputTokens: number;
  /** Cumulative output tokens for this worker's task. */
  readonly outputTokens: number;
  /** Cumulative total tokens (input + output). */
  readonly totalTokens: number;
  /** Number of token-usage records aggregated. */
  readonly records: number;
}

/** A proof checkpoint a worker reaches — surfaced as a chip in the panel. */
export interface WorkerCheckpoint {
  /** Checkpoint kind. */
  readonly kind: 'commit' | 'pr' | 'test';
  /** Short human-readable label (e.g. a sha7, `#123`, `42 passed`). */
  readonly label: string;
}

/** The folded, render-ready view-model for one worker stream. */
export interface WorkerStreamView {
  /** Connection state. */
  readonly status: WorkerStreamStatus;
  /**
   * The tail of the worker's output — most-recent-last, capped at
   * {@link DEFAULT_OUTPUT_TAIL}. The panel renders the last N of these.
   */
  readonly outputTail: readonly string[];
  /** Latest usage / cost snapshot, or `null` until a usage frame arrives. */
  readonly usage: WorkerUsageSnapshot | null;
  /** Proof checkpoints reached, in observation order. */
  readonly checkpoints: readonly WorkerCheckpoint[];
  /** ISO timestamp of the most recent frame of ANY kind (the heartbeat clock). */
  readonly lastFrameTs: string | null;
  /** A terminal error message, when the stream ended via an `error` frame. */
  readonly error: string | null;
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
    error: null,
  };
}

/** Read a string field off a loosely-typed payload, or `undefined`. */
function readString(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key];
  return typeof v === 'string' ? v : undefined;
}

/** Read a finite-number field off a loosely-typed payload, or `0`. */
function readNumber(payload: Record<string, unknown>, key: string): number {
  const v = payload[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Narrow a frame's `data` payload into a {@link WorkerUsageSnapshot} when it
 * carries token-usage fields, else `null`. Accepts either a nested `usage`
 * object or flat `inputTokens` / `outputTokens` / `totalTokens` fields.
 *
 * @param payload - The frame `data` object.
 * @returns A usage snapshot, or `null` when the payload carries no usage.
 */
function readUsage(payload: Record<string, unknown>): WorkerUsageSnapshot | null {
  const source =
    payload.usage && typeof payload.usage === 'object'
      ? (payload.usage as Record<string, unknown>)
      : payload;
  const hasUsage =
    'inputTokens' in source ||
    'outputTokens' in source ||
    'totalTokens' in source ||
    'records' in source;
  if (!hasUsage) return null;
  const inputTokens = readNumber(source, 'inputTokens');
  const outputTokens = readNumber(source, 'outputTokens');
  const totalTokens =
    'totalTokens' in source ? readNumber(source, 'totalTokens') : inputTokens + outputTokens;
  const records = 'records' in source ? readNumber(source, 'records') : 1;
  return { inputTokens, outputTokens, totalTokens, records };
}

/**
 * Narrow a frame's `data` payload into a {@link WorkerCheckpoint} when it carries
 * a `checkpoint` of a known kind, else `null`.
 *
 * @param payload - The frame `data` object.
 * @returns A checkpoint, or `null` when the payload carries none.
 */
function readCheckpoint(payload: Record<string, unknown>): WorkerCheckpoint | null {
  const cp = payload.checkpoint;
  if (cp === null || typeof cp !== 'object') return null;
  const obj = cp as Record<string, unknown>;
  const kind = obj.kind;
  if (kind !== 'commit' && kind !== 'pr' && kind !== 'test') return null;
  const label = readString(obj, 'label') ?? '';
  return { kind, label };
}

/**
 * Fold ONE {@link GatewayStreamEvent} frame into the running view-model,
 * returning a NEW view (pure — never mutates the input).
 *
 * Frame routing:
 *  - `error` → terminal `error` state, carrying the error message.
 *  - `done`  → terminal `ended` state.
 *  - `data`  → narrowed by payload shape: an `output` line appends to the tail,
 *              a `usage` snapshot updates the meter, a `checkpoint` is recorded;
 *              anything else is a heartbeat (proves the stream is live).
 *
 * @param view - The current view-model.
 * @param frame - The decoded gateway stream frame to apply.
 * @param maxTail - Output-tail cap (defaults to {@link DEFAULT_OUTPUT_TAIL}).
 * @returns The next view-model.
 */
export function applyWorkerStreamFrame(
  view: WorkerStreamView,
  frame: GatewayStreamEvent,
  maxTail: number = DEFAULT_OUTPUT_TAIL,
): WorkerStreamView {
  if (frame.kind === 'error') {
    return {
      ...view,
      status: 'error',
      error: frame.error?.message ?? 'stream error',
    };
  }

  const payload =
    frame.data && typeof frame.data === 'object'
      ? (frame.data as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const lastFrameTs = readString(payload, 'ts') ?? new Date().toISOString();

  if (frame.kind === 'done') {
    return { ...view, status: 'ended', lastFrameTs };
  }

  // kind === 'data' — narrow by payload shape.
  const usage = readUsage(payload);
  if (usage !== null) {
    return { ...view, status: 'live', usage, lastFrameTs };
  }

  const checkpoint = readCheckpoint(payload);
  if (checkpoint !== null) {
    return {
      ...view,
      status: 'live',
      checkpoints: [...view.checkpoints, checkpoint],
      lastFrameTs,
    };
  }

  const line = readString(payload, 'line') ?? readString(payload, 'output');
  if (line !== undefined) {
    const next = [...view.outputTail, line];
    const outputTail = next.length > maxTail ? next.slice(next.length - maxTail) : next;
    return { ...view, status: 'live', outputTail, lastFrameTs };
  }

  // Unrecognised data payload (e.g. a `{ tick, ts }` heartbeat) — the stream is
  // live; just advance the heartbeat clock.
  return { ...view, status: 'live', lastFrameTs };
}

/**
 * Format a {@link WorkerUsageSnapshot} into a compact meter string, e.g.
 * `"12.4k tok · 3 calls"`. Returns a dash when no usage yet.
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
 * Render the worker stream as plain-text panel lines — one string per terminal
 * line. Used both as the body of the cockpit's pi-tui worker panel AND as a
 * graceful fallback render. Shows the connection state, usage meter, checkpoint
 * chips, and the output tail (capped to `tailLines`).
 *
 * @param taskId - The Running-lane task whose worker is streaming.
 * @param view - The folded stream view-model.
 * @param options - Optional cap on the number of output lines rendered.
 * @returns Panel lines (no trailing newline per line).
 */
export function renderWorkerStreamPanel(
  taskId: string,
  view: WorkerStreamView,
  options?: { readonly tailLines?: number },
): string[] {
  const tailLines = options?.tailLines ?? 8;
  const lines: string[] = [];
  const statusDot =
    view.status === 'live'
      ? '●'
      : view.status === 'ended'
        ? '✓'
        : view.status === 'error'
          ? '✗'
          : view.status === 'stalled'
            ? '◌'
            : '○';
  lines.push(
    `── Worker ${taskId}  ${statusDot} ${view.status}  ·  ${formatUsageMeter(view.usage)}`,
  );

  if (view.checkpoints.length > 0) {
    const chips = view.checkpoints.map((c) => `${c.kind}:${c.label}`).join('  ');
    lines.push(`   ${chips}`);
  }

  if (view.status === 'error' && view.error) {
    lines.push(`   error: ${view.error}`);
  }

  const tail = view.outputTail.slice(Math.max(0, view.outputTail.length - tailLines));
  if (tail.length === 0) {
    lines.push('   (waiting for worker output…)');
  } else {
    for (const out of tail) lines.push(`   │ ${out}`);
  }

  return lines;
}

/**
 * Decide whether a stream that last spoke at {@link WorkerStreamView.lastFrameTs}
 * is STALLED (no frame within the staleness window) — drives a "reconnecting"
 * affordance distinct from a clean `ended`.
 *
 * @param view - The current view-model.
 * @param now - Current epoch ms (injectable for tests).
 * @param staleMs - Staleness threshold in ms.
 * @returns `true` when the stream is live-but-silent past the threshold.
 */
export function isStreamStalled(view: WorkerStreamView, now: number, staleMs: number): boolean {
  if (view.status === 'ended' || view.status === 'error' || view.lastFrameTs === null) return false;
  const last = Date.parse(view.lastFrameTs);
  if (Number.isNaN(last)) return false;
  return now - last > staleMs;
}
