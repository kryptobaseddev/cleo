<!--
  WorkerStreamPanel — live worker output + usage meter for a Running card
  (T11929 · M5).

  Subscribes to the per-task SSE stream (`/api/tasks/[id]/stream`, which mirrors
  the existing `/api/tasks/events` `createSseStream` pattern) and renders the
  worker's output tail, a usage / cost meter, and proof checkpoints. ONE
  EventSource per open card — no per-card polling. Frames are folded with the
  pure {@link import('./worker-stream.js')} model so all stream logic stays
  unit-tested; this component owns only the EventSource lifecycle:

    - subscribe on mount,
    - graceful reconnect on stream drop (`onerror` → re-open with backoff),
    - clean unsubscribe on destroy (card close).

  @task T11929
  @epic T11559
-->
<script lang="ts">
  import { Badge } from '$lib/ui';
  import {
    applyWorkerStreamFrame,
    emptyWorkerStreamView,
    formatUsageMeter,
    isStreamStalled,
    type WorkerCheckpointKind,
    type WorkerStreamFrame,
    type WorkerStreamView,
  } from './worker-stream.js';

  interface Props {
    /** The Running task whose worker stream to tail. */
    taskId: string;
  }

  let { taskId }: Props = $props();

  /** Folded, render-ready stream view-model. */
  let view = $state<WorkerStreamView>(emptyWorkerStreamView());
  /** Wall-clock tick so the staleness derivation re-evaluates. */
  let nowMs = $state(Date.now());

  /** Staleness window — silent past this ⇒ show "reconnecting". */
  const STALE_MS = 8000;

  /** Apply one decoded frame to the view-model. */
  function push(frame: WorkerStreamFrame): void {
    view = applyWorkerStreamFrame(view, frame);
    nowMs = Date.now();
  }

  /** Derived live label for the status dot. */
  const stalled = $derived(isStreamStalled(view, nowMs, STALE_MS));
  const statusLabel = $derived(
    view.status === 'ended'
      ? 'ended'
      : view.status === 'connecting'
        ? 'connecting'
        : stalled
          ? 'reconnecting'
          : 'live',
  );

  const usageMeter = $derived(formatUsageMeter(view.usage));

  /** Tone for a checkpoint chip by kind. */
  function checkpointTone(kind: WorkerCheckpointKind): 'accent' | 'success' | 'info' {
    if (kind === 'test') return 'success';
    if (kind === 'pr') return 'info';
    return 'accent';
  }

  // ---- EventSource lifecycle (subscribe / reconnect / unsubscribe) ----
  $effect(() => {
    // Re-subscribe whenever taskId changes; reset the view for the new card.
    view = emptyWorkerStreamView();

    let src: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    /** A safe JSON parse — drops a malformed frame rather than throwing. */
    function parse<T>(raw: string): T | null {
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    }

    function open(): void {
      if (closed) return;
      src = new EventSource(`/api/tasks/${taskId}/stream`);

      src.addEventListener('connected', (e) => {
        const d = parse<{ ts: string }>((e as MessageEvent).data);
        push({ kind: 'connected', ts: d?.ts ?? new Date().toISOString() });
      });
      src.addEventListener('output', (e) => {
        const d = parse<{ ts: string; line: string }>((e as MessageEvent).data);
        if (d) push({ kind: 'output', ts: d.ts, line: d.line });
      });
      src.addEventListener('usage', (e) => {
        const d = parse<{ ts: string; usage: WorkerStreamView['usage'] }>((e as MessageEvent).data);
        if (d?.usage) push({ kind: 'usage', ts: d.ts, usage: d.usage });
      });
      src.addEventListener('checkpoint', (e) => {
        const d = parse<{ ts: string; checkpoint: { kind: WorkerCheckpointKind; label: string; ts: string } }>(
          (e as MessageEvent).data,
        );
        if (d?.checkpoint) push({ kind: 'checkpoint', ts: d.ts, checkpoint: d.checkpoint });
      });
      src.addEventListener('heartbeat', (e) => {
        const d = parse<{ ts: string }>((e as MessageEvent).data);
        push({ kind: 'heartbeat', ts: d?.ts ?? new Date().toISOString() });
      });
      src.addEventListener('done', (e) => {
        const d = parse<{ ts: string; reason?: string }>((e as MessageEvent).data);
        push({ kind: 'done', ts: d?.ts ?? new Date().toISOString(), reason: d?.reason });
        // A clean terminal — stop reconnecting.
        closed = true;
        src?.close();
      });

      // Graceful reconnect: on a transport drop, close + retry after a short
      // backoff (the browser also auto-reconnects, but we re-open explicitly so
      // a server restart is recovered deterministically).
      src.onerror = () => {
        if (closed) return;
        src?.close();
        src = null;
        nowMs = Date.now();
        retry = setTimeout(open, 2000);
      };
    }

    open();

    // Keep the staleness clock advancing so "reconnecting" surfaces even when
    // the stream is silent (no frames to bump nowMs).
    const clock = setInterval(() => {
      nowMs = Date.now();
    }, 2000);

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      clearInterval(clock);
      src?.close();
    };
  });
</script>

<section class="worker-stream" aria-label={`Live worker stream for ${taskId}`}>
  <header class="ws-head">
    <span class="ws-title">Worker · {taskId}</span>
    <span class="ws-status" class:live={statusLabel === 'live'} class:ended={statusLabel === 'ended'}>
      <span class="dot" aria-hidden="true"></span>{statusLabel}
    </span>
    <span class="ws-meter" title="Cumulative token usage for this task">{usageMeter}</span>
  </header>

  {#if view.checkpoints.length > 0}
    <div class="ws-checkpoints">
      {#each view.checkpoints as cp, i (i)}
        <Badge tone={checkpointTone(cp.kind)} size="sm">{cp.kind}: {cp.label}</Badge>
      {/each}
    </div>
  {/if}

  <div class="ws-output" role="log" aria-live="polite">
    {#if view.outputTail.length === 0}
      <p class="ws-empty">Waiting for worker output…</p>
    {:else}
      {#each view.outputTail as line, i (i)}
        <div class="ws-line">{line}</div>
      {/each}
    {/if}
  </div>
</section>

<style>
  .worker-stream {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    min-height: 0;
  }

  .ws-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .ws-title {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-dim);
    font-weight: 600;
  }

  .ws-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .ws-status .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--text-faint);
  }
  .ws-status.live {
    color: var(--accent);
  }
  .ws-status.live .dot {
    background: var(--accent);
    animation: ws-pulse 1.6s ease-in-out infinite;
  }
  .ws-status.ended .dot {
    background: var(--text-faint);
  }

  .ws-meter {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }

  .ws-checkpoints {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }

  .ws-output {
    flex: 1;
    overflow-y: auto;
    max-height: 220px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: var(--space-2);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    line-height: 1.5;
    color: var(--text-dim);
  }

  .ws-line {
    white-space: pre-wrap;
    word-break: break-word;
  }

  .ws-empty {
    margin: 0;
    color: var(--text-faint);
    font-style: italic;
  }

  @keyframes ws-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.5;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .ws-status.live .dot {
      animation: none;
    }
  }
</style>
