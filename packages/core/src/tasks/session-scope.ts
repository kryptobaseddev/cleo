/**
 * Session-scope parent resolution and task creation with session scope.
 *
 * Provides resolveParentFromSession (3-mechanism parent resolution) and
 * addTaskWithSessionScope (creates a task with session-scope parent inheritance).
 *
 * Extracted from task-engine.ts as part of the T1566 engine-migration epic
 * (ADR-057, ADR-058).
 *
 * @task T1568
 * @epic T1566
 * @adr ADR-057
 * @adr ADR-058
 */

import type {
  TaskPriority,
  TaskRecord,
  TaskRole,
  TaskScope,
  TaskSeverity,
  TaskSize,
  TaskType,
} from '@cleocode/contracts';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { getAccessor } from '../store/data-accessor.js';
import { getActiveSession } from '../store/session-store.js';
import { addTask } from './add.js';
import { taskToRecord } from './engine-converters.js';
import { findTasks } from './find.js';

/**
 * Resolve the parent task ID through 3 mechanisms in priority order (T090):
 * 1. Explicit --parent flag (already resolved by caller)
 * 2. --parent-search fuzzy title match
 * 3. Session-scoped epic inheritance (when session scope is epic:T###)
 *
 * @param projectRoot - Absolute path to the project root
 * @param params - Resolution parameters
 * @returns Resolved parent ID or null
 *
 * @task T1568
 * @epic T1566
 */
export async function resolveParentFromSession(
  projectRoot: string,
  params: {
    parent?: string | null;
    parentSearch?: string;
    type?: string;
  },
): Promise<{ resolvedParent: string | null; error?: EngineResult<never> }> {
  // 1. Explicit --parent: use as-is
  if (params.parent) {
    return { resolvedParent: params.parent };
  }

  const accessor = await getAccessor(projectRoot);

  // 2. --parent-search: fuzzy title match
  if (params.parentSearch) {
    const searchResult = await findTasks(
      { query: params.parentSearch, limit: 1 },
      projectRoot,
      accessor,
    );
    if (searchResult.results.length > 0) {
      return { resolvedParent: searchResult.results[0].id };
    }
    return {
      resolvedParent: null,
      error: engineError(
        'E_NOT_FOUND',
        `No task found matching --parent-search "${params.parentSearch}"`,
      ) as EngineResult<never>,
    };
  }

  // 3. Session-scoped epic inheritance (non-epic tasks only)
  if (params.type !== 'epic') {
    try {
      const session = await getActiveSession(projectRoot);
      if (session?.scope?.type === 'epic' && session.scope.epicId) {
        return { resolvedParent: session.scope.epicId };
      }
    } catch {
      // Session lookup failure is non-fatal — proceed without parent
    }
  }

  return { resolvedParent: null };
}

/**
 * Create a new task with session-scope parent resolution.
 *
 * Replaces taskCreate from task-engine.ts. Wraps addTask with the 3-mechanism
 * parent resolution logic (explicit parent, parent-search, session epic scope).
 *
 * @param projectRoot - Absolute path to the project root
 * @param params - Task creation parameters
 * @returns EngineResult with the created task record and duplicate flag
 *
 * @task T1568
 * @epic T1566
 */
export async function addTaskWithSessionScope(
  projectRoot: string,
  params: {
    title: string;
    description?: string;
    parent?: string;
    depends?: string[];
    priority?: string;
    labels?: string[];
    type?: string;
    phase?: string;
    size?: string;
    acceptance?: string[];
    notes?: string;
    files?: string[];
    dryRun?: boolean;
    parentSearch?: string;
    role?: string;
    scope?: string;
    severity?: string;
    /**
     * Bypass the BRAIN duplicate-detection rejection guard (T1633).
     * Audited to `.cleo/audit/duplicate-bypass.jsonl`.
     */
    forceDuplicate?: boolean;
  },
): Promise<
  EngineResult<{ task: TaskRecord; duplicate: boolean; dryRun?: boolean; warnings?: string[] }>
> {
  try {
    const { resolvedParent, error } = await resolveParentFromSession(projectRoot, {
      parent: params.parent,
      parentSearch: params.parentSearch,
      type: params.type,
    });

    if (error) {
      return error as EngineResult<{
        task: TaskRecord;
        duplicate: boolean;
        dryRun?: boolean;
        warnings?: string[];
      }>;
    }

    const accessor = await getAccessor(projectRoot);
    const result = await addTask(
      {
        title: params.title,
        description: params.description,
        parentId: resolvedParent,
        depends: params.depends,
        priority: (params.priority as TaskPriority) || 'medium',
        labels: params.labels,
        type: (params.type as TaskType) || undefined,
        phase: params.phase,
        size: params.size as TaskSize | undefined,
        acceptance: params.acceptance,
        notes: params.notes,
        files: params.files,
        dryRun: params.dryRun,
        role: params.role as TaskRole | undefined,
        scope: params.scope as TaskScope | undefined,
        severity: params.severity as TaskSeverity | undefined,
        forceDuplicate: params.forceDuplicate,
      },
      projectRoot,
      accessor,
    );

    return engineSuccess({
      task: taskToRecord(result.task),
      duplicate: result.duplicate ?? false,
      dryRun: params.dryRun,
      ...(result.warnings?.length && { warnings: result.warnings }),
    });
  } catch (err: unknown) {
    const e = err as { message?: string };
    return engineError('E_NOT_INITIALIZED', e?.message ?? 'Task database not initialized');
  }
}
