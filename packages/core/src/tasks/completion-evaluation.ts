import type {
  AcBindingRow,
  AcRow,
  CompletionBlockerReason,
  CompletionCriterionEvaluation,
  CompletionEvaluation,
  CompletionExplanation,
  CompletionStaleReason,
  DataAccessor,
  Task,
  TaskStatus,
} from '@cleocode/contracts';

export interface EvaluateCompletionOptions {
  /** Cancelled child tasks that an operator has explicitly waived for completion. */
  readonly waivedChildTaskIds?: readonly string[];
}

const CHILD_SATISFIED_STATUS: ReadonlySet<TaskStatus> = new Set(['done']);
const CHILD_WAIVABLE_STATUS: ReadonlySet<TaskStatus> = new Set(['cancelled']);

function aliasFor(row: AcRow): string {
  return `AC${row.ordinal}`;
}

function bindingsByAcId(bindings: readonly AcBindingRow[]): Map<string, AcBindingRow[]> {
  const map = new Map<string, AcBindingRow[]>();
  for (const binding of bindings) {
    const existing = map.get(binding.acId) ?? [];
    existing.push(binding);
    map.set(binding.acId, existing);
  }
  return map;
}

function childById(children: readonly Task[]): Map<string, Task> {
  return new Map(children.map((child) => [child.id, child]));
}

function criterionBase(
  row: AcRow,
  evidenceBindings: number,
): Omit<CompletionCriterionEvaluation, 'status'> {
  const targetTaskId = row.targetTaskId ?? undefined;
  return {
    acId: row.id,
    alias: aliasFor(row),
    text: row.text,
    kind: row.kind,
    evidenceBindings,
    ...(targetTaskId ? { targetTaskId } : {}),
  };
}

function evaluateTextOrEvidence(
  row: AcRow,
  evidenceBindings: number,
): CompletionCriterionEvaluation {
  const base = criterionBase(row, evidenceBindings);
  if (evidenceBindings > 0) {
    return { ...base, status: 'satisfied' };
  }
  return { ...base, status: 'unsatisfied', reason: 'missing_evidence_binding' };
}

function evaluateChildCriterion(
  row: AcRow,
  evidenceBindings: number,
  children: ReadonlyMap<string, Task>,
  waivedChildTaskIds: ReadonlySet<string>,
): CompletionCriterionEvaluation {
  const base = criterionBase(row, evidenceBindings);
  const targetTaskId = row.targetTaskId ?? undefined;
  if (!targetTaskId) {
    return { ...base, status: 'unsatisfied', reason: 'child_missing' };
  }

  const child = children.get(targetTaskId);
  if (!child) {
    return { ...base, targetTaskId, status: 'unsatisfied', reason: 'child_missing' };
  }

  const withChild = { ...base, targetTaskId, targetTaskStatus: child.status };
  if (CHILD_SATISFIED_STATUS.has(child.status)) {
    return { ...withChild, status: 'satisfied' };
  }
  if (CHILD_WAIVABLE_STATUS.has(child.status)) {
    if (waivedChildTaskIds.has(child.id)) {
      return { ...withChild, status: 'waived' };
    }
    return {
      ...withChild,
      status: 'unsatisfied',
      reason: 'child_cancelled_requires_waiver',
    };
  }
  return { ...withChild, status: 'unsatisfied', reason: 'child_not_done' };
}

/**
 * Evaluate whether a task's AC table is complete enough to mark done.
 *
 * The result is intentionally contract-backed so CLI, SDK, dispatch, and future
 * completion commands can share one typed SSoT instead of re-deriving ad hoc
 * ready/blocked explanations.
 */
export async function evaluateCompletion(
  taskId: string,
  accessor: DataAccessor,
  options: EvaluateCompletionOptions = {},
): Promise<CompletionEvaluation> {
  const task = await accessor.loadSingleTask(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  const [acRows, children] = await Promise.all([
    accessor.getAcRows(taskId),
    accessor.getChildren(taskId),
  ]);
  const bindings = await accessor.getAcBindings(acRows.map((row) => row.id));
  const bindingMap = bindingsByAcId(bindings);
  const childrenMap = childById(children);
  const waivedChildTaskIds = new Set(options.waivedChildTaskIds ?? []);

  const criteria = acRows.map((row) => {
    const evidenceBindings = bindingMap.get(row.id)?.length ?? 0;
    if (row.kind === 'child_task') {
      return evaluateChildCriterion(row, evidenceBindings, childrenMap, waivedChildTaskIds);
    }
    return evaluateTextOrEvidence(row, evidenceBindings);
  });

  const satisfied = criteria.filter((criterion) => criterion.status === 'satisfied');
  const waived = criteria.filter((criterion) => criterion.status === 'waived');
  const unsatisfied = criteria.filter((criterion) => criterion.status === 'unsatisfied');
  const staleReasons: CompletionStaleReason[] =
    task.status === 'done' && unsatisfied.length > 0
      ? ['done_parent_has_unsatisfied_criteria']
      : [];
  const stale = staleReasons.length > 0;

  return {
    taskId,
    taskStatus: task.status,
    ready: unsatisfied.length === 0 && !stale,
    stale,
    staleReasons,
    satisfied,
    unsatisfied,
    waived,
    totals: {
      criteria: criteria.length,
      satisfied: satisfied.length,
      unsatisfied: unsatisfied.length,
      waived: waived.length,
    },
  };
}

function blockerForStale(evaluation: CompletionEvaluation): CompletionCriterionEvaluation {
  return {
    acId: `${evaluation.taskId}:done-parent-stale`,
    alias: 'TASK',
    text: `Task ${evaluation.taskId} is already done but has unsatisfied completion criteria`,
    kind: 'text',
    status: 'unsatisfied',
    reason: 'done_parent_stale' satisfies CompletionBlockerReason,
    evidenceBindings: 0,
  };
}

function summarize(evaluation: CompletionEvaluation): string {
  if (evaluation.ready) {
    return `Task ${evaluation.taskId} is ready to complete: ${evaluation.totals.satisfied} satisfied, ${evaluation.totals.waived} waived, 0 unsatisfied criteria.`;
  }
  if (evaluation.stale) {
    return `Task ${evaluation.taskId} is already done but has ${evaluation.totals.unsatisfied} unsatisfied completion criteria.`;
  }
  return `Task ${evaluation.taskId} is not ready to complete: ${evaluation.totals.unsatisfied} unsatisfied, ${evaluation.totals.satisfied} satisfied, ${evaluation.totals.waived} waived criteria.`;
}

/** Format a CompletionEvaluation into a compact, human-readable explanation. */
export function explainCompletion(evaluation: CompletionEvaluation): CompletionExplanation {
  return {
    taskId: evaluation.taskId,
    ready: evaluation.ready,
    stale: evaluation.stale,
    summary: summarize(evaluation),
    blockers: evaluation.stale
      ? [blockerForStale(evaluation), ...evaluation.unsatisfied]
      : evaluation.unsatisfied,
  };
}
