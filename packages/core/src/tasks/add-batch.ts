/**
 * Batch task creation with TRUE single-transaction atomicity.
 *
 * All N `addTask` inserts are wrapped in a SINGLE `dataAccessor.transaction()`
 * call. This works because both `DataAccessor.transaction()` and
 * `allocateNextTaskId()` now use SQLite SAVEPOINTs instead of `BEGIN IMMEDIATE`
 * (T9814 — sqlite-data-accessor.ts + sequence/index.ts). SAVEPOINTs nest
 * correctly: a top-level SAVEPOINT starts a deferred transaction; a nested
 * SAVEPOINT creates a logical checkpoint inside the outer one.
 *
 * If ANY `addTask` call throws inside the batch transaction, the outer
 * SAVEPOINT is rolled back — reverting ALL inserts atomically. No intermediate
 * state is ever visible to concurrent readers.
 *
 * Closes the CORE gap exposed by T9813: the CLI `add-batch` command was a
 * for-loop calling `tasks.add` N times with NO rollback on failure.
 *
 * @task T9814
 * @epic T9813
 */

import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import type { DataAccessor } from '../store/data-accessor.js';
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
  /** Number of tasks that were created (0 on dry-run). */
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
 * Add multiple tasks in a single atomic transaction.
 *
 * All inserts execute inside ONE `dataAccessor.transaction()` call. Any
 * failure inside the transaction causes the entire SAVEPOINT to be rolled
 * back — no partial writes are ever visible. The batch is atomic in the
 * strict SQL sense.
 *
 * @param opts - Batch options (task specs + optional defaultParent + dryRun).
 * @param dataAccessor - Pre-opened DataAccessor (caller manages lifecycle).
 * @param cwd - Optional project root (passed through to `addTask`).
 * @returns AddBatchResult with per-task results and aggregate count.
 *
 * @throws Error when any task spec fails validation. The error message
 *   identifies the failing task index and title. All prior inserts are
 *   rolled back before the error surfaces.
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

  // Live path: all inserts inside ONE transaction (SAVEPOINT-based).
  //
  // Both DataAccessor.transaction() and allocateNextTaskId() use SQLite
  // SAVEPOINTs (T9814), so this outer transaction correctly wraps every
  // counter increment and row upsert from every addTask call inside it.
  // Any throw causes the outer SAVEPOINT to roll back ALL writes.
  const results: AddTaskResult[] = [];

  await dataAccessor.transaction(async () => {
    for (let i = 0; i < taskSpecs.length; i++) {
      const spec = taskSpecs[i]!;
      const merged: AddTaskOptions = {
        ...spec,
        parentId: spec.parentId ?? defaultParent,
      };
      try {
        const result = await addTask(merged, cwd, dataAccessor);
        results.push(result);
      } catch (err) {
        // Re-throw with index context so callers can identify the failing task.
        // The outer transaction catch will rollback all prior inserts.
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
  });

  return { created: results.length, tasks: results };
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
// Op wrapper (ADR-057 D1 shape — returns EngineResult for wrapCoreResult)
// ---------------------------------------------------------------------------

/**
 * Normalized wrapper for {@link addBatchTasks}.
 * ADR-057 D1 shape: (projectRoot: string, params: TasksAddBatchParams)
 *
 * Returns `EngineResult<AddBatchResult>` so the dispatch layer can call
 * `wrapCoreResult(await tasksAddBatchOp(...), 'add-batch')` — the same
 * pattern used by every other Core op in tasks.ts.
 *
 * Maps wire-format `parent` → internal `parentId` before calling Core.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params - Batch operation parameters (wire format).
 * @returns EngineResult wrapping AddBatchResult on success, error on failure.
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
): Promise<EngineResult<AddBatchResult>> {
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
    const result = await addBatchTasks(
      {
        tasks: taskOpts,
        defaultParent: params.defaultParent,
        dryRun: params.dryRun,
      },
      accessor,
      projectRoot,
    );
    return engineSuccess(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown batch error';
    const cleo = err as { exitCode?: number; fix?: string };
    return engineError<AddBatchResult>('E_BATCH_FAILED', message, {
      exitCode: cleo.exitCode,
      fix: typeof cleo.fix === 'string' ? cleo.fix : undefined,
    });
  } finally {
    await accessor.close();
  }
}
