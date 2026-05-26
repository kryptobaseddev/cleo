import type {
  AcBindingRow,
  AcRow,
  CompletionBlockerReason,
  CompletionCriterionEvaluation,
  CompletionCriterionReplacement,
  CompletionCriterionWaiver,
  CompletionEvaluation,
  CompletionExplanation,
  CompletionStaleReason,
  DataAccessor,
  Task,
  TaskStatus,
} from '@cleocode/contracts';

export interface EvaluateCompletionOptions {
  /**
   * Legacy child-id-only waiver list retained for callers not yet migrated to
   * criterion-scoped waiver records. Prefer `childWaivers` for new code.
   */
  readonly waivedChildTaskIds?: readonly string[];
  /** Criterion-scoped waivers with reason, actor, and timestamp metadata. */
  readonly childWaivers?: readonly CompletionCriterionWaiver[];
  /** Criterion-scoped replacement policies for cancelled or superseded children. */
  readonly childReplacements?: readonly CompletionCriterionReplacement[];
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

function criterionChildKey(criterionAcId: string, childTaskId: string): string {
  return `${criterionAcId}\u0000${childTaskId}`;
}

function waiversByCriterionChild(
  waivers: readonly CompletionCriterionWaiver[],
): Map<string, CompletionCriterionWaiver> {
  return new Map(
    waivers.map((waiver) => [criterionChildKey(waiver.criterionAcId, waiver.childTaskId), waiver]),
  );
}

function replacementsByCriterionChild(
  replacements: readonly CompletionCriterionReplacement[],
): Map<string, CompletionCriterionReplacement> {
  return new Map(
    replacements.map((replacement) => [
      criterionChildKey(replacement.criterionAcId, replacement.originalChildTaskId),
      replacement,
    ]),
  );
}

function legacyWaiverFor(row: AcRow, childTaskId: string): CompletionCriterionWaiver {
  return {
    criterionAcId: row.id,
    childTaskId,
    reason: 'legacy child id waiver',
    actor: 'legacy-waivedChildTaskIds',
    waivedAt: 'legacy',
  };
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
  waivers: ReadonlyMap<string, CompletionCriterionWaiver>,
  replacements: ReadonlyMap<string, CompletionCriterionReplacement>,
  legacyWaivedChildTaskIds: ReadonlySet<string>,
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
  const replacement = replacements.get(criterionChildKey(row.id, child.id));
  if (replacement) {
    const replacementTask = children.get(replacement.replacementChildTaskId);
    if (replacementTask?.status === 'done') {
      return {
        ...withChild,
        status: 'replaced',
        replacement,
        replacementTaskStatus: replacementTask.status,
      };
    }
    return {
      ...withChild,
      status: 'unsatisfied',
      reason: 'child_replacement_not_done',
      replacement,
      ...(replacementTask ? { replacementTaskStatus: replacementTask.status } : {}),
    };
  }

  if (CHILD_SATISFIED_STATUS.has(child.status)) {
    return { ...withChild, status: 'satisfied' };
  }
  if (CHILD_WAIVABLE_STATUS.has(child.status)) {
    const waiver =
      waivers.get(criterionChildKey(row.id, child.id)) ??
      (legacyWaivedChildTaskIds.has(child.id) ? legacyWaiverFor(row, child.id) : undefined);
    if (waiver) {
      return { ...withChild, status: 'waived', waiver };
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
  const legacyWaivedChildTaskIds = new Set(options.waivedChildTaskIds ?? []);
  const waivers = waiversByCriterionChild(options.childWaivers ?? []);
  const replacements = replacementsByCriterionChild(options.childReplacements ?? []);

  const criteria = acRows.map((row) => {
    const evidenceBindings = bindingMap.get(row.id)?.length ?? 0;
    if (row.kind === 'child_task') {
      return evaluateChildCriterion(
        row,
        evidenceBindings,
        childrenMap,
        waivers,
        replacements,
        legacyWaivedChildTaskIds,
      );
    }
    return evaluateTextOrEvidence(row, evidenceBindings);
  });

  const satisfied = criteria.filter((criterion) => criterion.status === 'satisfied');
  const waived = criteria.filter((criterion) => criterion.status === 'waived');
  const replaced = criteria.filter((criterion) => criterion.status === 'replaced');
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
    replaced,
    totals: {
      criteria: criteria.length,
      satisfied: satisfied.length,
      unsatisfied: unsatisfied.length,
      waived: waived.length,
      replaced: replaced.length,
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
    return `Task ${evaluation.taskId} is ready to complete: ${evaluation.totals.satisfied} satisfied, ${evaluation.totals.waived} waived, ${evaluation.totals.replaced} replaced, 0 unsatisfied criteria.`;
  }
  if (evaluation.stale) {
    return `Task ${evaluation.taskId} is already done but has ${evaluation.totals.unsatisfied} unsatisfied completion criteria.`;
  }
  return `Task ${evaluation.taskId} is not ready to complete: ${evaluation.totals.unsatisfied} unsatisfied, ${evaluation.totals.satisfied} satisfied, ${evaluation.totals.waived} waived, ${evaluation.totals.replaced} replaced criteria.`;
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
