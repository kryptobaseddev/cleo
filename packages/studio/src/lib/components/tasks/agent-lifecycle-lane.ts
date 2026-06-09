/**
 * Studio re-export shim for the agent-lifecycle LANE RESOLVER.
 *
 * The lane model is now the SHARED SSoT in `@cleocode/core/tasks` so the Studio
 * Kanban board (T11926) and the `cleo tui` terminal cockpit (T11934) resolve
 * lanes with IDENTICAL semantics — same seven lanes, same precedence ladder
 * (`cancelled > done > blocked > review > running > ready > backlog`). This file
 * was the original home of that logic; it now re-exports the canonical module
 * so existing Studio imports (`KanbanView.svelte`, `lane-transition.ts`,
 * `routes/tasks/kanban`, the component barrel) keep working without churn.
 *
 * Do NOT re-implement the resolver here — edit the SSoT at
 * `packages/core/src/tasks/agent-lifecycle-lane.ts` instead.
 *
 * @task T11934 — lane model lifted to core; this is now a re-export
 * @task T11926 — original Studio resolver
 * @epic T11559
 */

export {
  AGENT_LIFECYCLE_LANE_HINTS,
  AGENT_LIFECYCLE_LANE_LABELS,
  AGENT_LIFECYCLE_LANES,
  type AgentLifecycleLane,
  type AgentLifecycleSignal,
  type LaneGatesSnapshot,
  resolveAgentLifecycleLane,
} from '@cleocode/core/tasks';
