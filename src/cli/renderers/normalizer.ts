/**
 * CLI Rendering Normalizer — safety net for human-readable output.
 *
 * Ensures data passed to human renderers has the expected shape,
 * regardless of whether the engine layer has been fully fixed.
 * Only called for human format — JSON output is untouched.
 *
 * Detection is idempotent: if data already has the expected key,
 * it passes through unchanged.
 *
 * @task T4813
 */

/**
 * Normalize data shape for human renderers.
 *
 * Each command expects data with specific named keys (e.g., `data.task`
 * for 'show', `data.tasks` for 'list'). This function detects and
 * corrects flat/array data from the engine layer.
 */
export function normalizeForHuman(
  command: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  switch (command) {
    case 'show':
      return normalizeTaskWrapper(data);

    case 'list':
    case 'ls':
      return normalizeTaskList(data);

    case 'find':
    case 'search':
      return normalizeFindResults(data);

    case 'add':
      return normalizeTaskWrapper(data);

    case 'update':
      return normalizeTaskWrapper(data);

    case 'complete':
    case 'done':
      return normalizeTaskWrapper(data);

    case 'delete':
    case 'rm':
      return normalizeDeleteResult(data);

    case 'archive':
      return normalizeArchiveResult(data);

    default:
      return data;
  }
}

/**
 * Wrap a flat task record as { task: ... } if not already wrapped.
 * Detects flat tasks by the presence of 'id' without 'task'.
 */
function normalizeTaskWrapper(data: Record<string, unknown>): Record<string, unknown> {
  if (data['task']) return data;
  if (data['id'] && typeof data['id'] === 'string') {
    return { task: data };
  }
  return data;
}

/**
 * Wrap a raw array as { tasks: [...], total: N } if not already wrapped.
 */
function normalizeTaskList(data: Record<string, unknown>): Record<string, unknown> {
  if (data['tasks']) return data;
  if (Array.isArray(data)) {
    return { tasks: data, total: data.length };
  }
  return data;
}

/**
 * Wrap a raw array as { results: [...], total: N } if not already wrapped.
 */
function normalizeFindResults(data: Record<string, unknown>): Record<string, unknown> {
  if (data['results']) return data;
  if (Array.isArray(data)) {
    return { results: data, total: data.length };
  }
  return data;
}

/**
 * Normalize delete result: ensure deletedTask exists.
 */
function normalizeDeleteResult(data: Record<string, unknown>): Record<string, unknown> {
  if (data['deletedTask']) return data;
  if (data['taskId']) {
    return { ...data, deletedTask: { id: data['taskId'] } };
  }
  return data;
}

/**
 * Normalize archive result: ensure archivedCount exists.
 */
function normalizeArchiveResult(data: Record<string, unknown>): Record<string, unknown> {
  if (data['archivedCount'] !== undefined) return data;
  if (data['archived'] !== undefined && typeof data['archived'] === 'number') {
    return {
      ...data,
      archivedCount: data['archived'],
      archivedTasks: (data['taskIds'] as string[] | undefined)?.map((id: string) => ({ id })),
    };
  }
  return data;
}
