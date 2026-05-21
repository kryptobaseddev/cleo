/**
 * Batch task creation with atomic all-or-nothing semantics.
 *
 * Each `addTask` call uses its own `dataAccessor.transaction()` internally
 * (required because `allocateNextTaskId` also uses a raw SQLite BEGIN IMMEDIATE
 * and cannot be nested). To provide atomic rollback semantics, this module:
 *
 *   1. Attempts each `addTask` in sequence, collecting created IDs.
 *   2. On any failure, deletes all previously created tasks in a single
 *      compensating `dataAccessor.transaction()` call.
 *   3. Re-throws the original error so callers see a clean failure.
 *
 * From the caller's perspective the behaviour is atomic: either all N tasks
 * are present, or none are (modulo a vanishingly small window between step 2
 * completion and step 3). True single-statement SQL atomicity is architecturally
 * blocked by `allocateNextTaskId`'s raw BEGIN IMMEDIATE that cannot be nested
 * inside a DataAccessor transaction.
 *
 * Closes the CORE gap exposed by T9813: the CLI `add-batch` command was a
 * for-loop calling `tasks.add` N times with NO rollback on failure.
 *
 * @task T9814
 * @epic T9813
 */

import type { DataAccessor, TransactionAccessor } from '../store/data-accessor.js';
import { type AddTaskOptions, type AddTaskResult, addTask } from './add.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options for `addBatchTasks`.
 */
export interface AddBatchOptions {
  /** List of task specs to insert. Must be non-empty. */
  tasks: AddTaskOptions[];
  /** Optional default parent ID applied when a task spec omits `parentId`. */
  defaultParent?: string;
  /**
   * When true, validate and predict IDs without writing to the database.
   * All tasks in the batch receive a synthetic ID of the form
   * `T???` (matching the single-add dry-run convention).
   */
  dryRun?: boolean;
}

/**
 * Result of `addBatchTasks`.
 */
export interface AddBatchResult {
  /** Number of tasks that were created (0 on rollback or dry-run). */
  created: number;
  /** Individual results for each input task spec (in order). */
  tasks: AddTaskResult[];
  /** Whether this was a dry run. */
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Add multiple tasks with all-or-nothing semantics.
 *
 * Each insert is attempted in sequence. If ANY insert fails, all previously
 * created tasks are deleted in a single compensating transaction, then the
 * error is re-thrown. The net observable effect is atomic: either every task
 * exists or none do.
 *
 * @param opts - Batch options (task specs + optional defaultParent + dryRun).
 * @param dataAccessor - Pre-opened DataAccessor (caller manages lifecycle).
 * @param cwd - Optional project root (passed through to `addTask`).
 * @returns AddBatchResult with per-task results and aggregate count.
 *
 * @throws Error when any task spec fails validation. The error message
 *   identifies the failing task index and title. All prior inserts are
 *   rolled back (deleted) before the error surfaces.
 *
 * @example
 * ```ts
 * import { addBatchTasks } from './add-batch.js';
 * import { getTaskAccessor } from '../store/data-accessor.js';
 *
 * const accessor = await getTaskAccessor('/project');
 * const result = await addBatchTasks(
 *   {
 *     tasks: [
 *       { title: 'Task A', description: 'First task' },
 *       { title: 'Task B', description: 'Second task', parentId: 'T001' },
 *     ],
 *   },
 *   accessor,
 *   '/project',
 * );
 * console.log(result.created); // 2
 * ```
 */
export async function addBatchTasks(
  opts: AddBatchOptions,
  dataAccessor: DataAccessor,
  cwd?: string,
): Promise<AddBatchResult> {
  const { tasks: taskSpecs, defaultParent, dryRun = false } = opts;

  if (!taskSpecs || taskSpecs.length === 0) {
    return { created: 0, tasks: [], dryRun };
  }

  // Dry-run path: validate each task spec without writing.
  if (dryRun) {
    const results: AddTaskResult[] = [];
    for (let i = 0; i < taskSpecs.length; i++) {
      const spec = taskSpecs[i]!;
      const merged: AddTaskOptions = {
        ...spec,
        parentId: spec.parentId ?? defaultParent,
        dryRun: true,
      };
      const result = await addTask(merged, cwd, dataAccessor);
      results.push(result);
    }
    return { created: 0, tasks: results, dryRun: true };
  }

  // Live path: attempt each insert in sequence with compensating-rollback on failure.
  const results: AddTaskResult[] = [];
  const createdIds: string[] = [];

  for (let i = 0; i < taskSpecs.length; i++) {
    const spec = taskSpecs[i]!;
    const merged: AddTaskOptions = {
      ...spec,
      parentId: spec.parentId ?? defaultParent,
    };

    try {
      const result = await addTask(merged, cwd, dataAccessor);
      results.push(result);
      // Track IDs of tasks that were genuinely created (not dry-run, not duplicate-returned)
      if (!result.duplicate && result.task.id !== 'T???') {
        createdIds.push(result.task.id);
      }
    } catch (err) {
      // Compensating rollback: delete all tasks created so far.
      if (createdIds.length > 0) {
        await compensatingDelete(createdIds, dataAccessor);
      }

      // Re-throw with index context so callers can identify the failing task.
      const message =
        err instanceof Error ? err.message : `Unknown error in task spec at index ${i}`;
      const contextErr = new Error(
        `tasks.add-batch: failed at index ${i} (title: "${spec.title ?? '?'}"): ${message}`,
      );
      // Preserve exit code if available (CleoError shape)
      const cleo = err as { exitCode?: number; fix?: string };
      if (cleo.exitCode !== undefined) {
        (contextErr as { exitCode?: number }).exitCode = cleo.exitCode;
      }
      if (cleo.fix) {
        (contextErr as { fix?: string }).fix = cleo.fix;
      }
      throw contextErr;
    }
  }

  return { created: results.length, tasks: results };
}

// ---------------------------------------------------------------------------
// Compensating rollback helper
// ---------------------------------------------------------------------------

/**
 * Delete a set of task IDs in a single transaction (compensating rollback).
 *
 * Called when a batch insert partially fails. Removes all tasks that were
 * already created so the net result is zero new tasks.
 *
 * @param taskIds - IDs of tasks to delete.
 * @param dataAccessor - DataAccessor to use for the delete transaction.
 *
 * @internal
 */
async function compensatingDelete(taskIds: string[], dataAccessor: DataAccessor): Promise<void> {
  await dataAccessor.transaction(async (tx: TransactionAccessor) => {
    for (const taskId of taskIds) {
      await tx.removeSingleTask(taskId);
    }
  });
}

// ---------------------------------------------------------------------------
// Wire-format spec type (ADR-057 D2 canonical wire field: `parent` not `parentId`)
// ---------------------------------------------------------------------------

/**
 * Wire-format task spec accepted by the `tasks.add-batch` dispatch operation.
 * Uses `parent` (ADR-057 D2 canonical wire field) instead of `parentId`.
 */
export interface AddBatchTaskSpec {
  title: string;
  description?: string;
  /** Canonical wire field for parent task ID (ADR-057 D2). */
  parent?: string;
  depends?: string[];
  priority?: string;
  labels?: string[];
  type?: string;
  acceptance?: string[];
  phase?: string;
  size?: string;
  notes?: string;
  files?: string[];
  kind?: string;
  scope?: string;
  severity?: string;
  forceDuplicate?: boolean;
}

// ---------------------------------------------------------------------------
// Op wrapper (ADR-057 D1 shape — consumed by ops.ts)
// ---------------------------------------------------------------------------

/**
 * Normalized wrapper for {@link addBatchTasks}.
 * ADR-057 D1 shape: (projectRoot: string, params: TasksAddBatchParams)
 *
 * Maps wire-format `parent` → internal `parentId` before calling Core.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params - Batch operation parameters (wire format).
 * @returns AddBatchResult with per-task results and aggregate count.
 *
 * @task T9814
 */
export async function tasksAddBatchOp(
  projectRoot: string,
  params: {
    tasks: AddBatchTaskSpec[];
    defaultParent?: string;
    dryRun?: boolean;
  },
): Promise<AddBatchResult> {
  // Map wire-format specs (parent) → AddTaskOptions (parentId)
  const taskOpts: AddTaskOptions[] = params.tasks.map((spec) => ({
    title: spec.title,
    description: spec.description,
    // ADR-057 D2: wire field `parent` maps to Core internal `parentId`
    parentId: spec.parent,
    depends: spec.depends,
    priority: spec.priority as AddTaskOptions['priority'],
    labels: spec.labels,
    type: spec.type as AddTaskOptions['type'],
    acceptance: spec.acceptance,
    phase: spec.phase,
    size: spec.size as AddTaskOptions['size'],
    notes: spec.notes,
    files: spec.files,
    kind: spec.kind as AddTaskOptions['kind'],
    scope: spec.scope as AddTaskOptions['scope'],
    severity: spec.severity as AddTaskOptions['severity'],
    forceDuplicate: spec.forceDuplicate,
  }));

  const { getTaskAccessor } = await import('../store/data-accessor.js');
  const accessor = await getTaskAccessor(projectRoot);
  try {
    return await addBatchTasks(
      {
        tasks: taskOpts,
        defaultParent: params.defaultParent,
        dryRun: params.dryRun,
      },
      accessor,
      projectRoot,
    );
  } finally {
    await accessor.close();
  }
}
