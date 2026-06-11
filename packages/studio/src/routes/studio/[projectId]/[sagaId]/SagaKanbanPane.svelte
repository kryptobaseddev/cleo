<!--
  SagaKanbanPane — the saga-scoped, LIVE kanban pane for the operator-console
  shell (T11797 · E6-RESKIN-SHELL).

  A thin wrapper over the existing `saga-board` RUNE STORE (#1059 · T11789):
  it hydrates ONCE through the gateway data layer and stays live via the
  store's SINGLE `EventSource` (`tasks.subscribe`). The shell scopes the board
  to one saga by filtering the store's cards to the saga's subtree (computed
  from the `subtreeIds` set the server load derived once from the shared
  explorer bundle) — so the pane reuses the exact same store + write-path the
  full dispatcher board uses, with NO second store and NO direct DB read.

  This component is mounted CLIENT-ONLY by the shell (`{#if browser}`) so the
  `EventSource` SSE pane never runs during SSR — the opencode `/s/[id]`
  pattern (a live session view that only hydrates on the client).

  @task T11797
  @epic T11561 — E6-RESKIN-SHELL
  @saga T11555
-->
<script lang="ts">
  import { Board, type BoardCard, type BoardLane } from '$lib/components/board';
  import { DetailDrawer } from '$lib/components/tasks';
  import {
    createSagaBoard,
    type SagaBoardCard,
  } from '$lib/stores/saga-board.svelte.js';
  import type { AgentLifecycleLane } from '$lib/components/tasks';
  import { planLaneTransition } from '$lib/components/tasks';
  import type { Task } from '@cleocode/contracts';
  import { untrack } from 'svelte';

  interface Props {
    /** The saga id this pane is scoped to (shown in the empty state). */
    sagaId: string;
    /**
     * The id set of the saga's subtree (saga + every descendant epic / task /
     * subtask), derived server-side from the shared explorer bundle. Cards
     * outside this set are filtered out so the pane shows ONLY this saga.
     */
    subtreeIds: ReadonlySet<string>;
  }

  let { sagaId, subtreeIds }: Props = $props();

  // The shared, gateway-backed live board store (root-scoped subscription).
  // The pane mounts fresh per saga, so the root is fixed for the store's life;
  // `untrack` captures the initial `sagaId` without a reactive-read warning.
  const board = createSagaBoard({ root: untrack(() => sagaId) });
  let hydrated = $state(false);

  $effect(() => {
    void board.hydrate().then(() => {
      hydrated = true;
    });
    board.connect();
    return () => board.disconnect();
  });

  /** Lane definitions in board order (static taxonomy from the store). */
  const lanes = $derived<BoardLane[]>(board.lanes);

  /** Saga-scoped cards: the store's columns, filtered to this saga's subtree. */
  const flatCards = $derived<Array<BoardCard & { __lane: string }>>(
    board.columns.flatMap((col) =>
      col.cards
        .filter((card) => subtreeIds.has(card.id))
        .map((card: SagaBoardCard) => ({ ...card, __lane: card.lane })),
    ),
  );

  /** Identity resolver — reads the resolved lane id off each card. */
  function laneResolver(card: BoardCard): string {
    return (card as BoardCard & { __lane?: string }).__lane ?? 'backlog';
  }

  // ---- Selection → drawer ----
  let selectedId = $state<string | null>(null);
  const selectedCard = $derived<(BoardCard & { __lane: string }) | null>(
    selectedId ? (flatCards.find((c) => c.id === selectedId) ?? null) : null,
  );

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

  // ---- Toast ----
  let toast = $state<{ kind: 'ok' | 'err'; message: string } | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  function showToast(kind: 'ok' | 'err', message: string): void {
    toast = { kind, message };
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast = null;
    }, 4200);
  }

  /** Drag a card to a new lane — same client gate + store write-path as the board. */
  async function handleMove(cardId: string, fromLaneRaw: string, toLaneRaw: string): Promise<void> {
    const fromLane = fromLaneRaw as AgentLifecycleLane;
    const toLane = toLaneRaw as AgentLifecycleLane;
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

  const liveConnected = $derived(hydrated && board.connected);
  const scopedTotal = $derived(flatCards.length);
</script>

<div class="saga-kanban-pane">
  <div class="pane-meta">
    <span class="count"><strong>{scopedTotal}</strong> cards in saga</span>
    <span class="live" class:connected={liveConnected}>
      <span class="live-dot" aria-hidden="true"></span>
      {liveConnected ? 'live' : 'connecting…'}
    </span>
  </div>

  {#if hydrated && scopedTotal === 0}
    <div class="empty-state">
      <p>No active cards in <code>{sagaId}</code>.</p>
    </div>
  {:else}
    <div class="board-host">
      <Board {lanes} cards={flatCards} {laneResolver} onSelect={handleSelect} onMove={handleMove} />
    </div>
  {/if}
</div>

{#if toast}
  <div class="toast" class:err={toast.kind === 'err'} role="status" aria-live="polite">
    {toast.message}
  </div>
{/if}

{#if drawerTask}
  <DetailDrawer task={drawerTask} onClose={closeDrawer} />
{/if}

<style>
  .saga-kanban-pane {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    height: 100%;
    min-height: 0;
  }

  .pane-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .count {
    font-size: var(--text-xs);
    color: var(--text-dim);
  }

  .count strong {
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }

  .live {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .live-dot {
    width: 0.4rem;
    height: 0.4rem;
    border-radius: var(--radius-pill);
    background: var(--neutral);
  }

  .live.connected {
    color: var(--success);
  }

  .live.connected .live-dot {
    background: var(--success);
    animation: var(--ease-pulse) pulse;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.4;
    }
  }

  .board-host {
    flex: 1;
    min-height: 0;
  }

  .board-host :global(.board-scroll) {
    height: 100%;
  }

  .empty-state {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-faint);
    font-size: var(--text-sm);
  }

  .empty-state code {
    font-family: var(--font-mono);
    color: var(--text-dim);
  }

  .toast {
    position: fixed;
    left: 50%;
    bottom: var(--space-4);
    transform: translateX(-50%);
    z-index: 50;
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-md);
    background: var(--bg-elev-2);
    border: 1px solid var(--accent);
    color: var(--text);
    font-size: var(--text-sm);
    box-shadow: var(--shadow-lg);
    max-width: min(560px, calc(100vw - 2 * var(--space-4)));
  }

  .toast.err {
    border-color: var(--danger);
    color: var(--danger);
  }
</style>
