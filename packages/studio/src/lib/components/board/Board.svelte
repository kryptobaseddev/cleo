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
  }

  let { lanes, cards, laneResolver, onSelect }: Props = $props();

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
        data-lane={column.lane.id}
        role="row"
        aria-label={`${column.lane.label} — ${column.count} tasks`}
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
                role="gridcell"
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
