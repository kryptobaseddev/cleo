/**
 * Task update logic.
 * @task T4461
 * @epic T4454
 */

import type {
  Task,
  TaskKind,
  TaskPriority,
  TaskRecord,
  TaskScope,
  TaskSeverity,
  TaskSize,
  TaskStatus,
  TasksUpdateQueryParams,
  TaskType,
} from '@cleocode/contracts';
// safeAppendLog replaced by tx.appendLog inside transaction (T023)
import { ExitCode, isAllowedWorkGraphParentType } from '@cleocode/contracts';
import { loadConfig } from '../config.js';
import { type EngineResult, engineSuccess } from '../engine-result.js';
import { CleoError } from '../errors.js';
import { cleoErrorToEngineResult } from '../errors-to-engine.js';
import { pushWarning } from '../output.js';
import { requireActiveSession } from '../sessions/session-enforcement.js';
import type { DataAccessor } from '../store/data-accessor.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { assertTaskVersion, nextTaskVersion } from '../store/task-version.js';
import { enforceAcceptanceImmutability } from './ac-immutability.js';
import { applyAcPlan, planAcUpdate, rebuildChildProjectionAc } from './ac-table.js';
import { normalizeAcceptance } from './acceptance-input.js';
import {
  normalizePriority,
  validateDependencyWaiver,
  validateLabels,
  validateSize,
  validateStatus,
  validateTaskType,
  validateTitle,
} from './add.js';
import { assertNoActiveChildrenForTerminal } from './child-disposition.js';
import { completeTask } from './complete.js';
import { createAcceptanceEnforcement } from './enforcement.js';
import { taskToRecord } from './engine-converters.js';
import {
  findEpicAncestor,
  validateChildStageCeiling,
  validateEpicStageAdvancement,
} from './epic-enforcement.js';
import { childTypeForParentType } from './hierarchy.js';
import { exceedsMaxDepth, resolveHierarchyPolicy } from './hierarchy-policy.js';
import { validatePipelineTransition } from './pipeline-stage.js';
import { rankingAuditEntry, rankingSnapshot, resolveRankingActor } from './ranking-audit.js';
import { prepareSignedSeverityAttestation } from './severity-attestation.js';

const NON_STATUS_DONE_FIELDS: Array<keyof Omit<UpdateTaskOptions, 'taskId' | 'status'>> = [
  'title',
  'priority',
  'type',
  'size',
  'phase',
  'description',
  'labels',
  'addLabels',
  'removeLabels',
  'depends',
  'addDepends',
  'removeDepends',
  'notes',
  'acceptance',
  'files',
  'addFiles',
  'removeFiles',
  'blockedBy',
  'clearBlockedBy',
  'parentId',
  'noAutoComplete',
  'pipelineStage',
  'kind',
  'scope',
  'severity',
  'relates',
  'addRelates',
  'removeRelates',
];

function hasNonStatusDoneFields(options: UpdateTaskOptions): boolean {
  return NON_STATUS_DONE_FIELDS.some((field) => options[field] !== undefined);
}

/** Options for updating a task. */
export interface UpdateTaskOptions {
  taskId: string;
  title?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  type?: TaskType;
  size?: TaskSize;
  phase?: string;
  description?: string;
  labels?: string[];
  addLabels?: string[];
  removeLabels?: string[];
  depends?: string[];
  addDepends?: string[];
  removeDepends?: string[];
  notes?: string;
  acceptance?: string[];
  files?: string[];
  /** Add files incrementally without replacing the full array. @task T9242 */
  addFiles?: string[];
  /** Remove files incrementally. @task T9242 */
  removeFiles?: string[];
  blockedBy?: string;
  /** Clear the blockedBy free-text reason. @task T9241 */
  clearBlockedBy?: boolean;
  parentId?: string | null;
  noAutoComplete?: boolean;
  /** Justification recorded atomically in the task audit log for a critical-priority update. */
  dependsWaiver?: string;
  /** RCASD-IVTR+C pipeline stage transition target. Must be >= current stage. @task T060 */
  pipelineStage?: string;
  /**
   * Task kind axis — intent of work, orthogonal to {@link type}.
   * @task T944
   * @task T9072
   */
  kind?: TaskKind;
  /**
   * Task scope axis — granularity of work, orthogonal to {@link type} and {@link kind}.
   * @task T944
   */
  scope?: TaskScope;
  /**
   * Severity level — valid for any role (widened from bug-only by T9073).
   * Orthogonal to priority — does NOT auto-map priority. `null` clears it
   * (T12693: reverting a ranking change back to "no severity").
   * @task T9073
   */
  severity?: TaskSeverity | null;
  /**
   * Operator-supplied justification required to override the
   * acceptance-criteria immutability guard once a task has entered the
   * implementation pipeline stage. When supplied, the override is recorded
   * in `.cleo/audit/ac-changes.jsonl` together with the before/after AC.
   *
   * Without `--reason`, an attempt to mutate `acceptance` on a task in
   * stage `implementation` (or any later stage) is rejected with
   * {@link ExitCode.AC_LOCKED}.
   *
   * @epic T1586 Foundation Lockdown
   * @task T1590
   */
  reason?: string;
  /**
   * What is making the change, recorded on the ranking audit row (T12693):
   * `update` (default) or `revert`.
   */
  rankingSource?: 'update' | 'revert';
  /** Set related tasks (replaces existing). @task T9327 */
  relates?: Array<{ taskId: string; type: string; reason?: string }>;
  /** Add related tasks without overwriting existing. @task T9327 */
  addRelates?: Array<{ taskId: string; type: string; reason?: string }>;
  /** Remove related tasks by taskId. @task T9327 */
  removeRelates?: string[];
  /**
   * Optimistic-concurrency guard: the task version (`updatedAt`) the caller
   * read. It is compared with the stored row inside the write transaction and
   * a mismatch throws `E_CONFLICT` (`ExitCode.VERSION_CONFLICT`) carrying the
   * current version. Omit it for last-writer-wins on scalar fields; the set
   * operations below are atomic either way. @task T12503
   */
  expectedUpdatedAt?: string;
}

/**
 * Task fields each scalar change name owns. Inside the write transaction the
 * update is rebased onto the CURRENT row: only these fields are copied from
 * the staged task, so a concurrent writer's changes to other fields survive.
 * @task T12503
 */
const SCALAR_FIELDS_BY_CHANGE: Readonly<Record<string, ReadonlyArray<keyof Task>>> = {
  title: ['title'],
  status: ['status', 'completedAt', 'cancelledAt'],
  priority: ['priority'],
  type: ['type'],
  size: ['size'],
  phase: ['phase'],
  description: ['description'],
  acceptance: ['acceptance'],
  blockedBy: ['blockedBy'],
  noAutoComplete: ['noAutoComplete'],
  kind: ['kind'],
  scope: ['scope'],
  severity: ['severity'],
  pipelineStage: ['pipelineStage'],
  parentId: ['parentId', 'type'],
};

function copyTaskField<K extends keyof Task>(to: Task, from: Task, key: K): void {
  to[key] = from[key];
}

function withAdded(values: string[] | undefined, added: string[]): string[] {
  const set = new Set(values ?? []);
  for (const value of added) set.add(value.trim());
  return [...set];
}

function withRemoved(values: string[] | undefined, removed: string[]): string[] {
  const toRemove = new Set(removed.map((value) => value.trim()));
  return (values ?? []).filter((value) => !toRemove.has(value));
}

/**
 * Apply the collection mutations of an update (labels, depends, files,
 * relates, notes) to `target` as set operations against ITS current values.
 *
 * `updateTask` runs this twice: once on the pre-transaction read so
 * validation sees the intended result, and again on the row re-read inside
 * the write transaction so a concurrent `--add-labels` (or depends/files)
 * from another process is merged, never overwritten from a stale read.
 * Arrays are replaced, never mutated in place. @task T12503
 */
function applyCollectionOps(
  target: Task,
  options: UpdateTaskOptions,
  note: string | undefined,
): void {
  if (options.labels !== undefined) target.labels = [...options.labels];
  if (options.addLabels?.length) target.labels = withAdded(target.labels, options.addLabels);
  if (options.removeLabels?.length)
    target.labels = withRemoved(target.labels, options.removeLabels);

  if (options.depends !== undefined) target.depends = [...options.depends];
  if (options.addDepends?.length) target.depends = withAdded(target.depends, options.addDepends);
  if (options.removeDepends?.length)
    target.depends = withRemoved(target.depends, options.removeDepends);

  if (options.files !== undefined) target.files = [...options.files];
  if (options.addFiles?.length) target.files = withAdded(target.files, options.addFiles);
  if (options.removeFiles?.length) target.files = withRemoved(target.files, options.removeFiles);

  if (options.relates !== undefined) {
    target.relates = options.relates.map((r) => ({
      taskId: r.taskId,
      type: r.type,
      ...(r.reason ? { reason: r.reason } : {}),
    }));
  }
  if (options.addRelates?.length) {
    const existing = new Map((target.relates ?? []).map((r) => [r.taskId, r]));
    for (const r of options.addRelates) {
      existing.set(r.taskId, {
        taskId: r.taskId,
        type: r.type,
        ...(r.reason ? { reason: r.reason } : {}),
      });
    }
    target.relates = [...existing.values()];
  }
  if (options.removeRelates?.length) {
    const toRemove = new Set(options.removeRelates.map((id) => id.trim()));
    target.relates = (target.relates ?? []).filter((r) => !toRemove.has(r.taskId));
  }

  if (note !== undefined) target.notes = [...(target.notes ?? []), note];
}

/**
 * Rebase a staged update onto the row read inside the write transaction:
 * copy only the scalar fields this update changed, then re-apply the
 * collection set operations against the current collections. @task T12503
 */
function rebaseTaskUpdate(
  current: Task,
  staged: Task,
  changes: readonly string[],
  options: UpdateTaskOptions,
  note: string | undefined,
): Task {
  const next: Task = { ...current };
  for (const change of new Set(changes)) {
    for (const field of SCALAR_FIELDS_BY_CHANGE[change] ?? []) copyTaskField(next, staged, field);
  }
  applyCollectionOps(next, options, note);
  return next;
}

/** Result of updating a task. */
export interface UpdateTaskResult {
  task: Task;
  changes: string[];
}

/**
 * Update a task's fields.
 * @task T4461
 */
export async function updateTask(
  options: UpdateTaskOptions,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<UpdateTaskResult> {
  if (options.acceptance !== undefined) {
    options = { ...options, acceptance: normalizeAcceptance(options.acceptance) };
  }
  const acc = accessor ?? (await getTaskAccessor(cwd));
  const task = await acc.loadSingleTask(options.taskId);
  if (!task) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task not found: ${options.taskId}`, {
      fix: `Use 'cleo find "${options.taskId}"' to search`,
    });
  }

  await requireActiveSession('tasks.update', cwd);

  // The row this command read, before staging mutates `task` — the baseline
  // for the changed-field summary on E_CONFLICT. @task T12503
  const baseline = structuredClone(task);
  const changes: string[] = [];
  const now = new Date().toISOString();
  const originalParentId = task.parentId ?? null;
  let lifecycleEvent:
    | 'task_completed'
    | 'task_reopened'
    | 'task_cancelled'
    | 'task_uncancelled'
    | null = null;
  let lifecycleBeforeStatus: string | null = null;
  let lifecycleAfterStatus: string | null = null;

  const isStatusOnlyDoneTransition =
    options.status === 'done' && task.status !== 'done' && !hasNonStatusDoneFields(options);

  if (isStatusOnlyDoneTransition) {
    // The complete flow owns its own write transaction and checks the guard
    // inside it. @task T12503
    const result = await completeTask(
      { taskId: options.taskId, expectedUpdatedAt: options.expectedUpdatedAt },
      cwd,
      accessor,
    );
    return { task: result.task, changes: ['status'] };
  }

  if (options.status === 'done' && task.status !== 'done') {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      'status=done must use complete flow; do not combine with other update fields',
      {
        fix: `Run 'cleo complete ${options.taskId}' first, then apply additional updates with 'cleo update ${options.taskId} ...'`,
      },
    );
  }

  // Enforce Acceptance Criteria on Update
  const enforcement = await createAcceptanceEnforcement(cwd);
  const updateValidation = enforcement.validateUpdate(task, { acceptance: options.acceptance });
  if (!updateValidation.valid) {
    throw new CleoError(
      updateValidation.exitCode ?? ExitCode.VALIDATION_ERROR,
      updateValidation.error!,
      { fix: updateValidation.fix },
    );
  }

  // T1590 — AC-immutability guard. Once a task has entered the
  // implementation pipeline stage (or any later stage), changes to
  // `acceptance` require an explicit operator `--reason`, which is
  // recorded in the transactional task_updated audit. The legacy JSONL
  // stream records authorization attempts only. Without a reason, the
  // attempt is rejected with E_AC_LOCKED.
  const acceptanceAuthorization = enforceAcceptanceImmutability({
    task,
    newAcceptance: options.acceptance,
    reason: options.reason,
    projectRoot: cwd,
  });

  // Update fields
  if (options.title !== undefined) {
    validateTitle(options.title);
    task.title = options.title;
    changes.push('title');
  }

  if (options.status !== undefined) {
    validateStatus(options.status);

    // Enforce valid status transitions (e.g. done can only go to pending/active)
    const { validateStatusTransition } = await import('../validation/validation-rules.js');
    const transitionViolations = validateStatusTransition(task.status, options.status);
    if (transitionViolations.length > 0) {
      throw new CleoError(ExitCode.VALIDATION_ERROR, transitionViolations[0].message, {
        fix: `Valid transitions from '${task.status}': see cleo update --help`,
        details: {
          field: transitionViolations[0].field ?? 'status',
          expected: `valid transition from ${task.status}`,
          actual: options.status,
        },
      });
    }

    // T11811 AC2 — orphan-prevention guard. A `status -> cancelled` transition
    // via the update path historically flipped the parent to cancelled with NO
    // child handling, silently STRANDING active children under a terminal
    // parent (the T9031/T9044 strand). Route the transition through the SAME
    // single child-disposition decision `coreTaskCancel` uses: refuse the write
    // when the parent still has active children, pointing the operator at
    // `cleo cancel <id> --children …` (where cascade/reparent live). The guard
    // runs BEFORE any in-memory mutation so a blocked parent is never altered.
    if (options.status === 'cancelled' && task.status !== 'cancelled') {
      await assertNoActiveChildrenForTerminal(acc, options.taskId, 'cancel');
    }

    const oldStatus = task.status;
    task.status = options.status;
    changes.push('status');
    lifecycleBeforeStatus = oldStatus;
    lifecycleAfterStatus = options.status;
    if (options.status === 'done' && oldStatus !== 'done') {
      task.completedAt = now;
      lifecycleEvent = 'task_completed';
    }
    if ((options.status === 'pending' || options.status === 'active') && oldStatus === 'done') {
      lifecycleEvent = 'task_reopened';
    }
    if (options.status === 'pending' && oldStatus === 'cancelled') {
      lifecycleEvent = 'task_uncancelled';
    }
    if (options.status === 'cancelled' && oldStatus !== 'cancelled') {
      task.cancelledAt = now;
      lifecycleEvent = 'task_cancelled';
      // T9838-D: keep pipelineStage in lock-step with status=cancelled to
      // satisfy the T877 invariant trigger (`status=cancelled requires
      // pipeline_stage=cancelled`). The DB invariant (Part B of T877) is
      // stricter than the in-memory cancel-ops sync — it requires the
      // pipeline_stage to be EXACTLY 'cancelled' once status flips, even
      // if the task previously reached the 'contribution' terminal stage.
      // Route every cancellation to the 'cancelled' marker so Studio
      // Pipeline groups the task under CANCELLED and the DB trigger
      // accepts the write.
      if (task.pipelineStage !== 'cancelled') {
        task.pipelineStage = 'cancelled';
        if (!changes.includes('pipelineStage')) changes.push('pipelineStage');
      }
    }
  }

  if (options.priority !== undefined) {
    const normalizedPriority = normalizePriority(options.priority);
    task.priority = normalizedPriority;
    changes.push('priority');
  }

  if (options.type !== undefined) {
    validateTaskType(options.type);
    task.type = options.type;
    changes.push('type');
  }

  if (options.size !== undefined) {
    validateSize(options.size);
    task.size = options.size;
    changes.push('size');
  }

  if (options.phase !== undefined) {
    task.phase = options.phase;
    changes.push('phase');
  }

  if (options.description !== undefined) {
    task.description = options.description;
    changes.push('description');
  }

  // Collection fields (labels, depends, files, relates, notes) are set
  // operations: record the change and validate here, then apply them once to
  // this read (for validation) and again to the row re-read inside the write
  // transaction (for persistence). @task T12503
  if (options.labels !== undefined) {
    if (options.labels.length) validateLabels(options.labels);
    changes.push('labels');
  }

  if (options.addLabels?.length) {
    validateLabels(options.addLabels);
    changes.push('labels');
  }

  if (options.removeLabels?.length) changes.push('labels');

  if (options.depends !== undefined) changes.push('depends');
  if (options.addDepends?.length) changes.push('depends');
  if (options.removeDepends?.length) changes.push('depends');

  const timestampedNote =
    options.notes === undefined
      ? undefined
      : `${new Date()
          .toISOString()
          .replace('T', ' ')
          .replace(/\.\d+Z$/, ' UTC')}: ${options.notes}`;

  applyCollectionOps(task, options, timestampedNote);

  validateDependencyWaiver(options.priority, options.dependsWaiver, task.depends ?? []);

  if (timestampedNote !== undefined) changes.push('notes');

  if (options.acceptance !== undefined) {
    task.acceptance = options.acceptance;
    changes.push('acceptance');
  }

  if (options.files !== undefined) changes.push('files');
  if (options.addFiles?.length) changes.push('files');
  if (options.removeFiles?.length) changes.push('files');

  if (options.blockedBy !== undefined) {
    // Auto-clear when set to empty string (T9241)
    task.blockedBy = options.blockedBy === '' ? undefined : options.blockedBy;
    changes.push('blockedBy');
  }

  if (options.clearBlockedBy === true) {
    task.blockedBy = undefined;
    // Deduplicate if blockedBy was also passed as '' in the same call
    if (!changes.includes('blockedBy')) changes.push('blockedBy');
  }

  if (options.noAutoComplete !== undefined) {
    task.noAutoComplete = options.noAutoComplete;
    changes.push('noAutoComplete');
  }

  // T944/T9072: orthogonal axes
  if (options.kind !== undefined) {
    task.kind = options.kind;
    changes.push('kind');
  }

  if (options.scope !== undefined) {
    task.scope = options.scope;
    changes.push('scope');
  }

  // T9073: severity — orthogonal to priority, valid for any role
  if (options.severity !== undefined) {
    // null clears it (T12693); an explicit null is what the store persists.
    task.severity = options.severity;
    changes.push('severity');
  }

  // T9327: relates mutations (applied by applyCollectionOps above)
  if (options.relates !== undefined) changes.push('relates');
  if (options.addRelates?.length) changes.push('relates');
  if (options.removeRelates?.length) changes.push('relates');

  // Pipeline stage transition — forward-only (T060)
  if (options.pipelineStage !== undefined) {
    validatePipelineTransition(task.pipelineStage, options.pipelineStage);

    // Epic stage advancement gate (T062): block advancement if children are in-flight
    // at the current stage.
    if (task.type === 'epic' && task.pipelineStage) {
      await validateEpicStageAdvancement(
        {
          epicId: task.id,
          currentStage: task.pipelineStage,
          newStage: options.pipelineStage,
        },
        acc,
        cwd,
      );
    }

    // Child stage ceiling (T062): non-epic tasks cannot advance past their epic ancestor.
    if (task.type !== 'epic') {
      const epicAncestor = task.parentId ? await findEpicAncestor(task.parentId, acc) : null;
      // Also check if the direct parent is an epic
      const directParent = task.parentId ? await acc.loadSingleTask(task.parentId) : null;
      const epicToCheck = directParent?.type === 'epic' ? directParent : epicAncestor;
      if (epicToCheck) {
        await validateChildStageCeiling(
          { childStage: options.pipelineStage, epicId: epicToCheck.id },
          acc,
          cwd,
        );
      }
    }

    task.pipelineStage = options.pipelineStage;
    changes.push('pipelineStage');
  }

  // Handle parentId change (reparent) using targeted queries
  // Supports: parentId="T001" to set parent, parentId=null or parentId="" to promote to root
  if (options.parentId !== undefined) {
    const newParentId = options.parentId || null; // normalize "" to null
    const currentParentId = task.parentId ?? null;

    if (newParentId !== currentParentId) {
      const originalType = task.type;

      if (!newParentId) {
        // Promote to root
        task.parentId = null;
        if (task.type === 'subtask') task.type = 'task';
        changes.push('parentId');
        if (task.type !== originalType) changes.push('type');
      } else {
        // Validate target parent exists
        const newParent = await acc.loadSingleTask(newParentId);
        if (!newParent) {
          throw new CleoError(ExitCode.PARENT_NOT_FOUND, `Parent task ${newParentId} not found`, {
            fix: `Use 'cleo find "${newParentId}"' to search or remove --parent flag`,
            details: { field: 'parentId', actual: newParentId },
          });
        }
        const newParentType = newParent.type ?? 'task';
        const updatedType = childTypeForParentType(newParentType, task.type);
        if (!isAllowedWorkGraphParentType(updatedType, newParentType)) {
          throw new CleoError(
            ExitCode.INVALID_PARENT_TYPE,
            `Invalid parent type for ${updatedType}: parent ${newParentId} has type '${newParentType}'.`,
            {
              fix: 'Use Saga→Epic, Epic→Task, and Task→Subtask containment.',
              details: {
                field: 'parentId',
                expected: 'saga->epic | epic->task | task->subtask',
                actual: { parentType: newParentType, childType: updatedType },
              },
            },
          );
        }

        // Circular reference check: ensure newParentId is not a descendant of taskId
        const subtree = await acc.getSubtree(options.taskId);
        if (subtree.some((t) => t.id === newParentId)) {
          throw new CleoError(
            ExitCode.CIRCULAR_REFERENCE,
            `Moving '${options.taskId}' under '${newParentId}' would create a circular reference`,
            {
              fix: `Choose a parent that is not a descendant of ${options.taskId}`,
              details: { field: 'parentId', actual: newParentId },
            },
          );
        }

        // Depth check
        const ancestors = await acc.getAncestorChain(newParentId);
        const parentDepth = ancestors.length;
        const config = await loadConfig(cwd);
        const policy = resolveHierarchyPolicy(config);
        if (exceedsMaxDepth(parentDepth, policy.maxDepth)) {
          throw new CleoError(
            ExitCode.DEPTH_EXCEEDED,
            `Maximum nesting depth ${policy.maxDepth} would be exceeded`,
            {
              fix: 'Choose a parent at a shallower level in the hierarchy',
              details: {
                field: 'parentId',
                expected: `depth < ${policy.maxDepth}`,
                actual: parentDepth + 1,
              },
            },
          );
        }

        // Apply reparent
        task.parentId = newParentId;
        task.type = updatedType;

        changes.push('parentId');
        if (task.type !== originalType) changes.push('type');
      }
    }
  }

  if (changes.length === 0) {
    throw new CleoError(ExitCode.NO_CHANGE, 'No changes specified', {
      fix: `Provide at least one field to update (e.g. cleo update ${options.taskId} --status active)`,
      details: { field: 'options' },
    });
  }

  task.updatedAt = now;

  const isRelatesChange = changes.includes('relates');
  const isAcceptanceChange = changes.includes('acceptance');
  const isReparent = changes.includes('parentId');

  // The row actually persisted: the staged update rebased onto the row read
  // inside the write transaction (T12503).
  let written: Task = task;

  // T12693 (D11161): who is changing ranking inputs — resolved before the
  // write transaction, recorded inside it.
  const rankingActor = await resolveRankingActor(cwd);
  let rankingRecorded = false;

  // Wrap writes in a transaction for TOCTOU safety (T023)
  await acc.transaction(async (tx) => {
    // T12503 — optimistic concurrency. BEGIN IMMEDIATE holds the write lock
    // from here to COMMIT, so this read is the row no other process can
    // change before our write. Reject a stale expected version, then rebase
    // the staged update onto it so set operations never lose a concurrent
    // writer's additions and untouched fields keep their current values.
    const current = await acc.loadSingleTask(options.taskId);
    if (!current) {
      throw new CleoError(ExitCode.NOT_FOUND, `Task not found: ${options.taskId}`, {
        fix: `Use 'cleo find "${options.taskId}"' to search`,
      });
    }
    assertTaskVersion(options.taskId, current, options.expectedUpdatedAt, baseline);
    written = rebaseTaskUpdate(current, task, changes, options, timestampedNote);
    written.updatedAt = nextTaskVersion(current, now);
    // The waiver rule applies to the dependency set actually persisted.
    validateDependencyWaiver(options.priority, options.dependsWaiver, written.depends ?? []);

    const severityAttestation =
      options.severity === undefined || options.severity === null
        ? undefined
        : await prepareSignedSeverityAttestation(
            {
              timestamp: now,
              title: written.title,
              severity: options.severity,
              taskId: written.id,
              ...(written.parentId ? { epic: written.parentId } : {}),
            },
            { cwd },
          );

    await tx.upsertSingleTask(written);

    // T12693 (D11161): a ranking-input change is audited in the same write.
    const rankingEntry = rankingAuditEntry({
      taskId: options.taskId,
      before: rankingSnapshot(current),
      after: rankingSnapshot(written),
      actor: rankingActor,
      reason: options.reason,
      source: options.rankingSource ?? 'update',
    });
    if (rankingEntry) {
      await tx.appendLog(rankingEntry);
      rankingRecorded = true;
    }

    // T9514: persist relates mutations to task_relations table.
    // The in-memory task.relates update is not enough — upsertSingleTask
    // only writes the tasks row and task_dependencies; task_relations is a
    // separate table that must be written explicitly.
    if (isRelatesChange) {
      if (options.relates !== undefined) {
        // Set-replace: clear existing rows then insert the new set.
        await tx.clearRelations(options.taskId);
        for (const r of written.relates ?? []) {
          await tx.addRelation(options.taskId, r.taskId, r.type, r.reason);
        }
      } else {
        if (options.addRelates?.length) {
          for (const r of options.addRelates) {
            await tx.addRelation(options.taskId, r.taskId, r.type, r.reason);
          }
        }
        if (options.removeRelates?.length) {
          for (const id of options.removeRelates) {
            await tx.removeRelation(options.taskId, id.trim());
          }
        }
      }
    }

    // T10508 — DUAL WRITE for `--acceptance`: the legacy
    // `tasks.acceptance` JSON column was just upserted by
    // upsertSingleTask above. We now plan the row-table SSoT mutations
    // INSIDE the same transaction so a failure rolls both halves back.
    // History rows are recorded BEFORE the delete, satisfying the
    // shrink/replace-all ordering guarantee.
    if (isAcceptanceChange && options.acceptance !== undefined) {
      const existing = await tx.getAcRows(options.taskId);
      const plan = planAcUpdate(options.taskId, existing, options.acceptance);
      await applyAcPlan(tx, options.taskId, plan);
    }

    if (isReparent) {
      const parentIds = [originalParentId, written.parentId ?? null].filter(
        (parentId): parentId is string => parentId !== null,
      );
      const uniqueParentIds = [...new Set(parentIds)];
      const projectionAudits: Awaited<ReturnType<typeof rebuildChildProjectionAc>>[] = [];
      for (const parentId of uniqueParentIds) {
        const children = await tx.getChildren(parentId);
        const audit = await rebuildChildProjectionAc(
          tx,
          parentId,
          children.map((child) => ({ id: child.id, title: child.title })),
          now,
        );
        projectionAudits.push(audit);
      }

      await tx.appendLog({
        id: `log-${Math.floor(Date.now() / 1000)}-${(await import('node:crypto')).randomBytes(3).toString('hex')}`,
        timestamp: new Date().toISOString(),
        action: 'ac_projection_rebuilt',
        taskId: options.taskId,
        actor: 'system',
        details: {
          reason: 'reparent',
          oldParentId: originalParentId,
          newParentId: written.parentId ?? null,
          audits: projectionAudits,
        },
        before: null,
        after: { parentIds: uniqueParentIds },
      });
    }

    if (lifecycleEvent) {
      await tx.appendLog({
        id: `log-${Math.floor(Date.now() / 1000)}-${(await import('node:crypto')).randomBytes(3).toString('hex')}`,
        timestamp: new Date().toISOString(),
        action: lifecycleEvent,
        taskId: options.taskId,
        actor: 'system',
        details: { title: written.title, changes },
        before: { status: lifecycleBeforeStatus },
        after: { status: lifecycleAfterStatus },
      });
    }

    await tx.appendLog({
      id: `log-${Math.floor(Date.now() / 1000)}-${(await import('node:crypto')).randomBytes(3).toString('hex')}`,
      timestamp: new Date().toISOString(),
      action: 'task_updated',
      taskId: options.taskId,
      actor: 'system',
      details: {
        changes,
        title: written.title,
        ...(severityAttestation
          ? { severityAttestation: { ...severityAttestation, status: 'committed' } }
          : {}),
        ...(options.reason !== undefined ? { reason: options.reason } : {}),
        ...(acceptanceAuthorization
          ? { acceptanceOverride: { ...acceptanceAuthorization, status: 'committed' } }
          : {}),
        ...(options.dependsWaiver !== undefined ? { dependsWaiver: options.dependsWaiver } : {}),
      },
      before: null,
      after: { changes, title: written.title },
    });
  });

  // T12693: agents are asked for the why of a ranking change.
  if (rankingRecorded && rankingActor.actor !== 'human' && !options.reason?.trim()) {
    pushWarning({
      code: 'W_RANKING_REASON_MISSING',
      message: `Ranking inputs of ${options.taskId} changed without a reason; pass --reason "<why>" so the audit trail says why (cleo history ranking ${options.taskId}).`,
    });
  }

  return { task: written, changes };
}

// ---------------------------------------------------------------------------
// EngineResult-returning wrapper (T1568 / ADR-057 / ADR-058)
// ---------------------------------------------------------------------------

/**
 * Map the canonical task-update wire contract to the core update options.
 *
 * Forward all declared fields so operation and engine wrappers cannot silently
 * discard accepted inputs. Only the parent alias and existing enum boundaries
 * require translation; domain validation remains in {@link updateTask}.
 *
 * @param params - Canonical operation input, including the task identity.
 * @returns Core update options with parent mapped to parentId.
 * @remarks Entry points share this boundary; CLI parsing does not establish authorization.
 * @example
 * ```ts
 * toTaskUpdateOptions({ taskId: 'T001', severity: 'P1' });
 * ```
 */
export function toTaskUpdateOptions(params: TasksUpdateQueryParams): UpdateTaskOptions {
  const { parent, ...fields } = params;
  return {
    ...fields,
    parentId: parent,
    status: params.status as TaskStatus | undefined,
    priority: params.priority as TaskPriority | undefined,
    size: params.size as TaskSize | undefined,
    kind: params.kind as TaskKind | undefined,
    scope: params.scope as TaskScope | undefined,
    severity: params.severity as TaskSeverity | undefined,
  };
}

/**
 * Update a task's fields, wrapped in EngineResult.
 *
 * @param projectRoot - Absolute path to the project root
 * @param taskId - Task identifier to update
 * @param updates - Fields to update (only provided fields are changed)
 * @returns EngineResult with the updated task record and list of changes
 *
 * @task T1568
 * @epic T1566
 */
export async function taskUpdate(
  projectRoot: string,
  taskId: string,
  updates: Omit<TasksUpdateQueryParams, 'taskId'>,
): Promise<EngineResult<{ task: TaskRecord; changes?: string[] }>> {
  try {
    const accessor = await getTaskAccessor(projectRoot);
    const result = await updateTask(
      toTaskUpdateOptions({ ...updates, taskId }),
      projectRoot,
      accessor,
    );
    return engineSuccess({ task: taskToRecord(result.task), changes: result.changes });
  } catch (err: unknown) {
    // T9940 (generalizing T9838-D): surface real CleoError LAFS codes via
    // the shared `cleoErrorToEngineResult` helper. Non-CleoErrors (DB
    // invariant triggers raised as plain Error, unexpected runtime issues)
    // fall through to `E_INTERNAL`, never the misleading
    // `E_NOT_INITIALIZED` blanket label that the wrapper used before T9838-D.
    return cleoErrorToEngineResult(err, 'E_INTERNAL', 'Failed to update task');
  }
}
