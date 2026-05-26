/**
 * Show full task details by ID.
 * @task T4460
 * @epic T4454
 */

import type { Task, TaskRecord, TaskRef, TaskView } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts';
import { type EngineResult, engineSuccess } from '../engine-result.js';
import { CleoError } from '../errors.js';
import { cleoErrorToEngineResult } from '../errors-to-engine.js';
import { getLifecycleStatus } from '../lifecycle/index.js';
import { getIvtrState } from '../lifecycle/ivtr-loop.js';
import type { NextDirectives } from '../mvi-helpers.js';
import { taskShowNext } from '../mvi-helpers.js';
import { resolveOrCwd } from '../paths.js';
import type { DataAccessor } from '../store/data-accessor.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { computeTaskView } from './compute-task-view.js';
import {
  type IvtrHistoryEntry,
  type LifecycleStageEntry,
  taskToRecord,
  toHistoryEntry,
} from './engine-converters.js';

/**
 * Hydrated acceptance criterion row surfaced by `cleo show --verbose`.
 *
 * Surfaces the stable UUID (the binding target for `satisfies:<acId>`
 * evidence atoms in T10503), the human-friendly `AC<ordinal>` alias, and
 * the canonical text. Reads from `task_acceptance_criteria` (T10502) —
 * NOT the legacy `tasks.acceptance` JSON string.
 *
 * @task T10508
 * @epic T10381
 */
export interface AcDetail {
  /** Stable UUID-shaped identifier, immutable for the AC's lifetime (legacy v4 or deterministic v5-shaped). */
  id: string;
  /** Display alias derived from ordinal — `AC1`, `AC2`, etc. */
  alias: string;
  /** 1-based ordinal — never reused per task (gaps remain on shrink). */
  ordinal: number;
  /** The AC statement text. Structured gates round-trip as JSON. */
  text: string;
}

/** Enriched task with hierarchy info. */
export interface TaskDetail extends Task {
  children?: string[];
  dependencyStatus?: TaskRef[];
  unresolvedDeps?: TaskRef[];
  dependents?: string[];
  hierarchyPath?: string[];
  isArchived?: boolean;
  /**
   * Acceptance-criterion rows hydrated from `task_acceptance_criteria`.
   * Present when the table contains AC rows for the task (post-T10508
   * dual-write or T10505 backfill). Coexists with the legacy
   * `acceptance` string field — readers should prefer `acRows` when
   * present and fall back to `acceptance` otherwise.
   * @task T10508
   */
  acRows?: AcDetail[];
  /** Progressive disclosure directives for follow-up operations. */
  _next?: NextDirectives;
}

/**
 * Canonical task ID format — uppercase `T` followed by one or more digits.
 *
 * Dispatch-layer sanitization (`sanitizeTaskId`) normalises loose inputs like
 * `t1234` or bare digits before they reach core, so this defensive check
 * targets direct in-process callers (tests, future SDK consumers) where
 * malformed IDs like `T932EP`, `T-foo`, or `TASKABC` would otherwise fall
 * through to a DB miss and surface as a confusing `Task not found`.
 *
 * @task T10109
 */
const CANONICAL_TASK_ID_PATTERN = /^T\d+$/;

/**
 * Get a task by ID with enriched details.
 * Checks active tasks first, then archive if not found.
 * @task T4460
 * @task T10109 — defensive format validation; rejects malformed IDs with
 *               `INVALID_INPUT` instead of silently falling through to a
 *               `NOT_FOUND` DB miss (or worse, a KeyError downstream).
 */
export async function showTask(
  taskId: string,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<TaskDetail> {
  if (!taskId) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'Task ID is required', {
      fix: 'cleo show T###',
      details: { field: 'taskId' },
    });
  }

  if (!CANONICAL_TASK_ID_PATTERN.test(taskId)) {
    throw new CleoError(ExitCode.INVALID_INPUT, `Invalid task ID format: ${taskId}`, {
      fix: 'Use format T followed by digits (e.g., T1234)',
      details: { field: 'taskId', value: taskId, pattern: '^T\\d+$' },
    });
  }

  const acc = accessor ?? (await getTaskAccessor(cwd));

  // First, try to find in active tasks via targeted query
  let task = await acc.loadSingleTask(taskId);
  let isArchived = false;

  // If not found in active tasks, check the archive
  if (!task) {
    const archive = await acc.loadArchive();
    if (archive) {
      task = archive.archivedTasks.find((t) => t.id === taskId) ?? null;
      if (task) {
        isArchived = true;
      }
    }
  }

  if (!task) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task not found: ${taskId}`, {
      fix: `Use 'cleo find "${taskId}"' to search for similar IDs`,
      alternatives: [
        { action: 'Search for task', command: `cleo find "${taskId}"` },
        { action: 'List all tasks', command: 'cleo list' },
      ],
    });
  }

  const detail: TaskDetail = { ...task, isArchived };

  // T10508 — hydrate AC rows from the new task_acceptance_criteria table.
  // Surfaced alongside the legacy `acceptance` string for dual-read.
  // Surface zero rows as undefined so JSON output stays clean for tasks
  // that haven't been backfilled yet.
  try {
    const acRows = await acc.getAcRows(taskId);
    if (acRows.length > 0) {
      detail.acRows = acRows.map((row) => ({
        id: row.id,
        alias: `AC${row.ordinal}`,
        ordinal: row.ordinal,
        text: row.text,
      }));
    }
  } catch {
    // AC table read is best-effort — never block `cleo show` if the
    // table is missing (e.g. legacy DB pre-T10502 migration).
  }

  // Add children (only check active tasks, archived tasks don't have active children)
  if (!isArchived) {
    const children = await acc.getChildren(taskId);
    if (children.length > 0) {
      detail.children = children.map((c) => c.id);
    }

    // Add dependency status
    if (task.depends?.length) {
      const depTasks = await acc.loadTasks(task.depends);
      detail.dependencyStatus = task.depends.map((depId) => {
        const dep = depTasks.find((t) => t.id === depId);
        return {
          id: depId,
          status: dep?.status ?? 'unknown',
          title: dep?.title ?? 'Unknown task',
        };
      });

      // Add unresolvedDeps: only unresolved dependencies (not done/cancelled)
      const unresolved = detail.dependencyStatus.filter(
        (d) => d.status !== 'done' && d.status !== 'cancelled',
      );
      if (unresolved.length > 0) {
        detail.unresolvedDeps = unresolved;
      }
    }

    // Add dependents: tasks that depend on this one
    const dependentTasks = await acc.getDependents(taskId);
    if (dependentTasks.length > 0) {
      detail.dependents = dependentTasks.map((t) => t.id);
    }

    // Build hierarchy path via recursive ancestor chain (root-first, then append self)
    const ancestors = await acc.getAncestorChain(taskId);
    if (ancestors.length > 0) {
      detail.hierarchyPath = [...ancestors.map((t) => t.id), taskId];
    }
  }

  detail._next = taskShowNext(taskId);

  return detail;
}

// ---------------------------------------------------------------------------
// EngineResult-returning wrappers (T1568 / ADR-057 / ADR-058)
// These wrappers allow the dispatch layer to import from @cleocode/core/internal
// instead of task-engine.ts. Each function has identical semantics to its
// counterpart in task-engine.ts.
// ---------------------------------------------------------------------------

/**
 * Convert a caught error to an EngineResult failure.
 *
 * T9940: replaces the prior numeric-code heuristic (code===4 → E_NOT_FOUND,
 * code===2 → E_INVALID_INPUT) with the canonical CleoError → LAFS code path.
 * CleoError instances surface their full LAFS code via `toLAFSError()`
 * (`E_CLEO_NOT_FOUND`, `E_CLEO_VALIDATION`, etc.); non-CleoErrors fall
 * through to the supplied `fallbackCode`. This eliminates the silent
 * blanket-label of `E_NOT_INITIALIZED` for every status-transition and
 * DB-invariant violation that bubbled out of `showTask`.
 *
 * @task T9940
 * @epic T9862
 */
function caughtToEngineError<T>(
  err: unknown,
  fallbackCode: string,
  fallbackMsg: string,
): EngineResult<T> {
  return cleoErrorToEngineResult<T>(err, fallbackCode, fallbackMsg);
}

/**
 * Get a single task by ID, wrapped in EngineResult.
 *
 * Fetches the full task record and computes the canonical TaskView.
 *
 * @param projectRoot - Absolute path to the project root
 * @param taskId - Task identifier (e.g. "T001")
 * @returns EngineResult containing the task record and canonical view
 *
 * @task T1568
 * @epic T1566
 */
export async function taskShow(
  projectRoot: string,
  taskId: string,
): Promise<EngineResult<{ task: TaskRecord; view: TaskView | null }>> {
  try {
    const accessor = await getTaskAccessor(projectRoot);
    const detail = await showTask(taskId, projectRoot, accessor);
    const view = await computeTaskView(taskId, accessor);
    return engineSuccess({ task: taskToRecord(detail), view });
  } catch (err: unknown) {
    return caughtToEngineError(err, 'E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Get a single task by ID, optionally including its lifecycle stage history.
 *
 * @param projectRoot - Absolute path to the project root
 * @param taskId - Task identifier (e.g. "T042")
 * @param includeHistory - When true, append lifecycle stage array
 * @returns EngineResult containing the task record and optional history
 *
 * @task T1568
 * @epic T1566
 */
export async function taskShowWithHistory(
  projectRoot: string,
  taskId: string,
  includeHistory: boolean,
): Promise<EngineResult<{ task: TaskRecord; history?: LifecycleStageEntry[] }>> {
  try {
    const accessor = await getTaskAccessor(projectRoot);
    const detail = await showTask(taskId, projectRoot, accessor);
    const task = taskToRecord(detail);

    if (!includeHistory) {
      return engineSuccess({ task });
    }

    let history: LifecycleStageEntry[] = [];
    try {
      const status = await getLifecycleStatus(resolveOrCwd(projectRoot), { taskId });
      history = status.stages.map(
        (s): LifecycleStageEntry => ({
          stage: s.stage,
          status: (s.status as LifecycleStageEntry['status']) ?? 'not_started',
          startedAt: null,
          completedAt: s.completedAt ?? null,
          outputFile: s.outputFile ?? null,
        }),
      );
    } catch {
      history = [];
    }

    return engineSuccess({ task, history });
  } catch (err: unknown) {
    return caughtToEngineError(err, 'E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Retrieve the IVTR phase history for a task.
 *
 * @param projectRoot - Absolute path to the project root
 * @param taskId - Task identifier (e.g. "T042")
 * @returns EngineResult with ivtrHistory array
 *
 * @task T1568
 * @epic T1566
 */
export async function taskShowIvtrHistory(
  projectRoot: string,
  taskId: string,
): Promise<EngineResult<{ ivtrHistory: IvtrHistoryEntry[] }>> {
  try {
    const ivtrState = await getIvtrState(taskId, { cwd: projectRoot });
    if (!ivtrState) {
      return engineSuccess({ ivtrHistory: [] });
    }
    const ivtrHistory: IvtrHistoryEntry[] = ivtrState.phaseHistory.map(toHistoryEntry);
    return engineSuccess({ ivtrHistory });
  } catch (err: unknown) {
    return caughtToEngineError(err, 'E_NOT_INITIALIZED', 'Failed to read IVTR state');
  }
}

/**
 * Check if a task exists.
 *
 * Returns `{ exists: true }` if the task is found, `{ exists: false }` otherwise.
 * Never fails — catches all errors and returns false.
 *
 * @param projectRoot - Absolute path to the project root
 * @param taskId - Task identifier to check
 * @returns EngineResult with exists flag and the queried taskId
 *
 * @task T1568
 * @epic T1566
 */
export async function taskExists(
  projectRoot: string,
  taskId: string,
): Promise<EngineResult<{ exists: boolean; taskId: string }>> {
  try {
    const accessor = await getTaskAccessor(projectRoot);
    const exists = await accessor.taskExists(taskId);
    return engineSuccess({ exists, taskId });
  } catch {
    return engineSuccess({ exists: false, taskId });
  }
}
