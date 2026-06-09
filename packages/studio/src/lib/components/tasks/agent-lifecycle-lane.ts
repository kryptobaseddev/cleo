/**
 * Pure agent-lifecycle LANE RESOLVER for the read-only Kanban dispatcher
 * board (T11926 · M6 · read-only v1).
 *
 * ## Why this exists alongside {@link import('./kanban-bucketing.js')}
 *
 * `kanban-bucketing.ts` buckets tasks by raw `status` (pending/active/blocked/
 * done/cancelled) — a faithful mirror of the `tasks.status` column. That view
 * answers *"what state is the record in?"*.
 *
 * THIS module answers a different question — *"where is this task in the
 * agent dispatch lifecycle?"* — by collapsing several orthogonal signals
 * (status, verification gates, completion-readiness, blocking dependencies,
 * HITL pauses, and any active-worker / orchestrate-ready hint) onto ONE of
 * seven dispatcher lanes:
 *
 * ```
 * Backlog → Ready → Running → Review → Blocked → Done → Cancelled
 * ```
 *
 * It deliberately does NOT replace status bucketing; both ship side-by-side so
 * the existing `/tasks` Kanban tab keeps its status columns while the new
 * dispatcher board (`/tasks/kanban`) renders lifecycle lanes.
 *
 * The module is a pure `.ts` file with NO Svelte import so it runs under
 * vitest's `environment: 'node'` (see `packages/studio/vitest.config.ts`),
 * mirroring the `resolve-column-id.test.ts` pattern.
 *
 * @task T11926
 * @epic T11559
 */

import type { TaskStatus } from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// Lane taxonomy
// ---------------------------------------------------------------------------

/**
 * The seven dispatcher lanes, in canonical left-to-right board order.
 *
 * - `backlog`   — pending work not yet eligible to start (deps unmet OR no
 *                 active dispatch signal).
 * - `ready`     — dependencies satisfied and the task is eligible to be
 *                 spawned, but no worker has claimed it yet.
 * - `running`   — an agent/worker is actively executing (spawned / claimed).
 * - `review`    — implementation done, awaiting verification gates / a PR
 *                 merge before completion.
 * - `blocked`   — held by an explicit `blockedBy` reason, an unmet dependency
 *                 it cannot start without, or a HITL approval pause.
 * - `done`      — terminal success.
 * - `cancelled` — terminal abandonment.
 */
export type AgentLifecycleLane =
  | 'backlog'
  | 'ready'
  | 'running'
  | 'review'
  | 'blocked'
  | 'done'
  | 'cancelled';

/**
 * Canonical ordered list of dispatcher lanes — drives column order on the
 * board. Tasks in unknown / non-surfaced statuses (e.g. `archived`,
 * `proposed`) are filtered before resolution and never appear.
 */
export const AGENT_LIFECYCLE_LANES: readonly AgentLifecycleLane[] = [
  'backlog',
  'ready',
  'running',
  'review',
  'blocked',
  'done',
  'cancelled',
] as const;

/** Human-readable, board-facing labels for each lane. */
export const AGENT_LIFECYCLE_LANE_LABELS: Readonly<Record<AgentLifecycleLane, string>> = {
  backlog: 'Backlog',
  ready: 'Ready',
  running: 'Running',
  review: 'Review',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
} as const;

/** One-line lane descriptions used for board empty-states + tooltips. */
export const AGENT_LIFECYCLE_LANE_HINTS: Readonly<Record<AgentLifecycleLane, string>> = {
  backlog: 'Pending — not yet eligible to dispatch',
  ready: 'Dependencies met — eligible to spawn',
  running: 'A worker is actively executing',
  review: 'Awaiting verification gates / PR merge',
  blocked: 'Held by a dependency, blocker, or HITL gate',
  done: 'Completed',
  cancelled: 'Abandoned',
} as const;

// ---------------------------------------------------------------------------
// Resolver input
// ---------------------------------------------------------------------------

/**
 * Minimal verification-gate snapshot the resolver consults to decide the
 * {@link AgentLifecycleLane.review} lane.
 *
 * Structurally compatible with `TaskViewGatesStatus` from
 * `@cleocode/contracts` so callers can pass the `/api/tasks` `views[i].
 * gatesStatus` straight through.
 */
export interface LaneGatesSnapshot {
  /** Whether the `implemented` gate has passed. */
  implemented: boolean;
  /** Whether the `testsPassed` gate has passed. */
  testsPassed: boolean;
  /** Whether the `qaPassed` gate has passed. */
  qaPassed: boolean;
}

/**
 * Normalised, framework-free signal bundle for one task.
 *
 * The Studio loader projects a `Task` + its canonical `TaskView` (and the
 * raw `depends` / `blockedBy` fields) onto this shape so the resolver never
 * has to know about either contract directly — keeping it a pure, trivially
 * testable function.
 */
export interface AgentLifecycleSignal {
  /** Canonical execution status (`tasks.status`). */
  status: TaskStatus;
  /**
   * Free-text blocker reason from `tasks.blockedBy`. Non-empty ⇒ the task is
   * explicitly blocked by an operator/agent note (e.g. "waiting for API key",
   * "awaiting HITL approval").
   */
  blockedBy?: string | null;
  /**
   * IDs of tasks this task depends on (`tasks.depends`). Combined with
   * {@link unmetDependsCount} to decide Ready-vs-Backlog and dependency
   * blocking.
   */
  depends?: readonly string[] | null;
  /**
   * Count of {@link depends} whose status is NOT `done`. `0` means every
   * dependency is satisfied. When unknown (loader could not resolve), pass
   * `undefined` — the resolver then treats a non-empty `depends` list as
   * "not yet eligible" (conservative: keeps it in Backlog rather than
   * falsely promoting to Ready).
   */
  unmetDependsCount?: number;
  /**
   * Verification gate snapshot. When all three gates are green and the task
   * has not yet reached a terminal status, the task is parked in `review`
   * awaiting completion.
   */
  gates?: LaneGatesSnapshot | null;
  /**
   * Canonical `readyToComplete` flag from `TaskView` — true when required
   * gates are green AND no unresolved blocking deps AND status is non-terminal.
   * A strong `review` signal.
   */
  readyToComplete?: boolean;
  /**
   * Whether a PR is open/awaiting for this task (review signal). The loader
   * derives this from orchestration metadata when available; defaults to
   * `false`.
   */
  prAwaiting?: boolean;
  /**
   * Whether the task is paused on a HITL (human-in-the-loop) approval gate.
   * A `blocked` signal that outranks everything except terminal status.
   */
  hitlPending?: boolean;
  /**
   * Whether an agent/worker is actively spawned or has claimed this task.
   * The loader derives this from the active-session / orchestrate signal in
   * the existing data layer; defaults to `false`.
   */
  workerActive?: boolean;
  /**
   * Canonical `nextAction` hint from `TaskView`. `'spawn-worker'` is treated
   * as an orchestrate-ready signal; `'blocked-on-deps'` reinforces blocking.
   * Optional — the resolver never requires it.
   */
  nextAction?: string;
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Does the gate snapshot represent a fully-implemented-and-verified task that
 * is sitting in review (all three required gates green)?
 *
 * @param gates - Gate snapshot or null.
 * @returns `true` when implemented + testsPassed + qaPassed are all green.
 */
function allGatesGreen(gates: LaneGatesSnapshot | null | undefined): boolean {
  if (!gates) return false;
  return gates.implemented === true && gates.testsPassed === true && gates.qaPassed === true;
}

/**
 * Is this task held back by an unmet dependency it cannot start without?
 *
 * Returns `true` only when we have positive evidence of an unmet dep:
 * `unmetDependsCount > 0`. When the count is unknown we do NOT treat the task
 * as dependency-blocked here (that nuance is handled by Ready-vs-Backlog).
 *
 * @param signal - The task signal.
 * @returns `true` if at least one dependency is known-unsatisfied.
 */
function hasUnmetDependency(signal: AgentLifecycleSignal): boolean {
  return typeof signal.unmetDependsCount === 'number' && signal.unmetDependsCount > 0;
}

/**
 * Are all known dependencies satisfied (eligible to dispatch)?
 *
 * - No `depends` at all ⇒ eligible.
 * - `unmetDependsCount === 0` ⇒ eligible.
 * - `unmetDependsCount` unknown but `depends` non-empty ⇒ NOT eligible
 *   (conservative — we cannot prove the deps are met).
 *
 * @param signal - The task signal.
 * @returns `true` when the task may be promoted to the Ready lane.
 */
function dependenciesSatisfied(signal: AgentLifecycleSignal): boolean {
  const depends = signal.depends ?? [];
  if (depends.length === 0) return true;
  return signal.unmetDependsCount === 0;
}

/**
 * Resolve a single task's signal bundle onto exactly ONE
 * {@link AgentLifecycleLane}.
 *
 * ## Precedence ladder (highest wins)
 *
 * 1. **`cancelled`** — terminal. `status === 'cancelled'`.
 * 2. **`done`** — terminal. `status === 'done'`.
 * 3. **`blocked`** — `status === 'blocked'` OR a non-empty `blockedBy` reason
 *    OR a pending HITL gate OR a known-unmet dependency. (Blocked outranks
 *    Running/Review/Ready because a blocked task cannot progress regardless of
 *    other signals.)
 * 4. **`review`** — non-terminal, not blocked, and verified: all gates green
 *    OR `readyToComplete` OR a PR is awaiting. (A task in review may also be
 *    `active`, but review outranks running — it is past execution.)
 * 5. **`running`** — a worker is actively executing: `workerActive` OR
 *    `status === 'active'` OR `nextAction === 'spawn-worker'`-already-spawned.
 * 6. **`ready`** — `status === 'pending'`, dependencies satisfied, and an
 *    orchestrate-ready hint (`nextAction === 'spawn-worker'`).
 * 7. **`backlog`** — everything else (pending, not yet eligible / unwaved).
 *
 * The ladder is documented as `cancelled > done > blocked > review > running
 * > ready > backlog`. Terminal lanes short-circuit first so a `done` task
 * with stale gate/worker flags can never leak into Running or Review.
 *
 * @param signal - Normalised signal bundle (see {@link AgentLifecycleSignal}).
 * @returns The single lane this task belongs in.
 */
export function resolveAgentLifecycleLane(signal: AgentLifecycleSignal): AgentLifecycleLane {
  // 1–2. Terminal statuses short-circuit — nothing overrides them.
  if (signal.status === 'cancelled') return 'cancelled';
  if (signal.status === 'done') return 'done';

  // 3. Blocked — explicit status, a blocker reason, a HITL pause, or a
  //    known-unmet dependency. Outranks Running/Review/Ready.
  if (
    signal.status === 'blocked' ||
    (typeof signal.blockedBy === 'string' && signal.blockedBy.trim().length > 0) ||
    signal.hitlPending === true ||
    hasUnmetDependency(signal)
  ) {
    return 'blocked';
  }

  // 4. Review — past execution, awaiting gates / PR merge. A task can be
  //    `active` AND in review; review wins because it is the later phase.
  if (
    signal.readyToComplete === true ||
    signal.prAwaiting === true ||
    allGatesGreen(signal.gates)
  ) {
    return 'review';
  }

  // 5. Running — a worker is actively executing.
  if (signal.workerActive === true || signal.status === 'active') {
    return 'running';
  }

  // 6. Ready — pending, deps satisfied, orchestrate-ready hint present.
  if (
    signal.status === 'pending' &&
    dependenciesSatisfied(signal) &&
    signal.nextAction === 'spawn-worker'
  ) {
    return 'ready';
  }

  // 7. Backlog — pending and not yet eligible (deps unmet/unknown, unwaved).
  return 'backlog';
}
