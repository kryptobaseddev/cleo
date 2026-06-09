<!--
  KanbanView — the read-only agent-lifecycle dispatcher board (T11925).

  Composes the generic `board/Board.svelte` (T11927) with the agent-lifecycle
  lane taxonomy (T11926). Lanes are resolved server-side in `+page.server.ts`;
  this view flattens the lane columns back into a flat card list + an identity
  `laneResolver` so it exercises Board's generic OCP seam (T11927 AC1) without
  re-running the resolver in the browser.

  Live refresh: subscribes to the existing `/api/tasks/events` SSE stream and
  invalidates the page data on `task-updated`, so the board reflects new
  spawns / completions within the 2s poll window (T11925).

  READ-ONLY v1: cards are inert beyond selection (no drag, no dispatch, no
  per-worker live output). Those write paths are deferred to the M5-blocked
  tasks — see the TODO seams below.

  @task T11925
  @epic T11559
-->
<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { Board, type BoardCard, type BoardLane } from '$lib/components/board';
  import { DetailDrawer } from '$lib/components/tasks';
  import HeroHeader from '$lib/components/shell/HeroHeader.svelte';
  import { Button } from '$lib/ui';
  import type { Task } from '@cleocode/contracts';

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
   * Flat card list with the resolved lane id stamped on each card, so Board's
   * generic `laneResolver` can route them without re-deriving lifecycle state
   * client-side. `__lane` is a transient render key, never persisted.
   */
  const flatCards = $derived<Array<BoardCard & { __lane: string }>>(
    columns.flatMap((col) => col.cards.map((card) => ({ ...card, __lane: col.lane.id }))),
  );

  /** Identity resolver — reads the server-stamped lane id off each card. */
  function laneResolver(card: BoardCard): string {
    return (card as BoardCard & { __lane?: string }).__lane ?? 'backlog';
  }

  /** Count of cards flagged with an active worker — surfaced in the meta line. */
  const runningCount = $derived(flatCards.filter((c) => c.workerActive).length);

  // ---- Selection → DetailDrawer (read-only inspect) ----
  let selectedId = $state<string | null>(null);

  const selectedCard = $derived<(BoardCard & { __lane: string }) | null>(
    selectedId ? (flatCards.find((c) => c.id === selectedId) ?? null) : null,
  );

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
    // TODO(T11928): drag→transition once gateway-client lands (M5). For v1 a
    // card click is inspect-only — it opens the read-only DetailDrawer.
    selectedId = cardId;
  }

  function closeDrawer(): void {
    selectedId = null;
  }

  // ---- Live SSE refresh ----
  let liveConnected = $state(false);

  $effect(() => {
    const src = new EventSource('/api/tasks/events');
    src.addEventListener('connected', () => {
      liveConnected = true;
    });
    src.addEventListener('task-updated', () => {
      liveConnected = true;
      // Re-run the server load so the board reflects the change. SvelteKit
      // dedupes concurrent invalidations, so the 2s SSE cadence is safe.
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
</script>

<svelte:head>
  <title>Dispatcher Board — CLEO Studio</title>
</svelte:head>

<div class="kanban-view">
  <HeroHeader
    eyebrow="DISPATCHER"
    title="Agent Lifecycle Board"
    subtitle="Read-only view of every task across the dispatch lifecycle. Arrow keys navigate · Enter inspects."
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
      <Board {lanes} cards={flatCards} {laneResolver} onSelect={handleSelect} />
    </div>
  {/if}

  <footer class="kanban-foot">
    <span class="hint">Arrows navigate · Enter inspects · Esc closes — read-only v1 (drag &amp; dispatch coming in M5)</span>
  </footer>
</div>

{#if drawerTask}
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
</style>
