/**
 * `cleo doctor type-matrix`: repair the parent/child pairs that break the
 * type matrix (`PARENT_TYPE_MATRIX`: saga→epic, epic→task, task→subtask).
 *
 * The writers refuse new violations (T12883 R4); this repairs the rows written
 * before they did (T14096). A dry run by default:
 *
 * - {@link planTypeMatrixRepair} lists every parented violation with the
 *   operations that would fix it. A pair with exactly one valid operation (a
 *   leaf `subtask` under an epic becomes a `task`; a leaf `task` under a task
 *   becomes a `subtask`) carries it as its `proposal`. A pair with none or
 *   several is ambiguous: its `options` are listed and nothing is applied
 *   until the calling agent names one in a resolution.
 * - {@link applyTypeMatrixRepair} applies the proposals plus the agent's
 *   resolutions through the task accessor, in one transaction, guarded on each
 *   row being unchanged since it was read, and writes one receipt (before and
 *   after image of every touched row) to the task audit log.
 * - {@link rollbackTypeMatrixRepair} restores the before image, refused when a
 *   row changed after the repair. A row whose before image the type-matrix
 *   trigger now forbids (a legacy task under a task, say) is not restored; the
 *   result names it and why (owner decision, T14096).
 *
 * The contracts matrix is the authority (owner decision, T14096): a subtask
 * belongs under a task, even though the trigger still accepts one under an
 * epic until T14131 tightens it.
 *
 * A violation at the root (a parentless task) is outside this repair.
 *
 * @module
 * @task T14096
 */

import { randomUUID } from 'node:crypto';
import type { DataAccessor, Task, TaskType } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import {
  canWorkGraphTaskTypeBeRoot,
  isAllowedWorkGraphParentType,
} from '@cleocode/contracts/workgraph.js';
import { CleoError } from '../errors.js';
import { getTaskAccessor } from '../store/data-accessor.js';

/** Audit-log action of an applied repair (its row id is the receipt id). */
export const TYPE_MATRIX_REPAIR_ACTION = 'doctor.type-matrix.repair';
/** Audit-log action of a rollback. */
export const TYPE_MATRIX_ROLLBACK_ACTION = 'doctor.type-matrix.rollback';

const TASK_TYPES: readonly TaskType[] = ['saga', 'epic', 'task', 'subtask'];

/** One repair operation: re-type a task, or move it under another parent. */
export type TypeMatrixRepairOp =
  | { readonly kind: 'retype'; readonly taskId: string; readonly to: TaskType }
  | { readonly kind: 'reparent'; readonly taskId: string; readonly toParentId: string };

/** A parent/child pair that breaks the matrix, and how it can be repaired. */
export interface TypeMatrixViolationPlan {
  readonly taskId: string;
  readonly taskType: TaskType;
  readonly parentId: string;
  readonly parentType: TaskType;
  /** The one valid operation, or null when the pair is ambiguous. */
  readonly proposal: TypeMatrixRepairOp | null;
  /** Every valid re-type of the child or the parent (reparenting is the agent's to name). */
  readonly options: readonly TypeMatrixRepairOp[];
}

/** One touched row: its type and parent before and after, and the row version after. */
export interface TypeMatrixRowImage {
  readonly id: string;
  readonly before: { readonly type: TaskType; readonly parentId: string | null };
  readonly after: { readonly type: TaskType; readonly parentId: string | null };
  /** `updatedAt` after the repair: the rollback guard. */
  readonly updatedAt: string | null;
}

/** What `cleo doctor type-matrix` reports. */
export interface TypeMatrixRepairReport {
  readonly dryRun: boolean;
  /** Parented violations found. */
  readonly violations: number;
  /** Count per `parent → child` type pair. */
  readonly byPair: Readonly<Record<string, number>>;
  /** Every violation with its proposal or options. */
  readonly plans: readonly TypeMatrixViolationPlan[];
  /** The operations applied (or, in a dry run, that would be). */
  readonly operations: readonly TypeMatrixRepairOp[];
  /** Violations no operation covers: ambiguous pairs without a resolution. */
  readonly unresolved: readonly string[];
  /** The receipt of an applied repair. */
  readonly receiptId?: string;
  /** The command that undoes it. */
  readonly rollback?: string;
  /** Touched rows of an applied repair. */
  readonly rows?: readonly TypeMatrixRowImage[];
}

/** A node of the in-memory hierarchy the plan and the validation work on. */
interface Node {
  type: TaskType;
  parentId: string | null;
  /** The type as stored: a root keeps it even when it may not be a root (out of scope). */
  readonly storedType: TaskType;
}

/**
 * Whether `id` sits where the matrix allows, given the model. A root is out
 * of this repair's scope: it passes while it keeps its stored type, and may
 * only be re-typed to a type that can be a root.
 */
function placed(id: string, model: ReadonlyMap<string, Node>): boolean {
  const node = model.get(id);
  if (node === undefined) return true;
  if (node.parentId === null) {
    return node.type === node.storedType || canWorkGraphTaskTypeBeRoot(node.type);
  }
  const parent = model.get(node.parentId);
  return parent !== undefined && isAllowedWorkGraphParentType(node.type, parent.type);
}

function applyOp(model: Map<string, Node>, op: TypeMatrixRepairOp): void {
  const node = model.get(op.taskId);
  if (node === undefined) return;
  model.set(
    op.taskId,
    op.kind === 'retype' ? { ...node, type: op.to } : { ...node, parentId: op.toParentId },
  );
}

/**
 * Every re-type of `id` that places `violating` (the child of the pair) and
 * `id` itself, and breaks no pair that was valid.
 */
function retypeOptions(
  id: string,
  violating: string,
  model: ReadonlyMap<string, Node>,
  children: ReadonlyMap<string, readonly string[]>,
): TypeMatrixRepairOp[] {
  const node = model.get(id);
  if (node === undefined) return [];
  return TASK_TYPES.filter((to) => to !== node.type).flatMap((to) => {
    const trial = new Map(model);
    trial.set(id, { ...node, type: to });
    const ok =
      placed(violating, trial) &&
      placed(id, trial) &&
      newlyBroken(id, model, trial, children).length === 0;
    return ok ? [{ kind: 'retype' as const, taskId: id, to }] : [];
  });
}

function childIndex(model: ReadonlyMap<string, Node>): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const [id, node] of model) {
    if (node.parentId === null) continue;
    const list = index.get(node.parentId) ?? [];
    list.push(id);
    index.set(node.parentId, list);
  }
  return index;
}

function modelOf(tasks: readonly Task[]): Map<string, Node> {
  return new Map(
    tasks.map((t) => {
      const type: TaskType = t.type ?? 'task';
      return [t.id, { type, parentId: t.parentId ?? null, storedType: type }];
    }),
  );
}

function planFor(tasks: readonly Task[]): {
  model: Map<string, Node>;
  children: Map<string, string[]>;
  plans: TypeMatrixViolationPlan[];
} {
  const model = modelOf(tasks);
  const children = childIndex(model);
  const plans: TypeMatrixViolationPlan[] = [];
  for (const [id, node] of model) {
    if (node.parentId === null || placed(id, model)) continue;
    const parent = model.get(node.parentId);
    if (parent === undefined) continue; // a dangling parent is the FK check's, not this one's
    const options = [
      ...retypeOptions(id, id, model, children),
      ...retypeOptions(node.parentId, id, model, children),
    ];
    plans.push({
      taskId: id,
      taskType: node.type,
      parentId: node.parentId,
      parentType: parent.type,
      proposal: options.length === 1 ? (options[0] ?? null) : null,
      options,
    });
  }
  plans.sort((a, b) => a.taskId.localeCompare(b.taskId));
  return { model, children, plans };
}

function isTaskType(value: unknown): value is TaskType {
  return typeof value === 'string' && (TASK_TYPES as readonly string[]).includes(value);
}

/**
 * Parse a `--resolutions` file: a JSON array of `retype` and `reparent`
 * operations.
 *
 * @param text - The file's contents.
 * @returns The operations, or why the file was refused.
 * @example
 * ```ts
 * parseTypeMatrixResolutions('[{"kind":"retype","taskId":"T1","to":"epic"}]');
 * ```
 */
export function parseTypeMatrixResolutions(
  text: string,
): { ok: true; operations: TypeMatrixRepairOp[] } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: `not JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  if (!Array.isArray(parsed)) return { ok: false, reason: 'expected a JSON array of operations' };
  const operations: TypeMatrixRepairOp[] = [];
  for (const [i, entry] of parsed.entries()) {
    const op =
      typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
    const taskId = op['taskId'];
    if (typeof taskId !== 'string' || taskId === '') {
      return { ok: false, reason: `operation ${i} has no taskId` };
    }
    if (op['kind'] === 'retype' && isTaskType(op['to'])) {
      operations.push({ kind: 'retype', taskId, to: op['to'] });
    } else if (op['kind'] === 'reparent' && typeof op['toParentId'] === 'string') {
      operations.push({ kind: 'reparent', taskId, toParentId: op['toParentId'] });
    } else {
      return {
        ok: false,
        reason: `operation ${i} must be {"kind":"retype","to":<saga|epic|task|subtask>} or {"kind":"reparent","toParentId":<id>}`,
      };
    }
  }
  return { ok: true, operations };
}

function refuse(message: string, fix?: string): CleoError {
  // @sync-invariant none:input-shape a refused --resolutions file is rejected before anything is written
  return new CleoError(ExitCode.VALIDATION_ERROR, message, {
    ...(fix ? { fix } : {}),
    details: { field: 'resolutions' },
  });
}

/**
 * Rows an operation on `id` newly breaks: `id` against its parent and each
 * child of `id` against it, placed before and not after. A pair that was
 * already a violation is not counted (it is another plan's to fix).
 */
function newlyBroken(
  id: string,
  before: ReadonlyMap<string, Node>,
  after: ReadonlyMap<string, Node>,
  children: ReadonlyMap<string, readonly string[]> = childIndex(after),
): string[] {
  const candidates = [id, ...(children.get(id) ?? [])];
  return candidates.filter((c) => placed(c, before) && !placed(c, after));
}

/**
 * Decide the operations a repair applies. The agent's resolutions come first
 * and must each leave their task validly placed and break no pair that was
 * valid (refused otherwise, before anything is written). Then each proposal,
 * on top of what is already chosen: one whose pair is already fixed, or that
 * would now break a valid pair, is skipped and its violation stays unresolved.
 */
function decideOperations(
  plans: readonly TypeMatrixViolationPlan[],
  model: ReadonlyMap<string, Node>,
  resolutions: readonly TypeMatrixRepairOp[],
): { operations: TypeMatrixRepairOp[]; unresolved: string[] } {
  const operations: TypeMatrixRepairOp[] = [];
  const seen = new Set<string>();
  let after = new Map(model);
  for (const op of resolutions) {
    if (!model.has(op.taskId)) {
      // @sync-invariant none:input-shape a resolution naming an unknown task is refused before anything is written
      throw refuse(`Resolution names ${op.taskId}, which is not a task in this store.`);
    }
    if (op.kind === 'reparent' && !model.has(op.toParentId)) {
      // @sync-invariant none:input-shape a resolution naming an unknown parent is refused before anything is written
      throw refuse(`Resolution moves ${op.taskId} under ${op.toParentId}, which is not a task.`);
    }
    if (seen.has(op.taskId)) {
      // @sync-invariant none:input-shape two resolutions for one task are refused before anything is written
      throw refuse(`Two resolutions name ${op.taskId}; give one per task.`);
    }
    const trial = new Map(after);
    applyOp(trial, op);
    const broken = newlyBroken(op.taskId, after, trial);
    if (!placed(op.taskId, trial) || broken.length > 0) {
      // @sync-invariant task.parent.type-matrix a resolution that leaves the matrix broken is refused before anything is written
      throw refuse(
        `The resolution for ${op.taskId} would leave ${[op.taskId, ...broken].join(', ')} where the type matrix (saga→epic, epic→task, task→subtask) does not allow it.`,
        'Run cleo doctor type-matrix for the options, and resolve each ambiguous pair with one of them.',
      );
    }
    seen.add(op.taskId);
    operations.push(op);
    after = trial;
  }
  for (const plan of plans) {
    const proposal = plan.proposal;
    if (proposal === null || seen.has(proposal.taskId) || placed(plan.taskId, after)) continue;
    const trial = new Map(after);
    applyOp(trial, proposal);
    if (!placed(plan.taskId, trial) || newlyBroken(proposal.taskId, after, trial).length > 0) {
      continue;
    }
    seen.add(proposal.taskId);
    operations.push(proposal);
    after = trial;
  }
  const unresolved = plans.filter((p) => !placed(p.taskId, after)).map((p) => p.taskId);
  return { operations, unresolved };
}

function byPair(plans: readonly TypeMatrixViolationPlan[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of plans) {
    const k = `${p.parentType} → ${p.taskType}`;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

/**
 * Plan the repair of the store's type-matrix violations without writing.
 *
 * @param projectRoot - Project root.
 * @param resolutions - Operations the calling agent chose for ambiguous pairs.
 * @returns Every violation, its options, and the operations an apply would run.
 * @example
 * ```ts
 * const plan = await planTypeMatrixRepair(root);
 * console.log(plan.byPair, plan.unresolved.length);
 * ```
 */
export async function planTypeMatrixRepair(
  projectRoot: string,
  resolutions: readonly TypeMatrixRepairOp[] = [],
): Promise<TypeMatrixRepairReport> {
  const accessor = await getTaskAccessor(projectRoot);
  const { tasks } = await accessor.queryTasks({});
  const { model, plans } = planFor(tasks);
  const { operations, unresolved } = decideOperations(plans, model, resolutions);
  return {
    dryRun: true,
    violations: plans.length,
    byPair: byPair(plans),
    plans,
    operations,
    unresolved,
  };
}

/**
 * Apply the proposals and the agent's resolutions in one transaction, and
 * record the receipt. Each row is written only if it is unchanged since it was
 * read (`E_CONFLICT` otherwise, and nothing is written).
 *
 * @param projectRoot - Project root.
 * @param resolutions - Operations the calling agent chose for ambiguous pairs.
 * @returns The report with the receipt id and the rollback command.
 * @example
 * ```ts
 * const done = await applyTypeMatrixRepair(root, [{ kind: 'retype', taskId: 'T9', to: 'saga' }]);
 * console.log(done.rollback);
 * ```
 */
export async function applyTypeMatrixRepair(
  projectRoot: string,
  resolutions: readonly TypeMatrixRepairOp[] = [],
): Promise<TypeMatrixRepairReport> {
  const accessor = await getTaskAccessor(projectRoot);
  const { tasks } = await accessor.queryTasks({});
  const { model, plans } = planFor(tasks);
  const { operations, unresolved } = decideOperations(plans, model, resolutions);
  const report = {
    dryRun: false,
    violations: plans.length,
    byPair: byPair(plans),
    plans,
    operations,
    unresolved,
  };
  if (operations.length === 0) return report;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const receiptId = `type-matrix-${randomUUID()}`;
  const rows = await accessor.transaction(async (tx) => {
    const images: TypeMatrixRowImage[] = [];
    for (const op of operations) {
      const task = byId.get(op.taskId);
      const before = model.get(op.taskId);
      if (task === undefined || before === undefined) continue;
      const fields = op.kind === 'retype' ? { type: op.to } : { parentId: op.toParentId };
      const version = task.updatedAt ?? task.createdAt;
      await tx.updateTaskFields(op.taskId, fields, { expectedUpdatedAt: version });
      const was = { type: before.type, parentId: before.parentId };
      const after =
        op.kind === 'retype' ? { ...was, type: op.to } : { ...was, parentId: op.toParentId };
      images.push({ id: op.taskId, before: was, after, updatedAt: null });
    }
    await tx.appendLog({
      id: receiptId,
      action: TYPE_MATRIX_REPAIR_ACTION,
      taskId: images[0]?.id ?? 'doctor',
      actor: 'cleo doctor type-matrix',
      details: { operations, unresolved },
      before: images.map((r) => ({ id: r.id, ...r.before })),
      after: images.map((r) => ({ id: r.id, ...r.after })),
    });
    return images;
  });
  const written = await accessor.loadTasks(rows.map((r) => r.id));
  const versions = new Map(written.map((t) => [t.id, t.updatedAt ?? null]));
  return {
    ...report,
    receiptId,
    rollback: `cleo doctor type-matrix --rollback ${receiptId}`,
    rows: rows.map((r) => ({ ...r, updatedAt: versions.get(r.id) ?? null })),
  };
}

/** What a rollback restored. */
export interface TypeMatrixRollbackResult {
  /** The repair receipt rolled back. */
  readonly receiptId: string;
  /** The rollback's own audit row. */
  readonly rollbackReceiptId: string;
  /** Rows restored to their before image. */
  readonly restored: readonly string[];
  /** Rows left as the repair set them: the type-matrix trigger forbids their before image. */
  readonly refused: readonly { readonly id: string; readonly reason: string }[];
}

/**
 * The parents the `tasks_tasks_parent_type_matrix_*` triggers accept, per child
 * type. Looser than `PARENT_TYPE_MATRIX` for a subtask (T14131 tightens it).
 */
const TRIGGER_PARENTS: Readonly<Record<TaskType, readonly TaskType[]>> = {
  saga: [],
  epic: ['saga'],
  task: ['epic'],
  subtask: ['epic', 'task'],
};

/**
 * Split a receipt's before image into the rows the trigger lets a rollback
 * restore, in an order that restores a parent before its child, and the rows
 * it refuses with the reason (owner decision, T14096 Q2). Legacy states the
 * trigger now forbids stay as the repair left them.
 */
function restorable(
  before: readonly ImageRow[],
  typeOf: ReadonlyMap<string, TaskType>,
): { restore: ImageRow[]; refused: { id: string; reason: string }[] } {
  const pending = new Map(before.map((r) => [r.id, r]));
  const refused: { id: string; reason: string }[] = [];
  const finalType = (id: string): TaskType | undefined => pending.get(id)?.type ?? typeOf.get(id);
  let dropped = true;
  while (dropped) {
    dropped = false;
    for (const row of pending.values()) {
      if (row.parentId === null) continue;
      const parentType = finalType(row.parentId);
      if (parentType === undefined || TRIGGER_PARENTS[row.type].includes(parentType)) continue;
      pending.delete(row.id);
      refused.push({
        id: row.id,
        reason: `restoring ${row.id} as a ${row.type} under ${row.parentId} (a ${parentType}) is refused by the type-matrix trigger; the repair's value stays`,
      });
      dropped = true;
    }
  }
  const restore: ImageRow[] = [];
  const placedIds = new Set<string>();
  while (restore.length < pending.size) {
    for (const row of pending.values()) {
      if (placedIds.has(row.id)) continue;
      const parentPending =
        row.parentId !== null && pending.has(row.parentId) && !placedIds.has(row.parentId);
      if (parentPending) continue;
      restore.push(row);
      placedIds.add(row.id);
    }
  }
  return { restore, refused };
}

interface ImageRow {
  id: string;
  type: TaskType;
  parentId: string | null;
}

function parseImages(json: string | null): ImageRow[] {
  if (json === null) return [];
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (r): r is ImageRow =>
      typeof r === 'object' &&
      r !== null &&
      typeof (r as { id?: unknown }).id === 'string' &&
      typeof (r as { type?: unknown }).type === 'string',
  );
}

/**
 * Restore the rows a repair changed to their before image. Refused when the
 * receipt is unknown or already rolled back, or when any row no longer
 * matches the repair's after image (a later edit is never overwritten). Only
 * the rows the type-matrix trigger allows are restored; the rest are listed
 * in `refused` with the reason, and refused outright when none can be.
 *
 * @param projectRoot - Project root.
 * @param receiptId - `receiptId` of {@link applyTypeMatrixRepair}.
 * @returns The restored rows and the rollback's audit row id.
 * @example
 * ```ts
 * await rollbackTypeMatrixRepair(root, done.receiptId!);
 * ```
 */
export async function rollbackTypeMatrixRepair(
  projectRoot: string,
  receiptId: string,
): Promise<TypeMatrixRollbackResult> {
  const accessor: DataAccessor = await getTaskAccessor(projectRoot);
  const [receipt] = await accessor.queryAuditLog({
    ids: [receiptId],
    actions: [TYPE_MATRIX_REPAIR_ACTION],
    limit: 1,
  });
  if (receipt === undefined) {
    // @sync-invariant none:input-shape an unknown receipt id is refused before anything is written
    throw new CleoError(ExitCode.NOT_FOUND, `No type-matrix repair has receipt ${receiptId}.`, {
      details: { field: 'receiptId' },
    });
  }
  const earlier = await accessor.queryAuditLog({
    actions: [TYPE_MATRIX_ROLLBACK_ACTION],
    since: receipt.timestamp,
    limit: 1000,
  });
  if (earlier.some((row) => row.detailsJson?.includes(`"${receiptId}"`))) {
    // @sync-invariant none:input-shape a receipt already rolled back is refused before anything is written
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Receipt ${receiptId} was already rolled back.`,
      {
        details: { field: 'receiptId' },
      },
    );
  }
  const before = parseImages(receipt.beforeJson);
  const after = new Map(parseImages(receipt.afterJson).map((r) => [r.id, r]));
  const current = new Map(
    (await accessor.loadTasks(before.map((r) => r.id))).map((t) => [t.id, t]),
  );
  const changed = before.filter((r) => {
    const now = current.get(r.id);
    const then = after.get(r.id);
    return (
      now === undefined ||
      then === undefined ||
      (now.type ?? 'task') !== then.type ||
      (now.parentId ?? null) !== then.parentId
    );
  });
  if (changed.length > 0) {
    // @sync-invariant none:local-only a rollback never overwrites a row edited after the repair
    throw new CleoError(
      ExitCode.VERSION_CONFLICT,
      `Rows of receipt ${receiptId} changed after the repair (${changed.map((r) => r.id).join(', ')}); rolling back would overwrite that change.`,
      { details: { field: 'receiptId', changed: changed.map((r) => r.id) } },
    );
  }
  const parentIds = before.flatMap((r) => (r.parentId === null ? [] : [r.parentId]));
  const known = [...current.values(), ...(await accessor.loadTasks(parentIds))];
  const typeOf = new Map(known.map((t): [string, TaskType] => [t.id, t.type ?? 'task']));
  const { restore, refused } = restorable(before, typeOf);
  if (restore.length === 0) {
    // @sync-invariant task.parent.type-matrix a rollback never restores a parent/child pair the trigger forbids
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Nothing in receipt ${receiptId} can be rolled back: ${refused.map((r) => r.reason).join('; ')}.`,
      { details: { field: 'receiptId', refused } },
    );
  }
  const rollbackReceiptId = `type-matrix-rollback-${randomUUID()}`;
  await accessor.transaction(async (tx) => {
    // Parents first, so the trigger checks each child against its restored parent.
    for (const row of restore) {
      const now = current.get(row.id);
      if (now === undefined) continue;
      await tx.updateTaskFields(
        row.id,
        { type: row.type, parentId: row.parentId },
        { expectedUpdatedAt: now.updatedAt ?? now.createdAt },
      );
    }
    await tx.appendLog({
      id: rollbackReceiptId,
      action: TYPE_MATRIX_ROLLBACK_ACTION,
      taskId: before[0]?.id ?? 'doctor',
      actor: 'cleo doctor type-matrix',
      details: { rolledBack: receiptId, refused },
      before: restore.map((r) => after.get(r.id) ?? r),
      after: restore,
    });
  });
  return { receiptId, rollbackReceiptId, restored: restore.map((r) => r.id), refused };
}
