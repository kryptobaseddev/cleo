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
export { default as PriorityBadge } from './PriorityBadge.svelte';
export type { RecentTaskRow } from './RecentActivityFeed.svelte';
export { default as RecentActivityFeed } from './RecentActivityFeed.svelte';
export { default as StatusBadge } from './StatusBadge.svelte';
export { default as TaskCard } from './TaskCard.svelte';
export { default as TaskSearchBox } from './TaskSearchBox.svelte';
