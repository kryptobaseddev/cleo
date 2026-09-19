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

/**
 * Apply identical eligibility to ordinary and archived task rows.
 * @param task - Candidate task from either storage population.
 * @param filters - Axis, parent, label and phase eligibility constraints.
 * @returns Whether the candidate satisfies every supplied constraint.
 * @remarks Archive inclusion is handled by the population reader, before pagination.
 * @example
 * ```ts
 * const eligible = matchesTaskFilters(task, { parentId: "T001" });
 * ```
 */
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

/**
 * Read the full eligible population before matching or pagination.
 * @param accessor - Project-bound canonical task store.
 * @param filters - Eligibility constraints; pagination fields are deliberately ignored.
 * @param includeArchive - Include archived storage rows with the same filters.
 * @returns Eligible task rows deduplicated by task identity.
 * @remarks Archive read errors propagate; they must not imply an empty population.
 * @example
 * ```ts
 * const tasks = await readTaskPopulation(accessor, { parentId: "T001" }, true);
 * ```
 */
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

/**
 * Slice once and retain explicit match, returned, pagination and archive facts.
 * @typeParam T - Eligible row shape retained without projection.
 * @param rows - Entire matched population in presentation order.
 * @param limit - Non-negative page size; zero returns all rows after offset.
 * @param offset - Non-negative count of initial matched rows to skip.
 * @param archive - Archive inclusion policy used when assembling the population.
 * @returns Selected rows and matched-versus-returned population facts.
 * @remarks Invalid or fractional bounds are rejected rather than rounded or defaulted.
 * @example
 * ```ts
 * const page = paginateTaskPopulation(tasks, 10, 0, "excluded");
 * ```
 */
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
