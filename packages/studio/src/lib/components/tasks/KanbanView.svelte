<!--
  KanbanView — the INTERACTIVE agent-lifecycle dispatcher board (T11925 →
  T11928 / T11929 / T11930).

  Composes the generic `board/Board.svelte` (T11927) with the agent-lifecycle
  lane taxonomy (T11926). Lanes are resolved server-side in `+page.server.ts`;
  this view flattens the lane columns back into a flat card list + an identity
  `laneResolver` so it exercises Board's generic OCP seam (T11927 AC1).

  ## Interactive M5 increment

   - **Drag→transition (T11928):** dragging a card to a new lane persists the
     implied `tasks.status` change via `POST /api/tasks/[id]/transition` (gateway
     SDK first, in-process core fallback). The move is applied OPTIMISTICALLY and
     REVERTED on a gateway/validation error, surfaced as a toast. Invalid moves
     (drag to Done, into a resolved lane) are rejected by the pure
     {@link import('./lane-transition.js').planLaneTransition} rules — both
     client-side (no wasted request) AND re-validated server-side.
   - **Dispatch→spawn (T11930):** selecting a Backlog/Ready card opens the
     {@link import('./ConductorBar.svelte').default}; confirming dispatch calls
     `POST /api/tasks/[id]/dispatch` which spawns a worker SERVER-SIDE via the
     gateway `orchestrate.spawn`. The card moves to Running on success.
   - **Live worker stream (T11929):** selecting a Running card opens the
     {@link import('./WorkerStreamPanel.svelte').default}, which tails the
     per-task SSE stream (output + usage meter + checkpoints).

  Live refresh: subscribes to the existing `/api/tasks/events` SSE stream and
  invalidates the page data on `task-updated`, so the board reflects new
  spawns / completions / transitions within the poll window.

  @task T11925
  @task T11928
  @task T11929
  @task T11930
  @epic T11559
-->
<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { Board, type BoardCard, type BoardLane } from '$lib/components/board';
  import { DetailDrawer } from '$lib/components/tasks';
  import HeroHeader from '$lib/components/shell/HeroHeader.svelte';
  import { Button } from '$lib/ui';
  import type { Task } from '@cleocode/contracts';
  import {
    type AgentLifecycleLane,
    AGENT_LIFECYCLE_LANES,
  } from './agent-lifecycle-lane.js';
  import ConductorBar from './ConductorBar.svelte';
  import { planLaneTransition } from './lane-transition.js';
  import WorkerStreamPanel from './WorkerStreamPanel.svelte';

  /** A lane column as produced by the server load. */
  interface LaneColumn {
    lane: BoardLane;
    cards: BoardCard[];
    count: number;
  }

  interface Props {
    /** Lane columns from `+page.server.ts` (already resolved + bucketed). */
    columns: LaneColumn[];
    /** Total tasks across all lanes. */
    total: number;
    /** Set when the project's tasks.db could not be read. */
    error?: string;
  }

  let { columns, total, error }: Props = $props();

  /** Lane definitions in board order, derived from the server columns. */
  const lanes = $derived<BoardLane[]>(columns.map((c) => c.lane));

  /**
   * Optimistic lane OVERRIDES, keyed by card id → lane id. A drag stamps the
   * target lane here immediately; a successful persist keeps it (until the next
   * server load reconciles), a failure deletes it (revert). Cleared whenever the
   * server columns change (a fresh load is authoritative).
   */
  let laneOverride = $state<Record<string, AgentLifecycleLane>>({});
  // Reset overrides when authoritative server data arrives.
  $effect(() => {
    // Touch `columns` so this re-runs on every fresh load.
    void columns;
    laneOverride = {};
  });

  /**
   * Flat card list with the resolved lane id stamped on each card. The lane is
   * the optimistic override when present, else the server-resolved lane.
   */
  const flatCards = $derived<Array<BoardCard & { __lane: string }>>(
    columns.flatMap((col) =>
      col.cards.map((card) => ({
        ...card,
        __lane: laneOverride[card.id] ?? (col.lane.id as AgentLifecycleLane),
      })),
    ),
  );

  /** Identity resolver — reads the (possibly overridden) lane id off each card. */
  function laneResolver(card: BoardCard): string {
    return (card as BoardCard & { __lane?: string }).__lane ?? 'backlog';
  }

  /** Count of cards flagged with an active worker — surfaced in the meta line. */
  const runningCount = $derived(flatCards.filter((c) => c.workerActive).length);

  // ---- Selection → drawer / conductor / stream ----
  let selectedId = $state<string | null>(null);

  const selectedCard = $derived<(BoardCard & { __lane: string }) | null>(
    selectedId ? (flatCards.find((c) => c.id === selectedId) ?? null) : null,
  );

  /** The lifecycle lane of the selected card (override-aware). */
  const selectedLane = $derived<AgentLifecycleLane | null>(
    selectedCard ? (selectedCard.__lane as AgentLifecycleLane) : null,
  );

  /** Show the ConductorBar dispatch surface for Backlog/Ready cards (T11930). */
  const showConductor = $derived(
    selectedCard !== null && (selectedLane === 'backlog' || selectedLane === 'ready'),
  );
  /** Show the live worker stream for a Running card (T11929). */
  const showStream = $derived(selectedCard !== null && selectedLane === 'running');

  /** Widen the selected presentational card to the minimal Task DetailDrawer needs. */
  const drawerTask = $derived<Task | null>(
    selectedCard
      ? {
          id: selectedCard.id,
          title: selectedCard.title,
          description: selectedCard.title,
          status: selectedCard.status,
          priority: selectedCard.priority,
          size: (selectedCard.size ?? undefined) as Task['size'],
          createdAt: new Date().toISOString(),
        }
      : null,
  );

  function handleSelect(cardId: string): void {
    selectedId = cardId;
  }

  function closeDrawer(): void {
    selectedId = null;
  }

  // ---- Toast (lightweight, inline) ----
  let toast = $state<{ kind: 'ok' | 'err'; message: string } | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  function showToast(kind: 'ok' | 'err', message: string): void {
    toast = { kind, message };
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast = null;
    }, 4200);
  }

  // ---- Drag→transition (T11928) ----
  let dispatchBusy = $state(false);

  /** Parse a `{ success, data, error }` LAFS envelope from a fetch Response. */
  async function readEnvelope(
    res: Response,
  ): Promise<{ ok: boolean; message: string; data?: unknown }> {
    try {
      const body = (await res.json()) as {
        success?: boolean;
        error?: { message?: string };
        data?: unknown;
      };
      if (res.ok && body.success !== false) {
        return { ok: true, message: 'ok', data: body.data };
      }
      return { ok: false, message: body.error?.message ?? `Request failed (${res.status})` };
    } catch {
      return { ok: false, message: `Request failed (${res.status})` };
    }
  }

  async function handleMove(cardId: string, fromLaneRaw: string, toLaneRaw: string): Promise<void> {
    const fromLane = fromLaneRaw as AgentLifecycleLane;
    const toLane = toLaneRaw as AgentLifecycleLane;

    // Client-side gate first — never issue a request for an invalid move.
    const planned = planLaneTransition(cardId, fromLane, toLane);
    if (!planned.ok) {
      showToast('err', planned.message);
      return;
    }

    // Optimistic move.
    laneOverride = { ...laneOverride, [cardId]: toLane };

    try {
      const res = await fetch(`/api/tasks/${cardId}/transition`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fromLane, toLane }),
      });
      const out = await readEnvelope(res);
      if (!out.ok) {
        // Revert the optimistic move.
        const next = { ...laneOverride };
        delete next[cardId];
        laneOverride = next;
        showToast('err', out.message);
        return;
      }
      showToast('ok', planned.plan.summary);
      // Reconcile against the authoritative store.
      void invalidateAll();
    } catch (e) {
      const next = { ...laneOverride };
      delete next[cardId];
      laneOverride = next;
      showToast('err', e instanceof Error ? e.message : 'Transition failed');
    }
  }

  // ---- Dispatch→spawn (T11930) ----
  async function handleDispatch(tier: 0 | 1 | 2): Promise<void> {
    if (!selectedCard) return;
    const cardId = selectedCard.id;
    dispatchBusy = true;
    try {
      const res = await fetch(`/api/tasks/${cardId}/dispatch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tier }),
      });
      const out = await readEnvelope(res);
      if (!out.ok) {
        showToast('err', out.message);
        return;
      }
      // Optimistically surface the worker in the Running lane + open its stream.
      laneOverride = { ...laneOverride, [cardId]: 'running' };
      showToast('ok', `Dispatched ${cardId} → worker spawning`);
      void invalidateAll();
    } catch (e) {
      showToast('err', e instanceof Error ? e.message : 'Dispatch failed');
    } finally {
      dispatchBusy = false;
    }
  }

  // ---- Live SSE refresh (board-level) ----
  let liveConnected = $state(false);

  $effect(() => {
    const src = new EventSource('/api/tasks/events');
    src.addEventListener('connected', () => {
      liveConnected = true;
    });
    src.addEventListener('task-updated', () => {
      liveConnected = true;
      void invalidateAll();
    });
    src.addEventListener('heartbeat', () => {
      liveConnected = true;
    });
    src.onerror = () => {
      liveConnected = false;
    };
    return () => src.close();
  });

  const metaLine = $derived(
    `${total} tasks · ${columns.length} lanes${runningCount > 0 ? ` · ${runningCount} running` : ''}${
      liveConnected ? ' · live' : ''
    }`,
  );

  // Defensive: keep the lane list reference for the dispatch eligibility check.
  void AGENT_LIFECYCLE_LANES;
</script>

<svelte:head>
  <title>Dispatcher Board — CLEO Studio</title>
</svelte:head>

<div class="kanban-view">
  <HeroHeader
    eyebrow="DISPATCHER"
    title="Agent Lifecycle Board"
    subtitle="Drag cards between lanes to transition · Dispatch Backlog/Ready cards to spawn a worker · watch Running cards live."
    meta={metaLine}
    liveIndicator={liveConnected}
  >
    {#snippet actions()}
      <Button variant="ghost" size="sm" href="/tasks">← Tasks</Button>
      <Button variant="ghost" size="sm" href="/tasks/pipeline">Pipeline</Button>
    {/snippet}
  </HeroHeader>

  {#if error}
    <div class="board-error" role="alert">
      <p>Could not load the board: {error}</p>
    </div>
  {:else}
    <div class="board-host">
      <Board {lanes} cards={flatCards} {laneResolver} onSelect={handleSelect} onMove={handleMove} />
    </div>
  {/if}

  <footer class="kanban-foot">
    <span class="hint">Drag to transition · Enter inspects · Dispatch spawns a worker (server-side)</span>
  </footer>
</div>

{#if toast}
  <div class="toast" class:err={toast.kind === 'err'} role="status" aria-live="polite">
    {toast.message}
  </div>
{/if}

{#if showConductor && selectedCard && selectedLane}
  <div class="dispatch-overlay">
    <ConductorBar
      taskId={selectedCard.id}
      title={selectedCard.title}
      lane={selectedLane}
      busy={dispatchBusy}
      onDispatch={handleDispatch}
      onClose={closeDrawer}
    />
  </div>
{:else if showStream && selectedCard}
  <div class="dispatch-overlay">
    <WorkerStreamPanel taskId={selectedCard.id} />
    <div class="overlay-actions">
      <Button variant="ghost" size="sm" onclick={closeDrawer}>Close stream</Button>
    </div>
  </div>
{:else if drawerTask}
  <DetailDrawer task={drawerTask} onClose={closeDrawer} />
{/if}

<style>
  .kanban-view {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    height: calc(100vh - 7rem);
    min-height: 0;
  }

  .board-host {
    flex: 1;
    min-height: 0;
  }

  .board-host :global(.board-scroll) {
    height: 100%;
  }

  .board-error {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--danger);
    background: var(--danger-soft);
    border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
    border-radius: var(--radius-md);
    padding: var(--space-6);
    text-align: center;
  }

  .kanban-foot {
    display: flex;
    justify-content: center;
    padding-top: var(--space-2);
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }

  .hint {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  /* Bottom-docked overlay for the conductor / stream surfaces. */
  .dispatch-overlay {
    position: fixed;
    right: var(--space-4);
    bottom: var(--space-4);
    width: min(520px, calc(100vw - 2 * var(--space-4)));
    z-index: 40;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    box-shadow: var(--shadow-lg, 0 10px 40px rgba(0, 0, 0, 0.35));
    border-radius: var(--radius-md);
  }

  .overlay-actions {
    display: flex;
    justify-content: flex-end;
  }

  .toast {
    position: fixed;
    left: 50%;
    bottom: var(--space-4);
    transform: translateX(-50%);
    z-index: 50;
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-md);
    background: var(--bg-elev-2, var(--bg-elev-1));
    border: 1px solid var(--accent);
    color: var(--text);
    font-size: var(--text-sm);
    box-shadow: var(--shadow-lg, 0 10px 40px rgba(0, 0, 0, 0.35));
    max-width: min(560px, calc(100vw - 2 * var(--space-4)));
  }

  .toast.err {
    border-color: var(--danger);
    color: var(--danger);
  }
</style>
