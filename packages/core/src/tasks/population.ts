/** Shared task filtering and enumeration truth (T12200). */
import type { DataAccessor, Task, TaskPopulation, TaskQueryFilters } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import { assertTaskAxisFilters } from './axis-filters.js';

function includesValue<T>(filter: T | T[] | undefined, value: T): boolean {
  return (
    filter === undefined || (Array.isArray(filter) ? filter.includes(value) : filter === value)
  );
}

/** Apply identical eligibility to ordinary and archived task rows. */
export function matchesTaskFilters(task: Task, filters: TaskQueryFilters): boolean {
  return (
    includesValue(filters.status, task.status) &&
    (!filters.excludeStatus || !includesValue(filters.excludeStatus, task.status)) &&
    includesValue(filters.kind, task.kind) &&
    includesValue(filters.severity, task.severity) &&
    (!filters.priority || task.priority === filters.priority) &&
    (!filters.type || task.type === filters.type) &&
    (filters.parentId === undefined || task.parentId === filters.parentId) &&
    (!filters.phase || task.phase === filters.phase) &&
    (!filters.label || (task.labels ?? []).includes(filters.label))
  );
}

/** Read the full eligible population before matching or pagination. */
export async function readTaskPopulation(
  accessor: DataAccessor,
  filters: TaskQueryFilters,
  includeArchive = false,
): Promise<Task[]> {
  assertTaskAxisFilters(filters);
  const queried = await accessor.queryTasks({ ...filters, limit: undefined, offset: undefined });
  const archive = includeArchive ? await accessor.loadArchive() : null;
  const rows = [...queried.tasks, ...(archive?.archivedTasks ?? [])];
  const unique = new Map<string, Task>();
  for (const task of rows) {
    if (!includeArchive && !includesValue(filters.status, 'archived') && task.status === 'archived')
      continue;
    if (!includeArchive && filters.status === undefined && task.status === 'archived') continue;
    if (matchesTaskFilters(task, filters)) unique.set(task.id, task);
  }
  return [...unique.values()];
}

/** Slice once and retain explicit match, returned, pagination and archive facts. */
export function paginateTaskPopulation<T>(
  rows: T[],
  limit: number,
  offset = 0,
  archive: TaskPopulation['archive'] = 'excluded',
): { rows: T[]; population: TaskPopulation } {
  if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(offset) || offset < 0) {
    throw new CleoError(
      ExitCode.INVALID_INPUT,
      'Task limit and offset must be non-negative integers',
    );
  }
  const selected = limit === 0 ? rows.slice(offset) : rows.slice(offset, offset + limit);
  return {
    rows: selected,
    population: {
      matched: rows.length,
      returned: selected.length,
      truncated: selected.length < rows.length,
      limit: limit === 0 ? null : limit,
      offset,
      archive,
    },
  };
}
