import type {
  CompletionContextPack,
  CompletionContextPackOptions,
  CompletionContextPackSummary,
  CompletionHistoryEvent,
  CompletionHistoryEventAction,
  DataAccessor,
  Task,
  TaskAuditLogRow,
} from '@cleocode/contracts';

export const COMPLETION_HISTORY_ACTIONS: readonly CompletionHistoryEventAction[] = [
  'task_completed',
  'task_reopened',
  'task_cancelled',
  'task_uncancelled',
  'task_reparented',
  'ac_projection_rebuilt',
];

const DEFAULT_LIMIT = 20;
const DEFAULT_RELATION_DEPTH = 1;

function clampPositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function classifyRelation(task: Task, relatedTask: Task): CompletionHistoryEvent['relation'] {
  if (relatedTask.id === task.id) return 'self';
  if (relatedTask.id === task.parentId) return 'parent';
  if (relatedTask.parentId === task.id) return 'child';
  if (task.parentId && relatedTask.parentId === task.parentId) return 'sibling';
  return 'related';
}

function eventFromAuditRow(
  row: TaskAuditLogRow,
  task: Task,
  relatedTasks: ReadonlyMap<string, Task>,
): CompletionHistoryEvent {
  const details = parseJsonObject(row.detailsJson);
  const before = parseJsonObject(row.beforeJson);
  const after = parseJsonObject(row.afterJson);
  const relatedTask = relatedTasks.get(row.taskId);
  return {
    id: row.id,
    timestamp: row.timestamp,
    action: row.action as CompletionHistoryEventAction,
    taskId: row.taskId,
    relation: relatedTask ? classifyRelation(task, relatedTask) : 'related',
    actor: row.actor,
    ...(details ? { details } : {}),
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
  };
}

function summarize(events: readonly CompletionHistoryEvent[]): CompletionContextPackSummary {
  const byAction = Object.fromEntries(
    COMPLETION_HISTORY_ACTIONS.map((action) => [action, 0]),
  ) as Record<CompletionHistoryEventAction, number>;
  const byRelation: CompletionContextPackSummary['byRelation'] = {
    self: 0,
    parent: 0,
    child: 0,
    sibling: 0,
    related: 0,
  };

  for (const event of events) {
    byAction[event.action] = (byAction[event.action] ?? 0) + 1;
    byRelation[event.relation] = (byRelation[event.relation] ?? 0) + 1;
  }

  return {
    totalEvents: events.length,
    byAction,
    byRelation,
    latestEventAt: events[0]?.timestamp ?? null,
  };
}

async function collectRelatedTasks(
  taskId: string,
  accessor: DataAccessor,
  relationDepth: number,
): Promise<{ task: Task; relatedTasks: Task[] }> {
  const task = await accessor.loadSingleTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  const tasks = new Map<string, Task>([[task.id, task]]);
  if (relationDepth > 0) {
    const children = await accessor.getChildren(taskId);
    for (const child of children) tasks.set(child.id, child);

    if (task.parentId) {
      const parent = await accessor.loadSingleTask(task.parentId);
      if (parent) tasks.set(parent.id, parent);

      const siblings = await accessor.getChildren(task.parentId);
      for (const sibling of siblings) tasks.set(sibling.id, sibling);
    }
  }

  return { task, relatedTasks: [...tasks.values()] };
}

/**
 * Build the completion-evaluation context pack from append-only task audit rows.
 *
 * The pack intentionally keeps the query bounded (recent lifecycle events only)
 * while preserving enough structured detail for completion explanation surfaces
 * to cite nearby completions, reopens, cancellations, reparents, and projection
 * rebuilds without re-scanning raw audit rows.
 */
export async function buildCompletionContextPack(
  taskId: string,
  accessor: DataAccessor,
  options: CompletionContextPackOptions = {},
): Promise<CompletionContextPack> {
  const limit = clampPositiveInteger(options.limit, DEFAULT_LIMIT);
  const relationDepth = clampPositiveInteger(options.relationDepth, DEFAULT_RELATION_DEPTH);
  const { task, relatedTasks } = await collectRelatedTasks(taskId, accessor, relationDepth);
  const relatedTaskMap = new Map(relatedTasks.map((task) => [task.id, task]));
  const relatedTaskIds = relatedTasks.map((task) => task.id);

  const rows = await accessor.queryAuditLog({
    taskIds: relatedTaskIds,
    actions: [...COMPLETION_HISTORY_ACTIONS],
    since: options.since,
    limit,
  });
  const events = rows.map((row) => eventFromAuditRow(row, task, relatedTaskMap));

  return {
    taskId,
    generatedAt: new Date().toISOString(),
    source: 'audit_log',
    window: {
      limit,
      ...(options.since ? { since: options.since } : {}),
      relationDepth,
      relatedTaskIds,
    },
    events,
    summary: summarize(events),
  };
}
