/**
 * Pure lane→lane DRAG-TRANSITION rules for the interactive agent-lifecycle
 * dispatcher board (T11928 · M5).
 *
 * The read-only board (T11925) resolves each task onto one of seven lifecycle
 * lanes via {@link import('./agent-lifecycle-lane.js').resolveAgentLifecycleLane}.
 * Making the board interactive means a user can DRAG a card from its current
 * lane to a target lane — but NOT every lane move is a valid task transition:
 *
 *  - You must never let "drag to Done" bypass the verification/completion gates
 *    — completion goes through the evidence-gated `cleo complete` flow, never a
 *    raw status flip. So Done is NOT a drag target here.
 *  - Lanes that are RESOLVED (computed from gates / deps / sessions / HITL) and
 *    not directly settable as a `tasks.status` value — `ready`, `review`,
 *    `blocked` (when it reflects unmet deps / HITL rather than the explicit
 *    `blocked` status) — are not free-form drag targets either.
 *
 * This module is the single source of truth for "is this drag allowed, and if
 * so what `tasks.update` does it map to?". It is a pure `.ts` file with NO
 * Svelte import so it runs under vitest's `environment: 'node'`, mirroring the
 * {@link import('./agent-lifecycle-lane.js')} resolver pattern.
 *
 * The board component calls {@link planLaneTransition} on drop. A `null` plan
 * means "revert + toast (invalid move)"; a non-null plan carries the exact
 * `tasks.update` field change the write path issues through the gateway.
 *
 * @task T11928
 * @epic T11559
 */

import type { TaskStatus } from '@cleocode/contracts';
import type { AgentLifecycleLane } from './agent-lifecycle-lane.js';

/**
 * The subset of {@link TaskStatus} values a drag may DIRECTLY set via a
 * `tasks.update --status` mutation. `done` is deliberately excluded — a
 * completion must go through the evidence-gated complete flow, never a raw
 * status flip from the board.
 */
export type DraggableTargetStatus = Extract<
  TaskStatus,
  'pending' | 'active' | 'blocked' | 'cancelled'
>;

/**
 * A concrete, validated transition plan produced by {@link planLaneTransition}.
 *
 * Carries the exact `tasks.update` payload the write path issues. The board
 * applies an optimistic move first, then issues this mutation; on gateway error
 * it reverts to {@link fromLane}.
 */
export interface LaneTransitionPlan {
  /** The task being moved. */
  taskId: string;
  /** The lane the card was dragged from (revert target on failure). */
  fromLane: AgentLifecycleLane;
  /** The lane the card was dropped into. */
  toLane: AgentLifecycleLane;
  /**
   * The canonical `tasks.status` value this drag sets. Always a
   * {@link DraggableTargetStatus} — never `done`.
   */
  status: DraggableTargetStatus;
  /**
   * Human-readable summary of the transition, surfaced in the success toast and
   * usable as an audit note.
   */
  summary: string;
}

/**
 * Why a drag was rejected — surfaced verbatim in the revert toast so the user
 * understands the board did not silently swallow their move.
 */
export type LaneTransitionRejection =
  | 'same-lane'
  | 'terminal-source'
  | 'gate-protected-target'
  | 'resolved-target'
  | 'unknown';

/**
 * The outcome of evaluating a drag: either an executable {@link LaneTransitionPlan}
 * or a typed {@link LaneTransitionRejection} reason.
 */
export type LaneTransitionResult =
  | { ok: true; plan: LaneTransitionPlan }
  | { ok: false; reason: LaneTransitionRejection; message: string };

/**
 * Lanes a card can be DROPPED into to directly set a `tasks.status`. These map
 * 1:1 onto a {@link DraggableTargetStatus}:
 *
 *  - `backlog`   → `status: 'pending'`   — defer / un-start work.
 *  - `running`   → `status: 'active'`    — mark as actively being worked.
 *  - `blocked`   → `status: 'blocked'`   — explicitly park (operator blocker).
 *  - `cancelled` → `status: 'cancelled'` — abandon.
 *
 * `ready`, `review`, and `done` are intentionally absent: `ready`/`review` are
 * RESOLVED lanes (computed from deps/gates, not a settable status), and `done`
 * is gate-protected (must go through the complete flow).
 */
const DRAGGABLE_TARGET_STATUS: Readonly<
  Partial<Record<AgentLifecycleLane, DraggableTargetStatus>>
> = {
  backlog: 'pending',
  running: 'active',
  blocked: 'blocked',
  cancelled: 'cancelled',
} as const;

/**
 * Source lanes a card can NEVER be dragged OUT of from the board — terminal
 * success. A `done` task is past the lifecycle; reopening is an explicit,
 * evidence-aware action, not a casual drag. (`cancelled` IS draggable out — a
 * mis-cancel can be un-abandoned back to backlog/running.)
 */
const TERMINAL_LOCKED_SOURCE: ReadonlySet<AgentLifecycleLane> = new Set(['done']);

/**
 * Human-readable lane labels for transition summaries / toasts. Kept local so
 * this pure module has no dependency on the Svelte-facing label map.
 */
const LANE_SHORT_LABEL: Readonly<Record<AgentLifecycleLane, string>> = {
  backlog: 'Backlog',
  ready: 'Ready',
  running: 'Running',
  review: 'Review',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
} as const;

/**
 * Is a drop into {@link toLane} a directly-settable status transition?
 *
 * @param toLane - The lane the card was dropped into.
 * @returns `true` when the lane maps to a {@link DraggableTargetStatus}.
 */
export function isDraggableTargetLane(toLane: AgentLifecycleLane): boolean {
  return toLane in DRAGGABLE_TARGET_STATUS;
}

/**
 * Plan (and validate) a drag of a card from one lifecycle lane to another.
 *
 * ## Validity ladder (first match wins)
 *
 * 1. **`same-lane`** — `fromLane === toLane`: a no-op, rejected so the board
 *    does not issue a pointless mutation.
 * 2. **`terminal-source`** — dragging OUT of `done`: rejected (reopen is not a
 *    board gesture).
 * 3. **`gate-protected-target`** — dropping into `done`: rejected (completion
 *    must use the evidence-gated complete flow, never a raw status flip).
 * 4. **`resolved-target`** — dropping into `ready` or `review`: rejected (these
 *    lanes are COMPUTED from deps/gates, not a settable status).
 * 5. Otherwise → an executable {@link LaneTransitionPlan} mapping the target
 *    lane onto its {@link DraggableTargetStatus}.
 *
 * @param taskId - The task being moved.
 * @param fromLane - The lane the card was dragged from.
 * @param toLane - The lane the card was dropped into.
 * @returns A {@link LaneTransitionResult} — `ok:true` with a plan, or `ok:false`
 *   with a typed rejection + user-facing message.
 */
export function planLaneTransition(
  taskId: string,
  fromLane: AgentLifecycleLane,
  toLane: AgentLifecycleLane,
): LaneTransitionResult {
  if (fromLane === toLane) {
    return {
      ok: false,
      reason: 'same-lane',
      message: `${taskId} is already in ${LANE_SHORT_LABEL[toLane]}.`,
    };
  }

  if (TERMINAL_LOCKED_SOURCE.has(fromLane)) {
    return {
      ok: false,
      reason: 'terminal-source',
      message: `${taskId} is Done — reopen it from the task detail, not the board.`,
    };
  }

  if (toLane === 'done') {
    return {
      ok: false,
      reason: 'gate-protected-target',
      message: `Can't drag ${taskId} to Done — completion runs through the verification gates, not a drag.`,
    };
  }

  const status = DRAGGABLE_TARGET_STATUS[toLane];
  if (status === undefined) {
    // ready / review — resolved lanes with no directly-settable status.
    return {
      ok: false,
      reason: 'resolved-target',
      message: `${LANE_SHORT_LABEL[toLane]} is a computed lane — it's set by dependencies and gates, not by dragging.`,
    };
  }

  return {
    ok: true,
    plan: {
      taskId,
      fromLane,
      toLane,
      status,
      summary: `Moved ${taskId} ${LANE_SHORT_LABEL[fromLane]} → ${LANE_SHORT_LABEL[toLane]}`,
    },
  };
}
