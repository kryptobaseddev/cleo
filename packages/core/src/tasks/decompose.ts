/**
 * Task decomposition — turn a leaf task defined by its own free-text acceptance
 * criteria into a container defined by its children.
 *
 * PM-Core V2 design-point 3 requires a `task` to be EITHER a leaf with text ACs
 * OR a container with children, never both, and `addTask` enforces that by
 * refusing the first child of a text-AC-bearing task. The rule is right; what
 * was missing was a sanctioned way to cross it. Agents met the guard precisely
 * when they did the correct thing — decompose a task they had just been told to
 * break down — and its three suggested remedies were all manual multi-step
 * surgery, one of which (`cleo update <id> --acceptance ""`) the acceptance
 * enforcement layer rejects outright whenever `enforcement.acceptance.mode` is
 * `block` and the task's priority is in `requiredForPriorities`, which is the
 * default. So the documented escape hatch did not work either.
 *
 * `decomposeTask` performs the move as one operation: the parent's text ACs are
 * lifted onto a new first child, leaving the parent a pure container.
 *
 * @task T12281
 */

import type { TaskType } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts';
import { type EngineResult, engineSuccess } from '../engine-result.js';
import { CleoError } from '../errors.js';
import { cleoErrorToEngineResult } from '../errors-to-engine.js';
import type { DataAccessor } from '../store/data-accessor.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { applyAcPlan, planAcUpdate } from './ac-table.js';
import { addTask } from './add.js';

/** Options for {@link decomposeTask}. */
export interface DecomposeTaskOptions {
  /** Task whose text acceptance criteria become a new child's. */
  taskId: string;
  /**
   * Title for the child that inherits the criteria.
   * Defaults to the parent's own title, which is almost always what the
   * criteria described.
   */
  childTitle?: string;
  /** Description for the child. Defaults to the parent's description. */
  childDescription?: string;
  /** Preview without writing. Mirrors `addTask`'s `dryRun`. */
  dryRun?: boolean;
}

/** Result of {@link decomposeTask}. */
export interface DecomposeTaskResult {
  /** The task that is now a pure container. */
  parentId: string;
  /** The created child, or `null` on a dry run. */
  childId: string | null;
  /** The criteria texts moved from parent to child, in ordinal order. */
  movedAcceptance: string[];
  /** True when nothing was written. */
  dryRun: boolean;
}

/**
 * Move a task's free-text acceptance criteria onto a new first child.
 *
 * Ordering is load-bearing and is the reason this is not two CLI calls:
 *
 * 1. **Preflight** the child through `addTask({ dryRun: true })`. That runs the
 *    real depth, containment, sibling and duplicate checks and writes nothing,
 *    so a placement that could never succeed is refused while the parent still
 *    holds its criteria.
 * 2. **Strip** the parent's text AC rows, via `planAcUpdate`/`applyAcPlan`
 *    inside a transaction rather than `updateTask` — the enforcement layer
 *    refuses an empty acceptance list, so the high-level path cannot express
 *    "this task is now a container".
 * 3. **Create** the child. The parent no longer has text ACs, so design-point 3
 *    is satisfied honestly rather than bypassed, and `addTask` writes the
 *    parent's `child_task` projection as it normally would.
 *
 * The strip MUST precede the create. Doing it the other way round means the
 * parent already carries a `child_task` projection row when the criteria are
 * cleared, and `planAcUpdate` with an empty incoming list takes the shrink path
 * and deletes every row — including that projection.
 *
 * If step 3 fails the parent's criteria are restored before the error
 * propagates, so a failed decompose is a no-op rather than silent criteria loss.
 *
 * @param options - Decomposition inputs; see {@link DecomposeTaskOptions}.
 * @param cwd - Project root. Defaults to the resolved CLEO project.
 * @param accessor - Optional pre-bound data accessor (tests, batch callers).
 * @returns The parent/child ids and the criteria that moved.
 * @throws {@link CleoError} `E_NOT_FOUND` when the task does not exist.
 * @throws {@link CleoError} `E_VALIDATION` when the task is not a decomposable
 *   leaf: wrong tier, no text criteria, already a container, or carrying
 *   non-text criteria this operation will not silently rewrite.
 *
 * @example
 * ```ts
 * // T473 is a task with three text ACs and no children.
 * const r = await decomposeTask({ taskId: 'T473' });
 * // r.childId now holds those three ACs; T473 holds one child_task projection.
 * ```
 */
export async function decomposeTask(
  options: DecomposeTaskOptions,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<DecomposeTaskResult> {
  const acc = accessor ?? (await getTaskAccessor(cwd));

  const parent = await acc.loadSingleTask(options.taskId);
  if (!parent) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task not found: ${options.taskId}`, {
      fix: `cleo find "${options.taskId}"`,
      details: { field: 'taskId', actual: options.taskId },
    });
  }

  const parentType: TaskType = parent.type ?? 'task';
  // Only a `task` can gain subtasks: `saga`/`epic` are containers already and
  // are exempt from design-point 3, and a `subtask` is a leaf by definition.
  if (parentType !== 'task') {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Cannot decompose ${options.taskId}: it is a ${parentType}. ` +
        `Only a task can be decomposed — sagas and epics are already containers ` +
        `(design-point 3 exempts them), and a subtask is a leaf tier that cannot have children.`,
      {
        fix:
          parentType === 'subtask'
            ? `Add work beside ${options.taskId} under its parent task instead`
            : `Use cleo add --parent ${options.taskId} directly — ${parentType}s may hold children`,
        details: { field: 'taskId', expected: 'task', actual: parentType },
      },
    );
  }

  const existingAc = await acc.getAcRows(options.taskId);
  const textRows = existingAc.filter((row) => row.kind === 'text');

  if (textRows.length === 0) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Cannot decompose ${options.taskId}: it has no free-text acceptance criteria to move. ` +
        `It is already a container — add children directly.`,
      {
        fix: `cleo add --type subtask --parent ${options.taskId} --title "..." --acceptance "..."`,
        details: { field: 'acceptance', expected: '>=1 text criterion', actual: 0 },
      },
    );
  }

  // Refuse rather than guess when the parent carries criteria this operation
  // cannot faithfully reconstruct. `planAcUpdate` takes AcceptanceItem[], and
  // rebuilding an evidence-bound gate or an existing child projection from its
  // stored row is lossy — so a task holding either is out of scope here instead
  // of being quietly rewritten into plain text.
  const nonTextRows = existingAc.filter((row) => row.kind !== 'text');
  if (nonTextRows.length > 0) {
    const kinds = [...new Set(nonTextRows.map((row) => row.kind))].join(', ');
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Cannot decompose ${options.taskId}: it carries ${nonTextRows.length} non-text ` +
        `acceptance row(s) (${kinds}) alongside its text criteria. Moving those would ` +
        `require rewriting gates or child projections, which this operation will not do silently.`,
      {
        fix: `Inspect with cleo show ${options.taskId} --full and move the work by hand`,
        details: { field: 'acceptance', expected: 'text criteria only', actual: kinds },
      },
    );
  }

  const movedAcceptance = [...textRows]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((row) => row.text);

  const childPayload = {
    title: options.childTitle ?? parent.title,
    description: options.childDescription ?? parent.description ?? '',
    parentId: options.taskId,
    type: 'subtask' as TaskType,
    acceptance: movedAcceptance,
  };

  // Step 1 — preflight. Writes nothing; surfaces depth/containment/sibling
  // failures while the parent still owns its criteria. `skipMixedAcParentGuard`
  // suppresses ONLY design-point 3, which this operation exists to resolve and
  // which step 2 satisfies for real before any child is written.
  const preview = await addTask(
    { ...childPayload, dryRun: true, skipMixedAcParentGuard: true },
    cwd,
    acc,
  );

  // `addTask` answers an exact-title match inside its 60s window by RETURNING
  // THE EXISTING TASK with `duplicate: true` — it does not throw and it does not
  // insert. Left unchecked that is silent data loss here: the criteria would be
  // stripped in step 2 and step 3 would "succeed" by handing back the parent
  // itself, leaving a task with no criteria and no child. It fires exactly when
  // decomposing a task created moments ago, which is the common case — an agent
  // filing a task and immediately breaking it down. Caught on the preflight, so
  // nothing has been written yet.
  if (preview.duplicate) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Cannot decompose ${options.taskId}: a task titled "${childPayload.title}" was created ` +
        `in the last 60 seconds, so the child would be absorbed by duplicate detection ` +
        `instead of inserted.`,
      {
        fix: `cleo decompose ${options.taskId} --child-title "<a distinct title for the first subtask>"`,
        details: {
          field: 'childTitle',
          actual: childPayload.title,
          duplicateOf: preview.task.id,
        },
      },
    );
  }

  if (options.dryRun) {
    return { parentId: options.taskId, childId: null, movedAcceptance, dryRun: true };
  }

  // Step 2 — strip the parent's text ACs.
  await acc.transaction(async (tx) => {
    const current = await tx.getAcRows(options.taskId);
    await applyAcPlan(tx, options.taskId, planAcUpdate(options.taskId, current, []));
    await tx.updateTaskFields(options.taskId, {
      acceptanceJson: JSON.stringify([]),
      updatedAt: new Date().toISOString(),
    });
  });

  /** Put the criteria back on the parent, so a failed decompose is a no-op. */
  const restoreParentAc = async (): Promise<void> => {
    await acc.transaction(async (tx) => {
      const current = await tx.getAcRows(options.taskId);
      await applyAcPlan(tx, options.taskId, planAcUpdate(options.taskId, current, movedAcceptance));
      await tx.updateTaskFields(options.taskId, {
        acceptanceJson: JSON.stringify(movedAcceptance),
        updatedAt: new Date().toISOString(),
      });
    });
  };

  // Step 3 — create the child that now owns them.
  let created: Awaited<ReturnType<typeof addTask>>;
  try {
    created = await addTask(childPayload, cwd, acc);
  } catch (err) {
    await restoreParentAc();
    throw err;
  }

  // Re-check the duplicate short-circuit even though the preflight cleared it:
  // the window is time-based, so a colliding task could have been created in
  // between. `addTask` signals this by returning a task it did not insert, so a
  // bare `created.task.id` would silently report the parent as its own child.
  if (created.duplicate || created.task.id === options.taskId) {
    await restoreParentAc();
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Cannot decompose ${options.taskId}: the child was absorbed by duplicate detection ` +
        `rather than inserted. The task's acceptance criteria have been restored unchanged.`,
      {
        fix: `cleo decompose ${options.taskId} --child-title "<a distinct title for the first subtask>"`,
        details: { field: 'childTitle', actual: childPayload.title },
      },
    );
  }

  return { parentId: options.taskId, childId: created.task.id, movedAcceptance, dryRun: false };
}

/**
 * Dispatch-layer wrapper for {@link decomposeTask}.
 *
 * Mirrors `taskDelete`/`taskArchive`: converts thrown {@link CleoError}s into an
 * {@link EngineResult} so the gateway can render a LAFS envelope, preserving the
 * original LAFS code rather than blanket-labelling every failure.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param options - Decomposition inputs; see {@link DecomposeTaskOptions}.
 * @returns Engine result carrying the parent/child ids and moved criteria.
 */
export async function taskDecompose(
  projectRoot: string,
  options: DecomposeTaskOptions,
): Promise<EngineResult<DecomposeTaskResult>> {
  try {
    const accessor = await getTaskAccessor(projectRoot);
    return engineSuccess(await decomposeTask(options, projectRoot, accessor));
  } catch (err: unknown) {
    return cleoErrorToEngineResult(err, 'E_INTERNAL', 'Failed to decompose task');
  }
}
