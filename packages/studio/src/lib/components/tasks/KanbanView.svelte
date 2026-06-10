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

  Live refresh (T11789 · E2): the INTERACTIVE board is now backed by the
  `saga-board` Svelte-5 RUNE STORE. The store hydrates once through the gateway
  data layer (`GET /api/tasks`) and is kept live by ONE `EventSource` to the
  `tasks.subscribe` delegate (`/api/tasks/subscribe`) — REPLACING the prior 2 s
  `/api/tasks/events` poll + page `invalidateAll`. The server-load `columns` are
  the SSR first-paint; the store takes over on the client and every drag /
  dispatch / live event reconciles against the gateway through the command seam.

  @task T11925
  @task T11928
  @task T11929
  @task T11930
  @task T11789
  @epic T11559
-->
<script lang="ts">
  import { Board, type BoardCard, type BoardLane } from '$lib/components/board';
  import { DetailDrawer } from '$lib/components/tasks';
  import HeroHeader from '$lib/components/shell/HeroHeader.svelte';
  import {
    createSagaBoard,
    type SagaBoardCard,
  } from '$lib/stores/saga-board.svelte.js';
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
    /** Lane columns from `+page.server.ts` (the SSR first paint). */
    columns: LaneColumn[];
    /** Total tasks across all lanes (SSR). */
    total: number;
    /** Set when the project's tasks.db could not be read. */
    error?: string;
  }

  let { columns, total, error }: Props = $props();

  // ---- Saga-board rune store (T11789) — the live, gateway-backed data layer ----
  const board = createSagaBoard();
  /** True once the store has completed its first hydration (takes over from SSR). */
  let hydrated = $state(false);

  $effect(() => {
    // Hydrate once + open the SINGLE live subscription; tear it down on unmount.
    void board.hydrate().then(() => {
      hydrated = true;
    });
    board.connect();
    return () => board.disconnect();
  });

  /**
   * SSR columns mapped to the store's `SagaBoardCard` shape for the first paint,
   * so the board renders instantly before the client store hydrates.
   */
  const ssrColumns = $derived<Array<{ lane: BoardLane; cards: SagaBoardCard[]; count: number }>>(
    columns.map((col) => ({
      lane: col.lane,
      count: col.count,
      cards: col.cards.map((card) => ({ ...card, lane: col.lane.id as AgentLifecycleLane })),
    })),
  );

  /** The authoritative columns: the live store once hydrated, else the SSR paint. */
  const boardColumns = $derived(hydrated ? board.columns : ssrColumns);

  /** Lane definitions in board order. */
  const lanes = $derived<BoardLane[]>(boardColumns.map((c) => c.lane));

  /** Flat card list with each card's resolved lane stamped on (`__lane`). */
  const flatCards = $derived<Array<BoardCard & { __lane: string }>>(
    boardColumns.flatMap((col) =>
      col.cards.map((card) => ({ ...card, __lane: card.lane })),
    ),
  );

  /** Identity resolver — reads the resolved lane id off each card. */
  function laneResolver(card: BoardCard): string {
    return (card as BoardCard & { __lane?: string }).__lane ?? 'backlog';
  }

  /** Live counts — the store's once hydrated, else the SSR snapshot. */
  const liveTotal = $derived(hydrated ? board.total : total);
  const runningCount = $derived(
    hydrated ? board.runningCount : flatCards.filter((c) => c.workerActive).length,
  );

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

  // ---- Drag→transition (T11928 → store-backed, T11789) ----
  let dispatchBusy = $state(false);

  /**
   * Drag a card to a new lane. The client-side {@link planLaneTransition} gate
   * rejects invalid moves before any request; the store owns the optimistic
   * override + the gateway persist + the revert-on-failure.
   */
  async function handleMove(cardId: string, fromLaneRaw: string, toLaneRaw: string): Promise<void> {
    const fromLane = fromLaneRaw as AgentLifecycleLane;
    const toLane = toLaneRaw as AgentLifecycleLane;

    // Client-side gate first — never issue a request for an invalid move.
    const planned = planLaneTransition(cardId, fromLane, toLane);
    if (!planned.ok) {
      showToast('err', planned.message);
      return;
    }

    const result = await board.move(cardId, fromLane, toLane);
    if (!result.ok) {
      showToast('err', result.message);
      return;
    }
    showToast('ok', planned.plan.summary);
  }

  // ---- Dispatch→spawn (T11930 → store-backed, T11789) ----
  async function handleDispatch(tier: 0 | 1 | 2): Promise<void> {
    if (!selectedCard) return;
    const cardId = selectedCard.id;
    dispatchBusy = true;
    try {
      const result = await board.dispatch(cardId, tier);
      if (!result.ok) {
        showToast('err', result.message);
        return;
      }
      showToast('ok', `Dispatched ${cardId} → worker spawning`);
    } finally {
      dispatchBusy = false;
    }
  }

  // ---- Live indicator (driven by the store's ONE subscription) ----
  const liveConnected = $derived(hydrated && board.connected);

  const metaLine = $derived(
    `${liveTotal} tasks · ${lanes.length} lanes${runningCount > 0 ? ` · ${runningCount} running` : ''}${
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
