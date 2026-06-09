/**
 * Pure board model + plain-text renderer for the `cleo tui` Kanban HOME view
 * (T11934 · epic T11916).
 *
 * This module is deliberately FRAMEWORK-FREE — no pi-tui, no gateway client, no
 * `@cleocode/core` domain import. It takes the rows the gateway SDK
 * (`client.tasks.list`, T11920) returns, projects each onto the SHARED
 * {@link AgentLifecycleSignal}, resolves it to one of the seven dispatcher lanes
 * via the SSoT {@link resolveAgentLifecycleLane} (the SAME model the Studio
 * board uses — relate T11934 ↔ T11926), and produces:
 *
 *  - {@link buildKanbanBoard} — a {@link KanbanBoard} model (lane columns +
 *    bucketed cards + counts), and
 *  - {@link renderKanbanBoardText} — a plain-text board render (one string per
 *    terminal line) used BOTH as the pi-tui component body and as the
 *    graceful-degrade fallback when `@earendil-works/pi-tui` is absent.
 *
 * Keeping the logic pure makes the lane bucketing + board layout unit-testable
 * without a TTY or the optional pi-tui dep.
 *
 * @task T11934
 * @epic T11916
 * @see packages/core/src/tasks/agent-lifecycle-lane.ts — the shared lane SSoT
 */

import type { TaskStatus } from '@cleocode/contracts';
import {
  AGENT_LIFECYCLE_LANE_HINTS,
  AGENT_LIFECYCLE_LANE_LABELS,
  AGENT_LIFECYCLE_LANES,
  type AgentLifecycleLane,
  type AgentLifecycleSignal,
  resolveAgentLifecycleLane,
} from '@cleocode/core/tasks';

/**
 * A single task row as projected from the gateway SDK `tasks.list` response.
 *
 * The generated SDK types guarantee only `{ id, title, status }` (plus an
 * open `[key: string]: unknown`); every richer field here is OPTIONAL and read
 * defensively, because the home view never N+1-fetches a `tasks.show` per card.
 * When a field is absent the lane resolver degrades conservatively (status
 * alone yields a sensible lane).
 */
export interface TuiTaskRow {
  /** Task id (e.g. `T1234`). */
  id?: string;
  /** Task title. */
  title?: string;
  /** Canonical execution status. */
  status?: string;
  /** Owning epic/saga id, when the row carries it. */
  parentId?: string | null;
  /** Free-text blocker reason. */
  blockedBy?: string | null;
  /** Dependency ids. */
  depends?: readonly string[] | null;
  /** Count of unmet dependencies, when resolvable. */
  unmetDependsCount?: number;
  /** Verification gate snapshot (from a TaskView slice if present). */
  gates?: { implemented?: boolean; testsPassed?: boolean; qaPassed?: boolean } | null;
  /** Completion-readiness flag. */
  readyToComplete?: boolean;
  /** Whether a PR is open/awaiting. */
  prAwaiting?: boolean;
  /** Whether a HITL approval is pending. */
  hitlPending?: boolean;
  /** Whether a worker is actively executing this task. */
  workerActive?: boolean;
  /** Canonical next-action hint. */
  nextAction?: string;
  /** Assignee agent id, when claimed. */
  assignee?: string | null;
  /** Proof checkpoint (commit/PR/test reference), when present. */
  proof?: string | null;
}

/** A board-ready card for one task. */
export interface KanbanCard {
  /** Task id. */
  id: string;
  /** Task title (may be empty). */
  title: string;
  /** Owning epic/saga id, if known. */
  epic: string | null;
  /** Assignee agent id, if claimed. */
  assignee: string | null;
  /** Proof checkpoint (commit/PR/test), if present. */
  proof: string | null;
}

/** One lane column: lane meta + its bucketed cards. */
export interface KanbanLaneColumn {
  /** Lane id. */
  lane: AgentLifecycleLane;
  /** Human-readable label. */
  label: string;
  /** One-line lane hint (empty-state / tooltip). */
  hint: string;
  /** Cards routed to this lane. */
  cards: KanbanCard[];
  /** Card count for the header chip. */
  count: number;
}

/** The full board model. */
export interface KanbanBoard {
  /** The seven lane columns, in canonical order. */
  columns: KanbanLaneColumn[];
  /** Total cards across every lane. */
  total: number;
}

/**
 * Statuses that are NEVER surfaced on the dispatcher board (mirrors the Studio
 * loader's archived/proposed exclusion). Rows in these statuses are dropped
 * before lane resolution.
 */
const HIDDEN_STATUSES: ReadonlySet<string> = new Set(['archived', 'proposed']);

/**
 * Project a gateway task row onto the framework-free
 * {@link AgentLifecycleSignal} the shared resolver consumes. Unknown/absent
 * fields are passed through as `undefined` so the resolver degrades safely.
 *
 * @param row - The SDK task row.
 * @returns The normalised signal bundle.
 */
function toSignal(row: TuiTaskRow): AgentLifecycleSignal {
  const gates =
    row.gates != null
      ? {
          implemented: row.gates.implemented === true,
          testsPassed: row.gates.testsPassed === true,
          qaPassed: row.gates.qaPassed === true,
        }
      : null;
  return {
    status: (row.status ?? 'pending') as TaskStatus,
    blockedBy: row.blockedBy ?? null,
    depends: row.depends ?? null,
    ...(typeof row.unmetDependsCount === 'number'
      ? { unmetDependsCount: row.unmetDependsCount }
      : {}),
    gates,
    readyToComplete: row.readyToComplete === true,
    prAwaiting: row.prAwaiting === true,
    hitlPending: row.hitlPending === true,
    workerActive: row.workerActive === true,
    ...(typeof row.nextAction === 'string' ? { nextAction: row.nextAction } : {}),
  };
}

/** Build a board-ready {@link KanbanCard} from a task row. */
function toCard(row: TuiTaskRow): KanbanCard {
  return {
    id: row.id ?? '(no-id)',
    title: row.title ?? '',
    epic: row.parentId ?? null,
    assignee: row.assignee ?? null,
    proof: row.proof ?? null,
  };
}

/**
 * Bucket a list of gateway task rows into the seven dispatcher lanes using the
 * SHARED lane model. Rows in hidden statuses (`archived`, `proposed`) are
 * dropped; everything else is resolved to exactly one lane.
 *
 * @param rows - Task rows from `client.tasks.list`.
 * @returns The full {@link KanbanBoard} model in canonical lane order.
 */
export function buildKanbanBoard(rows: readonly TuiTaskRow[]): KanbanBoard {
  const buckets = new Map<AgentLifecycleLane, KanbanCard[]>();
  for (const lane of AGENT_LIFECYCLE_LANES) buckets.set(lane, []);

  let total = 0;
  for (const row of rows) {
    if (row.status != null && HIDDEN_STATUSES.has(row.status)) continue;
    const lane = resolveAgentLifecycleLane(toSignal(row));
    buckets.get(lane)?.push(toCard(row));
    total += 1;
  }

  const columns: KanbanLaneColumn[] = AGENT_LIFECYCLE_LANES.map((lane) => {
    const cards = buckets.get(lane) ?? [];
    return {
      lane,
      label: AGENT_LIFECYCLE_LANE_LABELS[lane],
      hint: AGENT_LIFECYCLE_LANE_HINTS[lane],
      cards,
      count: cards.length,
    };
  });

  return { columns, total };
}

/** Single-line summary of a card for the vertical text board. */
function formatCardLine(card: KanbanCard): string {
  const parts: string[] = [`  • ${card.id}`];
  if (card.title) parts.push(truncate(card.title, 48));
  const tags: string[] = [];
  if (card.epic) tags.push(`epic:${card.epic}`);
  if (card.assignee) tags.push(`@${card.assignee}`);
  if (card.proof) tags.push(`proof:${card.proof}`);
  const head = parts.join('  ');
  return tags.length > 0 ? `${head}  [${tags.join(' ')}]` : head;
}

/** Truncate `s` to at most `max` chars, appending `…` when cut. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Render the board as plain text — one string per terminal line. Used both as
 * the body of the pi-tui home component AND as the graceful-degrade fallback
 * when the optional pi-tui renderer is unavailable.
 *
 * Lanes are stacked vertically (one section per lane) so the output is
 * width-agnostic and legible in any terminal, with a count chip on each header
 * and the lane hint as the empty-state.
 *
 * @param board - The board model from {@link buildKanbanBoard}.
 * @param options - Optional caps (max cards rendered per lane).
 * @returns Lines for the renderer (no trailing newline per line).
 */
export function renderKanbanBoardText(
  board: KanbanBoard,
  options?: { readonly maxCardsPerLane?: number },
): string[] {
  const cap = options?.maxCardsPerLane ?? 12;
  const lines: string[] = [];
  lines.push(`CLEO Cockpit — Kanban (${board.total} task${board.total === 1 ? '' : 's'})`);
  lines.push('');

  for (const col of board.columns) {
    lines.push(`▸ ${col.label}  (${col.count})`);
    if (col.cards.length === 0) {
      lines.push(`    ${col.hint}`);
    } else {
      for (const card of col.cards.slice(0, cap)) {
        lines.push(formatCardLine(card));
      }
      if (col.cards.length > cap) {
        lines.push(`    … and ${col.cards.length - cap} more`);
      }
    }
    lines.push('');
  }

  return lines;
}
