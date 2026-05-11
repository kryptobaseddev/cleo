/**
 * Session-scope parent resolution and task creation with session scope.
 *
 * Provides resolveParentFromSession (3-mechanism parent resolution) and
 * addTaskWithSessionScope (creates a task with session-scope parent inheritance).
 *
 * Extracted from task-engine.ts as part of the T1566 engine-migration epic
 * (ADR-057, ADR-058).
 *
 * T9218 / ADR-070: addTaskWithSessionScope enforces mandatory verifier at
 * creation time for high-consequence tasks (priority=critical OR size=large
 * OR type=epic). The caller must pass a `verifier` path that points to an
 * existing `.mjs` file, or the operation is rejected with E_VERIFIER_REQUIRED.
 * Use `cleo verify backfill <taskId>` to generate stubs for existing tasks.
 *
 * @task T1568
 * @epic T1566
 * @task T9218
 * @adr ADR-057
 * @adr ADR-058
 * @adr ADR-070
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  TaskKind,
  TaskPriority,
  TaskRecord,
  TaskScope,
  TaskSeverity,
  TaskSize,
  TaskType,
} from '@cleocode/contracts';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { getTaskAccessor } from '../store/data-accessor.js';
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

  const accessor = await getTaskAccessor(projectRoot);

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
/**
 * Check whether a task creation is a "high-consequence" task that requires a
 * verifier script to be registered at creation time (T9218 / ADR-070).
 *
 * High-consequence conditions (any one triggers requirement):
 *   - priority is 'critical'
 *   - size is 'large'
 *   - type is 'epic'
 *
 * @param params - Subset of task creation parameters to evaluate.
 * @returns True when a verifier is required.
 */
function requiresVerifier(params: { priority?: string; size?: string; type?: string }): boolean {
  return params.priority === 'critical' || params.size === 'large' || params.type === 'epic';
}

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
    kind?: string;
    scope?: string;
    severity?: string;
    /**
     * Bypass the BRAIN duplicate-detection rejection guard (T1633).
     * Audited to `.cleo/audit/duplicate-bypass.jsonl`.
     */
    forceDuplicate?: boolean;
    /**
     * Path to an existing verifier script for this task (T9218 / ADR-070).
     *
     * Required when priority=critical OR size=large OR type=epic. The path
     * must point to an existing `.mjs` file (absolute or relative to
     * projectRoot). Omitting this on high-consequence tasks causes the
     * operation to be rejected with E_VERIFIER_REQUIRED.
     *
     * Use `cleo verify backfill <taskId>` to auto-generate a stub verifier
     * for existing tasks that lack one.
     */
    verifier?: string;
  },
): Promise<
  EngineResult<{ task: TaskRecord; duplicate: boolean; dryRun?: boolean; warnings?: string[] }>
> {
  try {
    // T9218 / ADR-070: Strict-mode verifier enforcement.
    // High-consequence tasks (priority=critical, size=large, type=epic) MUST
    // provide a verifier path at creation time. Skip enforcement for dry-run.
    if (!params.dryRun && requiresVerifier(params)) {
      if (!params.verifier) {
        const why =
          params.priority === 'critical'
            ? 'priority=critical'
            : params.size === 'large'
              ? 'size=large'
              : 'type=epic';
        return engineError(
          'E_VERIFIER_REQUIRED',
          `Task creation rejected: ${why} tasks require a verifier script.\n` +
            `  Pass --verifier <path/to/verify-<id>.mjs> or run:\n` +
            `    cleo verify backfill <taskId>\n` +
            `  after creating the task to auto-generate a stub from the AC text.\n` +
            `  See ADR-070 for rationale.`,
        ) as EngineResult<{
          task: TaskRecord;
          duplicate: boolean;
          dryRun?: boolean;
          warnings?: string[];
        }>;
      }

      // Verifier was provided — validate the path exists
      const verifierAbs = params.verifier.startsWith('/')
        ? params.verifier
        : resolve(projectRoot, params.verifier);
      if (!existsSync(verifierAbs)) {
        return engineError(
          'E_VERIFIER_REQUIRED',
          `Task creation rejected: verifier script not found: ${verifierAbs}\n` +
            `  The --verifier path must point to an existing .mjs file.\n` +
            `  Run: cleo verify backfill <taskId> to auto-generate a stub.\n` +
            `  See ADR-070 for rationale.`,
        ) as EngineResult<{
          task: TaskRecord;
          duplicate: boolean;
          dryRun?: boolean;
          warnings?: string[];
        }>;
      }
    }

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

    const accessor = await getTaskAccessor(projectRoot);
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
        kind: params.kind as TaskKind | undefined,
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
