/**
 * Framework-free shared types + bucketing helper for the generic Kanban
 * {@link import('./Board.svelte').default} component (T11927).
 *
 * `Board.svelte` is a generalisation of the pipeline-specific
 * `StageSwimLane.svelte`: instead of hard-coding the RCASD-IVTR+C stages, it
 * accepts an arbitrary `lanes` array and a `laneResolver` and renders N
 * columns generically (OCP — open for extension to ANY lane taxonomy, closed
 * for modification). The agent-lifecycle dispatcher board
 * (`/tasks/kanban`, T11925) is the first consumer; the existing pipeline view
 * keeps using `StageSwimLane.svelte` unchanged (T11927 AC2).
 *
 * Keeping the types + bucketing in a pure `.ts` sibling lets them be unit
 * tested under vitest's node environment without mounting Svelte.
 *
 * @task T11927
 * @epic T11559
 */

import type { TaskPriority, TaskStatus } from '@cleocode/contracts';

/**
 * One lane (column) definition the board renders.
 *
 * Lane ids are opaque strings so any taxonomy works — agent-lifecycle lanes,
 * pipeline stages, custom workflows. The board never interprets the id beyond
 * routing cards to it via the resolver.
 */
export interface BoardLane {
  /** Stable lane id used by the resolver to route cards. */
  id: string;
  /** Human-readable column header. */
  label: string;
  /** Optional one-line hint shown in the empty-state for this lane. */
  hint?: string;
}

/**
 * A normalised, presentational card the board renders. Decoupled from both
 * `Task` and `TaskView` so the loader controls exactly what each card shows
 * and the board stays a pure renderer.
 */
export interface BoardCard {
  /** Task id (e.g. `T123`). */
  id: string;
  /** Card title. */
  title: string;
  /** Status — drives the {@link import('../tasks/StatusBadge.svelte').default} badge. */
  status: TaskStatus;
  /** Priority — drives the {@link import('../tasks/PriorityBadge.svelte').default} badge. */
  priority: TaskPriority;
  /** Optional size chip (`small` | `medium` | `large`). */
  size?: string | null;
  /** Raw `verification_json` for the I/T/Q gate dots, or `null` to hide them. */
  verificationJson?: string | null;
  /**
   * Whether a worker is actively executing this task — drives the subtle
   * running-worker affordance (pulsing dot) on the card.
   */
  workerActive?: boolean;
}

/** A lane plus the cards bucketed into it, in board order. */
export interface BoardLaneColumn {
  /** The lane definition. */
  lane: BoardLane;
  /** Cards routed to this lane (input order preserved). */
  cards: BoardCard[];
  /** Pre-computed card count for the header chip. */
  count: number;
}

/**
 * Bucket a flat card list into lane columns using a `laneResolver`.
 *
 * Pure + stable: every lane in `lanes` yields a column (even empty ones, so
 * the board shape stays fixed), and cards preserve input order within each
 * lane. Cards whose resolved lane id is not in `lanes` are dropped (defensive
 * against taxonomy drift) — the same contract `bucketKanbanTasks` uses for
 * unknown statuses.
 *
 * @param cards - Flat card list.
 * @param lanes - Ordered lane definitions.
 * @param laneResolver - Maps a card to exactly one lane id.
 * @returns One {@link BoardLaneColumn} per lane, in `lanes` order.
 */
export function bucketBoardCards(
  cards: readonly BoardCard[],
  lanes: readonly BoardLane[],
  laneResolver: (card: BoardCard) => string,
): BoardLaneColumn[] {
  const byLane = new Map<string, BoardCard[]>();
  for (const lane of lanes) byLane.set(lane.id, []);

  for (const card of cards) {
    const laneId = laneResolver(card);
    const bucket = byLane.get(laneId);
    if (bucket) bucket.push(card);
    // Unknown lane id → dropped (defensive).
  }

  return lanes.map((lane) => {
    const laneCards = byLane.get(lane.id) ?? [];
    return { lane, cards: laneCards, count: laneCards.length };
  });
}
