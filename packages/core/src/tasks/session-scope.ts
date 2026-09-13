/**
 * Session-scope parent resolution and task creation with session scope.
 *
 * Provides resolveParentFromSession (3-mechanism parent resolution) and
 * addTaskWithSessionScope (creates a task with session-scope parent inheritance).
 *
 * Extracted from task-engine.ts as part of the T1566 engine-migration epic
 * (ADR-057, ADR-058).
 *
 * Per T9337 / Council 20260515T211404Z, the create-time verifier gate
 * (T9218 / ADR-070) is removed. Enforcement of the anti-scaffold-and-mark-done
 * invariant now lives entirely at `cleo complete` via the ADR-051 evidence-atom
 * Pre-Complete Gate Ritual (commit, files, tool, test-run, decision atoms).
 *
 * @task T1568
 * @task T9337
 * @epic T1566
 * @adr ADR-057
 * @adr ADR-058
 * @adr ADR-051
 */

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
import { cleoErrorToEngineResult } from '../errors-to-engine.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { getActiveSession } from '../store/session-store.js';
import { addTask } from './add.js';
import { taskToRecord } from './engine-converters.js';
import { findTasks } from './find.js';

/**
 * Where a resolved parent came from.
 *
 * @remarks
 * T12136 (GH #1232/#1238) — `E_CLEO_DEPTH_EXCEEDED` named a parent the caller
 * had never mentioned, because it had been inherited from session state, and
 * the message read as though the caller had asked for it. An explicit argument
 * must always outrank an inference, and an inference that fires must be
 * visible in the output; this discriminant is what makes the second half
 * possible.
 *
 * @task T12136
 */
export type ParentSource = 'explicit' | 'parent-search' | 'session-inference';

/** Result of {@link resolveParentFromSession}. */
export interface ParentResolution {
  /** The resolved parent ID, or `null` when none was determined. */
  resolvedParent: string | null;
  /** Where {@link resolvedParent} came from. */
  parentSource: ParentSource;
  /**
   * Present when the resolution was NOT a plain explicit parent — an
   * inference fired, was declined as stale, or the session lookup failed.
   * Safe to surface verbatim to the caller.
   */
  inferenceNote?: string;
  /** Set when resolution failed outright (e.g. `--parent-search` matched nothing). */
  error?: EngineResult<never>;
}

/**
 * Statuses that disqualify a task from being inherited as a parent.
 *
 * @remarks
 * T12136: session state outlives the work it points at. Inheriting a parent
 * from finished work is never what the caller meant.
 */
const NON_INFERABLE_PARENT_STATUSES: ReadonlySet<string> = new Set([
  'done',
  'cancelled',
  'archived',
]);

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
): Promise<ParentResolution> {
  // 1. Explicit --parent: use as-is. An explicit argument ALWAYS outranks an
  //    inference — this branch must stay first.
  if (params.parent) {
    return { resolvedParent: params.parent, parentSource: 'explicit' };
  }

  const accessor = await getTaskAccessor(projectRoot);

  // 2. --parent-search: fuzzy title match. Still caller-driven, but the ID was
  //    chosen by a search rather than named, so it is reported.
  if (params.parentSearch) {
    const searchResult = await findTasks(
      { query: params.parentSearch, limit: 1 },
      projectRoot,
      accessor,
    );
    if (searchResult.results.length > 0) {
      const match = searchResult.results[0];
      return {
        resolvedParent: match.id,
        parentSource: 'parent-search',
        inferenceNote: `--parent-search "${params.parentSearch}" resolved to ${match.id}`,
      };
    }
    return {
      resolvedParent: null,
      parentSource: 'explicit',
      error: engineError(
        'E_NOT_FOUND',
        `No task found matching --parent-search "${params.parentSearch}"`,
      ) as EngineResult<never>,
    };
  }

  // 3. Session-scoped epic inheritance (non-epic tasks only).
  //
  // T12136 (GH #1232/#1238): this is the SECOND session-derived inference site
  // — the CLI's `inferTaskAddParams` infers from the session's `current` task
  // pointer, while this one infers from `session.scope.epicId`. The CLI path
  // sets `params.parent` before reaching here, so this branch is what
  // NON-CLI callers (SDK, dispatch, MCP) actually hit, and it was equally
  // silent. Fixing only the CLI would have left the programmatic path in
  // exactly the state the issues describe.
  if (params.type !== 'epic') {
    try {
      const session = await getActiveSession(projectRoot);
      if (session?.scope?.type === 'epic' && session.scope.epicId) {
        const epicId = session.scope.epicId;
        // Do not inherit from an epic that is already finished — a session
        // scope outlives the work it points at.
        const epic = await accessor.loadSingleTask(epicId);
        if (epic && NON_INFERABLE_PARENT_STATUSES.has(epic.status)) {
          return {
            resolvedParent: null,
            parentSource: 'explicit',
            inferenceNote:
              `declined to inherit parent ${epicId} from the session's epic scope ` +
              `because it is '${epic.status}'; pass --parent <id> explicitly`,
          };
        }
        return {
          resolvedParent: epicId,
          parentSource: 'session-inference',
          inferenceNote:
            `no parent given; inherited ${epicId} from the session's epic scope, ` +
            'not from this command',
        };
      }
    } catch (err: unknown) {
      // Still non-fatal, but no longer indistinguishable from "no session
      // scope" — a broken lookup used to look identical to a clean one.
      return {
        resolvedParent: null,
        parentSource: 'explicit',
        inferenceNote: `session lookup for parent inference failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }

  return { resolvedParent: null, parentSource: 'explicit' };
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
    /**
     * Set by the CLI when it already inferred the parent from the session's
     * `current` pointer, so core does not re-derive provenance it cannot see.
     * @task T12136
     */
    parentSource?: 'explicit' | 'session-inference';
    kind?: string;
    scope?: string;
    severity?: string;
    /**
     * Bypass the BRAIN duplicate-detection rejection guard (T1633).
     * Audited to `.cleo/audit/duplicate-bypass.jsonl`.
     */
    forceDuplicate?: boolean;
  },
): Promise<
  EngineResult<{
    task: TaskRecord;
    duplicate: boolean;
    dryRun?: boolean;
    warnings?: string[];
    /**
     * IDs of done ancestors reopened because this child was added under a done
     * parent (PM-Core V2 design-point 5). @saga T10538
     */
    reopenedAncestors?: string[];
    /**
     * Present when the parent was NOT a plain explicit argument — an inference
     * fired, was declined as stale, or the session lookup failed.
     *
     * @remarks
     * T12136 (GH #1232/#1238): an inference that fires must be visible in the
     * output. It was previously announced only through the CLI's `humanInfo`,
     * which is silent under `--json`/`--quiet`, so programmatic callers — the
     * ones that then hit `E_CLEO_DEPTH_EXCEEDED` naming a task they had never
     * mentioned — never saw it.
     */
    parentInference?: { parentSource: ParentSource; note: string };
  }>
> {
  try {
    const { resolvedParent, parentSource, inferenceNote, error } = await resolveParentFromSession(
      projectRoot,
      {
        parent: params.parent,
        parentSearch: params.parentSearch,
        type: params.type,
      },
    );

    if (error) {
      return error as EngineResult<{
        task: TaskRecord;
        duplicate: boolean;
        dryRun?: boolean;
        warnings?: string[];
        reopenedAncestors?: string[];
      }>;
    }

    const accessor = await getTaskAccessor(projectRoot);
    const result = await addTask(
      {
        title: params.title,
        description: params.description,
        parentId: resolvedParent,
        // T12136: so `E_CLEO_DEPTH_EXCEEDED` can say the parent was inherited
        // rather than named. The CLI may already have decided this upstream.
        parentSource:
          params.parentSource === 'session-inference' || parentSource === 'session-inference'
            ? 'session-inference'
            : 'explicit',
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
      // T12136: report the inference on the machine-readable channel.
      ...(inferenceNote ? { parentInference: { parentSource, note: inferenceNote } } : {}),
      ...(result.warnings?.length && { warnings: result.warnings }),
      // T10538 / design-point 5 — surface the ancestor reopen to the caller.
      ...(result.reopenedAncestors?.length && {
        reopenedAncestors: result.reopenedAncestors,
      }),
    });
  } catch (err: unknown) {
    // T9940: preserve CleoError LAFS codes; non-CleoError falls through to
    // E_INTERNAL (not the misleading E_NOT_INITIALIZED blanket label).
    return cleoErrorToEngineResult(err, 'E_INTERNAL', 'Failed to add task with session scope');
  }
}
