<!--
  Board — generic Kanban column board (T11927).

  A generalisation of `pipeline/StageSwimLane.svelte`: instead of the hard-coded
  RCASD-IVTR+C stages, it accepts an arbitrary `lanes` array plus a
  `laneResolver` and renders N columns generically (OCP). The pipeline view
  keeps using StageSwimLane unchanged — this is the reusable board that the
  agent-lifecycle dispatcher view (`/tasks/kanban`, T11925) composes.

  Renders a horizontally-scrolling row of fixed-width lanes, each with a sticky
  header (label + count), a vertical stack of TaskCards (compact density), and a
  per-lane empty-state. Keyboard navigable (arrow keys move focus across the
  grid; Enter activates the focused card). Cards reuse the shared TaskCard /
  StatusBadge / PriorityBadge primitives — zero new card primitives (T11925 AC3).

  @task T11927
  @epic T11559
-->
<script lang="ts">
  import { TaskCard } from '$lib/components/tasks';
  import { Badge, EmptyState } from '$lib/ui';
  import type { Task } from '@cleocode/contracts';
  import {
    type BoardCard,
    type BoardLane,
    bucketBoardCards,
  } from './board-types.js';

  interface Props {
    /** Ordered lane (column) definitions. */
    lanes: BoardLane[];
    /** Flat card list — bucketed into lanes via {@link laneResolver}. */
    cards: BoardCard[];
    /** Routes a card to exactly one `lanes[i].id`. The OCP seam (T11927 AC1). */
    laneResolver: (card: BoardCard) => string;
    /** Called when a card is clicked / activated via keyboard. */
    onSelect?: (cardId: string) => void;
    /**
     * Called when a card is DRAGGED from one lane to another (T11928). When
     * omitted the board stays read-only (no drag affordance). The handler owns
     * the optimistic move + persistence + revert; the board only reports the
     * gesture (`cardId`, `fromLane`, `toLane`).
     */
    onMove?: (cardId: string, fromLane: string, toLane: string) => void;
  }

  let { lanes, cards, laneResolver, onSelect, onMove }: Props = $props();

  /** Whether drag→transition is wired (enables the draggable affordance). */
  const dragEnabled = $derived(onMove !== undefined);

  // ---- Drag→transition (T11928) ----
  /** The card id currently being dragged, or null. */
  let draggingId = $state<string | null>(null);
  /** The lane id currently hovered as a drop target, or null. */
  let dragOverLane = $state<string | null>(null);

  function handleDragStart(e: DragEvent, cardId: string): void {
    if (!dragEnabled) return;
    draggingId = cardId;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', cardId);
    }
  }

  function handleDragEnd(): void {
    draggingId = null;
    dragOverLane = null;
  }

  function handleLaneDragOver(e: DragEvent, laneId: string): void {
    if (!dragEnabled || draggingId === null) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    dragOverLane = laneId;
  }

  function handleLaneDrop(e: DragEvent, laneId: string): void {
    if (!dragEnabled || draggingId === null) return;
    e.preventDefault();
    const cardId = draggingId;
    const fromLane = laneResolver(cards.find((c) => c.id === cardId) as BoardCard);
    draggingId = null;
    dragOverLane = null;
    if (fromLane !== laneId) onMove?.(cardId, fromLane, laneId);
  }

  /** Bucket cards into lane columns (pure helper) whenever inputs change. */
  const columns = $derived(bucketBoardCards(cards, lanes, laneResolver));

  /** Total cards across every lane — surfaced for the header summary. */
  const totalCards = $derived(columns.reduce((sum, c) => sum + c.count, 0));

  // ---- Keyboard focus grid (column × row) ----
  let focusedCol = $state(0);
  let focusedRow = $state(0);

  /**
   * Project a {@link BoardCard} onto the minimal `Task` shape TaskCard needs.
   * The board only ever renders presentational fields, so this is a thin,
   * loss-free widening — no fabricated data beyond the required `description`
   * (TaskCard never displays it in compact mode).
   */
  function toTaskCard(card: BoardCard): Task {
    return {
      id: card.id,
      title: card.title,
      description: card.title,
      status: card.status,
      priority: card.priority,
      size: (card.size ?? undefined) as Task['size'],
      createdAt: '',
    };
  }

  function activate(cardId: string): void {
    onSelect?.(cardId);
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (columns.length === 0) return;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      focusedCol = Math.min(focusedCol + 1, columns.length - 1);
      focusedRow = 0;
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      focusedCol = Math.max(focusedCol - 1, 0);
      focusedRow = 0;
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const maxRow = (columns[focusedCol]?.cards.length ?? 1) - 1;
      focusedRow = Math.min(focusedRow + 1, Math.max(maxRow, 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusedRow = Math.max(focusedRow - 1, 0);
    } else if (e.key === 'Enter' || e.key === ' ') {
      const card = columns[focusedCol]?.cards[focusedRow];
      if (card) {
        e.preventDefault();
        activate(card.id);
      }
    }
  }
</script>

<div
  class="board-scroll"
  role="grid"
  aria-label={`Kanban board — ${totalCards} tasks across ${columns.length} lanes. Use arrow keys to navigate, Enter to inspect.`}
  tabindex="0"
  onkeydown={handleKeydown}
>
  <div class="board">
    {#each columns as column, ci (column.lane.id)}
      <div
        class="lane"
        class:is-focused={ci === focusedCol}
        class:is-drop-target={dragOverLane === column.lane.id}
        data-lane={column.lane.id}
        role="row"
        tabindex={-1}
        aria-label={`${column.lane.label} — ${column.count} tasks`}
        ondragover={(e) => handleLaneDragOver(e, column.lane.id)}
        ondrop={(e) => handleLaneDrop(e, column.lane.id)}
      >
        <header class="lane-head">
          <span class="head-label">{column.lane.label}</span>
          <Badge tone={column.count > 0 ? 'accent' : 'neutral'} size="sm">{column.count}</Badge>
        </header>

        <div class="lane-body">
          {#if column.cards.length === 0}
            <div class="lane-empty">
              <EmptyState title="Empty" subtitle={column.lane.hint ?? ''} />
            </div>
          {:else}
            {#each column.cards as card, ri (card.id)}
              <div
                class="card-wrap"
                class:worker-active={card.workerActive}
                class:is-focused={ci === focusedCol && ri === focusedRow}
                class:is-dragging={draggingId === card.id}
                class:draggable={dragEnabled}
                role="gridcell"
                tabindex={-1}
                draggable={dragEnabled}
                ondragstart={(e) => handleDragStart(e, card.id)}
                ondragend={handleDragEnd}
              >
                {#if card.workerActive}
                  <span class="worker-dot" aria-label="Worker active" title="Worker active"></span>
                {/if}
                <TaskCard
                  task={toTaskCard(card)}
                  compact
                  verificationJson={card.verificationJson ?? null}
                  focused={ci === focusedCol && ri === focusedRow}
                  onClick={() => activate(card.id)}
                />
              </div>
            {/each}
          {/if}
        </div>
      </div>
    {/each}
  </div>
</div>

<style>
  .board-scroll {
    overflow-x: auto;
    overflow-y: hidden;
    padding-bottom: var(--space-2);
    outline: none;
  }

  .board-scroll:focus-visible {
    box-shadow: var(--shadow-focus);
    border-radius: var(--radius-md);
  }

  .board {
    display: flex;
    gap: var(--space-3);
    min-width: max-content;
    align-items: stretch;
    height: 100%;
  }

  .lane {
    display: flex;
    flex-direction: column;
    width: 268px;
    flex-shrink: 0;
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
    transition: border-color var(--ease), box-shadow var(--ease);
  }

  .lane.is-focused {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-soft);
  }

  /* Drop-target affordance while a card is dragged over this lane (T11928). */
  .lane.is-drop-target {
    border-color: var(--accent);
    border-style: dashed;
    background: color-mix(in srgb, var(--accent) 8%, var(--bg-elev-1));
  }

  .lane-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    padding: var(--space-3);
    background: var(--bg);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    position: sticky;
    top: 0;
    z-index: 1;
  }

  .head-label {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 600;
  }

  .lane-body {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-2);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-height: 0;
  }

  .lane-empty {
    padding: var(--space-2) 0;
    opacity: 0.7;
  }

  /* Shrink the shared EmptyState inside a dense lane. */
  .lane-empty :global(.empty) {
    padding: var(--space-4) var(--space-3);
    background: transparent;
    border-style: dashed;
  }
  .lane-empty :global(.empty .title) {
    font-size: var(--text-sm);
  }
  .lane-empty :global(.empty .subtitle) {
    font-size: var(--text-2xs);
  }

  .card-wrap {
    position: relative;
  }

  /* Drag affordance (T11928) — a grab cursor when the board is interactive. */
  .card-wrap.draggable {
    cursor: grab;
  }
  .card-wrap.is-dragging {
    opacity: 0.45;
    cursor: grabbing;
  }
  .card-wrap.is-dragging :global(.task-card) {
    border-style: dashed;
  }

  /* Subtle running-worker affordance — an accent left rail + pulsing dot. */
  .card-wrap.worker-active :global(.task-card) {
    border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
    box-shadow: inset 2px 0 0 var(--accent);
  }

  .worker-dot {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    z-index: 2;
    animation: worker-pulse 1.6s ease-in-out infinite;
  }

  @keyframes worker-pulse {
    0%,
    100% {
      opacity: 1;
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 60%, transparent);
    }
    50% {
      opacity: 0.55;
      box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 0%, transparent);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .worker-dot {
      animation: none;
    }
  }
</style>
