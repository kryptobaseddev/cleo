/**
 * Task Explorer shared component shelf.
 *
 * Wave 0A of the T949 Studio /tasks Explorer merge. This barrel is
 * consumed by:
 *
 *   - `routes/tasks/+page.svelte` (dashboard panel + embedded Explorer)
 *   - `routes/tasks/pipeline/+page.svelte` (preserved — uses card primitives)
 *   - The future 3 Explorer tabs: T953 (Hierarchy), T954 (Graph), T955 (Kanban)
 *
 * Components are presentational — no API calls. Data loading is T952's job.
 *
 * @task T950
 * @epic T949
 */

export {
  AGENT_LIFECYCLE_LANE_HINTS,
  AGENT_LIFECYCLE_LANE_LABELS,
  AGENT_LIFECYCLE_LANES,
  type AgentLifecycleLane,
  type AgentLifecycleSignal,
  type LaneGatesSnapshot,
  resolveAgentLifecycleLane,
} from './agent-lifecycle-lane.js';
export type { DependencyLink, ParentChainEntry } from './DetailDrawer.svelte';
export { default as DetailDrawer } from './DetailDrawer.svelte';
export type { EpicProgressRow } from './EpicProgressCard.svelte';
export { default as EpicProgressCard } from './EpicProgressCard.svelte';
export type { FilterChipOption } from './FilterChipGroup.svelte';
export { default as FilterChipGroup } from './FilterChipGroup.svelte';
export {
  formatTime,
  type GatesPassed,
  gatesFromJson,
  priorityClass,
  progressPct,
  statusClass,
  statusIcon,
} from './format.js';
export { default as GraphTab } from './GraphTab.svelte';
export { default as HierarchyTab } from './HierarchyTab.svelte';
export { default as KanbanTab } from './KanbanTab.svelte';
// NOTE: KanbanView.svelte is NOT re-exported here. It depends on SvelteKit
// route runtime (`$app/navigation`) which is unavailable in the vitest node
// environment that imports this barrel for smoke tests. The `/tasks/kanban`
// route imports it directly via its path. (T11925)
export {
  applyKanbanFilters,
  bucketKanbanTasks,
  columnIsVisible,
  findRootEpicId,
  indexTasksById,
  KANBAN_COLUMN_ORDER,
  type KanbanBuckets,
  type KanbanColumn,
  type KanbanEpicGroup,
  type KanbanFilterPredicate,
  NO_EPIC_GROUP_ID,
  NO_EPIC_GROUP_TITLE,
  taskMatchesKanbanFilter,
} from './kanban-bucketing.js';
export { default as LabelsFilter } from './LabelsFilter.svelte';
export { default as PriorityBadge } from './PriorityBadge.svelte';
export type { RecentTaskRow } from './RecentActivityFeed.svelte';
export { default as RecentActivityFeed } from './RecentActivityFeed.svelte';
export { default as StatusBadge } from './StatusBadge.svelte';
export { default as TaskCard } from './TaskCard.svelte';
export { default as TaskSearchBox } from './TaskSearchBox.svelte';
