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
 *   row being unchanged since it was read (or since the reviewed plan read
 *   it), and writes one receipt (before and after image of every touched row,
 *   with the version it wrote and its children) to the task audit log. A
 *   reparent is held to the reparent core's checks (no cancelled or archived
 *   target, no cycle, depth and sibling limits) and reopens done ancestors.
 * - {@link rollbackTypeMatrixRepair} restores the before image, refused when a
 *   row changed after the repair (its version moved), and never for a row
 *   whose restore would break a child filed under it since. A row whose before image the type-matrix
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
import type { DataAccessor, Task, TaskFieldUpdates, TaskType } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import {
  canWorkGraphTaskTypeBeRoot,
  isAllowedWorkGraphParentType,
} from '@cleocode/contracts/workgraph.js';
import { CleoError } from '../errors.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { nextTaskVersion } from '../store/task-version.js';
import { assertParentNotIrreversiblyTerminal } from '../tasks/child-disposition.js';
import { getHierarchyLimits } from '../tasks/task-tree.js';

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
  /** `updatedAt` the repair wrote: a rollback refuses the row once it moved. */
  readonly updatedAt: string;
  /** The row's children right after the repair: a rollback never breaks a child filed later. */
  readonly children: readonly string[];
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
  /** Done ancestors a reparent reopened, as `cleo update --parent` does. */
  readonly reopened?: readonly string[];
  /**
   * The version (`updatedAt`, else `createdAt`) of each row the operations
   * write, as the plan read it. Pass the plan to {@link applyTypeMatrixRepair}
   * to apply exactly what was reviewed: a row written since is `E_CONFLICT`.
   */
  readonly rowVersions: Readonly<Record<string, string>>;
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
  guards: ReparentGuards,
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
    if (op.kind === 'reparent') assertReparentAllowed(op, after, guards);
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

/** What a reparent resolution is checked against, as `cleo update --parent` checks it. */
interface ReparentGuards {
  readonly status: ReadonlyMap<string, string>;
  readonly limits: { readonly maxDepth: number; readonly maxSiblings: number };
}

function depthOf(id: string, model: ReadonlyMap<string, Node>): number {
  let depth = 1;
  let parent = model.get(id)?.parentId ?? null;
  const seen = new Set([id]);
  while (parent !== null && !seen.has(parent)) {
    seen.add(parent);
    depth++;
    parent = model.get(parent)?.parentId ?? null;
  }
  return depth;
}

function subtreeHeight(id: string, children: ReadonlyMap<string, readonly string[]>): number {
  const kids = children.get(id) ?? [];
  return kids.length === 0 ? 0 : 1 + Math.max(...kids.map((k) => subtreeHeight(k, children)));
}

/**
 * Refuse a reparent resolution the reparent core (`coreTaskReparent`) would
 * refuse: a cancelled or archived target (T12883 R1), a target inside the
 * moved subtree (a cycle), and the depth and sibling limits. Done ancestors
 * are reopened at apply time, as that core does.
 */
function assertReparentAllowed(
  op: Extract<TypeMatrixRepairOp, { kind: 'reparent' }>,
  model: ReadonlyMap<string, Node>,
  guards: ReparentGuards,
): void {
  if (op.toParentId === op.taskId) {
    // @sync-invariant none:input-shape a reparent under itself is refused before anything is written
    throw refuse(`Moving ${op.taskId} under itself would create a cycle.`);
  }
  assertParentNotIrreversiblyTerminal(
    { id: op.toParentId, status: guards.status.get(op.toParentId) ?? 'pending' },
    op.taskId,
    'move',
  );
  let cursor: string | null = op.toParentId;
  const seen = new Set<string>();
  while (cursor !== null && !seen.has(cursor)) {
    if (cursor === op.taskId) {
      // @sync-invariant none:input-shape a reparent into the moved subtree is refused before anything is written
      throw refuse(
        `Moving ${op.taskId} under ${op.toParentId} would create a cycle: ${op.toParentId} is inside ${op.taskId}'s subtree.`,
      );
    }
    seen.add(cursor);
    cursor = model.get(cursor)?.parentId ?? null;
  }
  const children = childIndex(model);
  const deepest = depthOf(op.toParentId, model) + 1 + subtreeHeight(op.taskId, children);
  if (deepest > guards.limits.maxDepth) {
    // @sync-invariant none:input-shape a reparent past the depth limit is refused before anything is written
    throw refuse(
      `Moving ${op.taskId} under ${op.toParentId} would exceed the max depth of ${guards.limits.maxDepth}.`,
    );
  }
  const siblings = (children.get(op.toParentId) ?? []).filter((c) => c !== op.taskId).length;
  if (guards.limits.maxSiblings > 0 && siblings >= guards.limits.maxSiblings) {
    // @sync-invariant none:input-shape a reparent past the sibling limit is refused before anything is written
    throw refuse(
      `Cannot add ${op.taskId} under ${op.toParentId}: max siblings (${guards.limits.maxSiblings}) exceeded.`,
    );
  }
}

function guardsFor(projectRoot: string, tasks: readonly Task[]): ReparentGuards {
  return {
    status: new Map(tasks.map((t) => [t.id, t.status])),
    limits: getHierarchyLimits(projectRoot),
  };
}

function versionOf(task: Task): string {
  return task.updatedAt ?? task.createdAt;
}

function rowVersions(
  operations: readonly TypeMatrixRepairOp[],
  byId: ReadonlyMap<string, Task>,
): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const op of operations) {
    const task = byId.get(op.taskId);
    if (task) versions[op.taskId] = versionOf(task);
  }
  return versions;
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
  const guards = guardsFor(projectRoot, tasks);
  const { operations, unresolved } = decideOperations(plans, model, resolutions, guards);
  return {
    dryRun: true,
    violations: plans.length,
    byPair: byPair(plans),
    plans,
    operations,
    unresolved,
    rowVersions: rowVersions(operations, new Map(tasks.map((t) => [t.id, t]))),
  };
}

/** Options for {@link applyTypeMatrixRepair}. */
export interface TypeMatrixApplyOptions {
  /**
   * The reviewed dry run. Its operations must be the ones decided now, and
   * each row is written only at the version the plan read, so a write made
   * after the review is `E_CONFLICT` with nothing changed.
   */
  readonly plan?: TypeMatrixRepairReport;
}

/** Ancestors of `id` in the model, nearest first. */
function ancestorsOf(id: string | null, model: ReadonlyMap<string, Node>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cursor = id;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    out.push(cursor);
    cursor = model.get(cursor)?.parentId ?? null;
  }
  return out;
}

/**
 * Apply the proposals and the agent's resolutions in one transaction, and
 * record the receipt. Each row is written only at the version it was read at
 * (by this call, or by the reviewed `plan`): otherwise `E_CONFLICT`, and the
 * transaction writes nothing. A reparent reopens the done ancestors of its old
 * and new parent, as `cleo update --parent` does.
 *
 * @param projectRoot - Project root.
 * @param resolutions - Operations the calling agent chose for ambiguous pairs.
 * @param opts - The reviewed plan to hold the apply to.
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
  opts: TypeMatrixApplyOptions = {},
): Promise<TypeMatrixRepairReport> {
  const accessor = await getTaskAccessor(projectRoot);
  const { tasks } = await accessor.queryTasks({});
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const { model, plans } = planFor(tasks);
  const { operations, unresolved } = decideOperations(
    plans,
    model,
    resolutions,
    guardsFor(projectRoot, tasks),
  );
  if (opts.plan && JSON.stringify(opts.plan.operations) !== JSON.stringify(operations)) {
    // @sync-invariant none:local-only an apply never runs operations other than the reviewed plan's
    throw new CleoError(
      ExitCode.VERSION_CONFLICT,
      'The store changed since the plan was made, so the repair would run different operations than the ones reviewed.',
      {
        fix: 'Run cleo doctor type-matrix again and review the new plan.',
        details: { field: 'plan' },
      },
    );
  }
  const versions = { ...rowVersions(operations, byId), ...(opts.plan?.rowVersions ?? {}) };
  const report = {
    dryRun: false,
    violations: plans.length,
    byPair: byPair(plans),
    plans,
    operations,
    unresolved,
    rowVersions: versions,
  };
  if (operations.length === 0) return report;
  const after = new Map(model);
  for (const op of operations) applyOp(after, op);
  const childrenAfter = childIndex(after);
  const reopen = new Set<string>();
  for (const op of operations) {
    if (op.kind !== 'reparent') continue;
    const oldParent = model.get(op.taskId)?.parentId ?? null;
    for (const id of [...ancestorsOf(oldParent, model), ...ancestorsOf(op.toParentId, after)]) {
      if (byId.get(id)?.status === 'done') reopen.add(id);
    }
  }
  const receiptId = `type-matrix-${randomUUID()}`;
  const stamp = new Date().toISOString();
  const rows = await accessor.transaction(async (tx) => {
    const current = new Map<string, string>();
    const write = async (id: string, fields: TaskFieldUpdates): Promise<string> => {
      const task = byId.get(id);
      const expected = current.get(id) ?? versions[id] ?? (task ? versionOf(task) : undefined);
      const updatedAt = nextTaskVersion({ updatedAt: expected ?? null, createdAt: stamp }, stamp);
      await tx.updateTaskFields(
        id,
        { ...fields, updatedAt },
        expected === undefined ? undefined : { expectedUpdatedAt: expected },
      );
      current.set(id, updatedAt);
      return updatedAt;
    };
    const images: TypeMatrixRowImage[] = [];
    for (const op of operations) {
      const before = model.get(op.taskId);
      if (before === undefined) continue;
      const fields = op.kind === 'retype' ? { type: op.to } : { parentId: op.toParentId };
      const was = { type: before.type, parentId: before.parentId };
      const now =
        op.kind === 'retype' ? { ...was, type: op.to } : { ...was, parentId: op.toParentId };
      images.push({
        id: op.taskId,
        before: was,
        after: now,
        updatedAt: await write(op.taskId, fields),
        children: childrenAfter.get(op.taskId) ?? [],
      });
    }
    for (const id of reopen) await write(id, { status: 'pending', completedAt: null });
    // Each image carries the version this transaction last wrote.
    const final = images.map((r) => ({ ...r, updatedAt: current.get(r.id) ?? r.updatedAt }));
    await tx.appendLog({
      id: receiptId,
      action: TYPE_MATRIX_REPAIR_ACTION,
      taskId: final[0]?.id ?? 'doctor',
      actor: 'cleo doctor type-matrix',
      details: { operations, unresolved, reopened: [...reopen] },
      before: final.map((r) => ({ id: r.id, ...r.before })),
      after: final.map((r) => ({
        id: r.id,
        ...r.after,
        updatedAt: r.updatedAt,
        children: r.children,
      })),
    });
    return final;
  });
  return {
    ...report,
    receiptId,
    rollback: `cleo doctor type-matrix --rollback ${receiptId}`,
    rows,
    reopened: [...reopen],
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
 * Split a receipt's before image into the rows a rollback may restore, in an
 * order that restores a parent before its child, and the rows it refuses with
 * the reason. A row is refused when the type-matrix trigger forbids its
 * before image (owner decision, T14096 Q2), or when restoring it would break
 * a child filed under it after the repair.
 */
function restorable(
  before: readonly ImageRow[],
  after: ReadonlyMap<string, AfterImageRow>,
  typeOf: ReadonlyMap<string, TaskType>,
  childrenNow: ReadonlyMap<string, readonly Task[]>,
): { restore: ImageRow[]; refused: { id: string; reason: string }[] } {
  const pending = new Map(before.map((r) => [r.id, r]));
  const refused: { id: string; reason: string }[] = [];
  const finalType = (id: string): TaskType | undefined => pending.get(id)?.type ?? typeOf.get(id);
  let dropped = true;
  while (dropped) {
    dropped = false;
    for (const row of pending.values()) {
      const reason = refusalOf(row, after.get(row.id), finalType, childrenNow.get(row.id) ?? []);
      if (reason === null) continue;
      pending.delete(row.id);
      refused.push({ id: row.id, reason });
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

function refusalOf(
  row: ImageRow,
  then: AfterImageRow | undefined,
  finalType: (id: string) => TaskType | undefined,
  children: readonly Task[],
): string | null {
  if (row.parentId !== null) {
    const parentType = finalType(row.parentId);
    if (parentType !== undefined && !TRIGGER_PARENTS[row.type].includes(parentType)) {
      return `restoring ${row.id} as a ${row.type} under ${row.parentId} (a ${parentType}) is refused by the type-matrix trigger; the repair's value stays`;
    }
  }
  const known = new Set(then?.children ?? []);
  const later = children.find(
    (c) =>
      !known.has(c.id) &&
      isAllowedWorkGraphParentType(c.type ?? 'task', then?.type ?? row.type) &&
      !isAllowedWorkGraphParentType(c.type ?? 'task', row.type),
  );
  return later === undefined
    ? null
    : `restoring ${row.id} as a ${row.type} would break ${later.id} (a ${later.type ?? 'task'} filed under it after the repair); the repair's value stays`;
}

interface ImageRow {
  id: string;
  type: TaskType;
  parentId: string | null;
}

interface AfterImageRow extends ImageRow {
  updatedAt?: string;
  children?: string[];
}

function malformed(receiptId: string): CleoError {
  // @sync-invariant none:input-shape a malformed receipt is refused before anything is written
  return new CleoError(
    ExitCode.VALIDATION_ERROR,
    `Receipt ${receiptId} has a malformed row image.`,
    {
      details: { field: 'receiptId' },
    },
  );
}

function parseImages(json: string | null, receiptId: string): AfterImageRow[] {
  if (json === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // @sync-invariant none:input-shape a malformed receipt is refused before anything is written
    throw malformed(receiptId);
  }
  // @sync-invariant none:input-shape a malformed receipt is refused before anything is written
  if (!Array.isArray(parsed)) throw malformed(receiptId);
  return parsed.map((entry) => {
    const r = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
    const { id, type, parentId, updatedAt, children } = r;
    // @sync-invariant none:input-shape a malformed receipt is refused before anything is written
    if (typeof id !== 'string' || !isTaskType(type)) throw malformed(receiptId);
    // @sync-invariant none:input-shape a malformed receipt is refused before anything is written
    if (parentId !== null && typeof parentId !== 'string') throw malformed(receiptId);
    return {
      id,
      type,
      parentId,
      ...(typeof updatedAt === 'string' ? { updatedAt } : {}),
      ...(Array.isArray(children)
        ? { children: children.filter((c): c is string => typeof c === 'string') }
        : {}),
    };
  });
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
  const before = parseImages(receipt.beforeJson, receiptId);
  const after = new Map(parseImages(receipt.afterJson, receiptId).map((r) => [r.id, r]));
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
      (now.parentId ?? null) !== then.parentId ||
      (then.updatedAt !== undefined && versionOf(now) !== then.updatedAt)
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
  const childrenNow = new Map<string, Task[]>();
  for (const row of before) childrenNow.set(row.id, await accessor.getChildren(row.id));
  const { restore, refused } = restorable(before, after, typeOf, childrenNow);
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
        { expectedUpdatedAt: versionOf(now) },
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
