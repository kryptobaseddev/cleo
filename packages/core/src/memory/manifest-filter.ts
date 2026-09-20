import type { ExtendedManifestEntry, ResearchFilter } from './index.js';

/**
 * Filter manifest entries by criteria.
 *
 * @param entries - Array of manifest entries to filter
 * @param filter - Filter criteria to apply
 * @returns Filtered subset of entries
 *
 * @remarks
 * Applies filters in order: taskId, status, agent_type, topic, actionable,
 * dateAfter, dateBefore, offset, then limit.
 *
 * @example
 * ```typescript
 * const filtered = filterManifestEntries(entries, { status: 'completed', limit: 10 });
 * ```
 *
 * @task T4787
 */
export function filterManifestEntries(
  entries: ExtendedManifestEntry[],
  filter: ResearchFilter,
): ExtendedManifestEntry[] {
  let filtered = entries;

  if (filter.taskId) {
    const taskId = filter.taskId;
    filtered = filtered.filter((e) => e.id.startsWith(taskId) || e.linked_tasks?.includes(taskId));
  }

  if (filter.status) {
    filtered = filtered.filter((e) => e.status === filter.status);
  }

  if (filter.agent_type) {
    filtered = filtered.filter((e) => e.agent_type === filter.agent_type);
  }

  if (filter.topic) {
    filtered = filtered.filter((e) => e.topics.includes(filter.topic!));
  }

  if (filter.actionable !== undefined) {
    filtered = filtered.filter((e) => e.actionable === filter.actionable);
  }

  if (filter.dateAfter) {
    filtered = filtered.filter((e) => e.date > filter.dateAfter!);
  }

  if (filter.dateBefore) {
    filtered = filtered.filter((e) => e.date < filter.dateBefore!);
  }

  if (filter.offset && filter.offset > 0) {
    filtered = filtered.slice(filter.offset);
  }

  if (filter.limit && filter.limit > 0) {
    filtered = filtered.slice(0, filter.limit);
  }

  return filtered;
}
