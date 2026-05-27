/**
 * Task relationship management core module.
 * @task T4538
 * @epic T4454
 */

import type {
  TaskRef,
  TasksRelatesAddBatchEntry,
  TasksRelatesAddBatchResult,
} from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import type { DataAccessor } from '../store/data-accessor.js';
import { getTaskAccessor } from '../store/data-accessor.js';

const VALID_RELATION_TYPES = [
  'related',
  'blocks',
  'duplicates',
  'absorbs',
  'fixes',
  'extends',
  'supersedes',
  'groups',
] as const;

type ValidRelationType = (typeof VALID_RELATION_TYPES)[number];

function isValidRelationType(type: string): type is ValidRelationType {
  return VALID_RELATION_TYPES.includes(type as ValidRelationType);
}

function normalizeBatchEntry(
  entry: TasksRelatesAddBatchEntry,
  index: number,
  reasonWaiver?: string,
): TasksRelatesAddBatchResult['relations'][number] {
  const from = entry.taskId ?? entry.from;
  const to = entry.relatedId ?? entry.to;
  if (!from) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Relation edge ${index} is missing source taskId/from`,
      {
        details: { index, field: 'taskId' },
      },
    );
  }
  if (!to) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Relation edge ${index} is missing target relatedId/to`,
      {
        details: { index, field: 'relatedId' },
      },
    );
  }
  if (!entry.type || !isValidRelationType(entry.type)) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Relation edge ${index} has invalid relation type: ${entry.type ?? '<missing>'}`,
      { details: { field: 'type', index, validTypes: [...VALID_RELATION_TYPES] } },
    );
  }
  const reason = entry.reason?.trim();
  const waiver = reasonWaiver?.trim();
  if (!reason && !waiver) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Relation edge ${index} requires a reason or batch reasonWaiver`,
      { details: { field: 'reason', index, code: 'E_WORKGRAPH_RELATION_REASON_MISSING' } },
    );
  }
  return {
    from,
    to,
    type: entry.type,
    reason: reason || waiver,
    waivedReason: !reason,
  };
}

/** Suggest related tasks based on shared attributes. */
export async function suggestRelated(
  taskId: string,
  opts: { threshold?: number; cwd?: string },
  accessor?: DataAccessor,
): Promise<Record<string, unknown>> {
  const acc = accessor ?? (await getTaskAccessor(opts.cwd));
  const { tasks: allTasks } = await acc.queryTasks({});
  const task = allTasks.find((t) => t.id === taskId);
  if (!task) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task ${taskId} not found`, {
      fix: `cleo find "${taskId}"`,
      details: { field: 'taskId', actual: taskId },
    });
  }

  const suggestions: Array<Pick<TaskRef, 'id' | 'title'> & { score: number; reason: string }> = [];

  for (const other of allTasks) {
    if (other.id === taskId) continue;
    let score = 0;
    const reasons: string[] = [];

    // Shared labels
    const sharedLabels = (task.labels ?? []).filter((l) => (other.labels ?? []).includes(l));
    if (sharedLabels.length > 0) {
      score += sharedLabels.length * 20;
      reasons.push(`Shared labels: ${sharedLabels.join(', ')}`);
    }

    // Same phase
    if (task.phase && task.phase === other.phase) {
      score += 15;
      reasons.push(`Same phase: ${task.phase}`);
    }

    // Same parent
    if (task.parentId && task.parentId === other.parentId) {
      score += 25;
      reasons.push('Same parent');
    }

    const threshold = opts.threshold ?? 50;
    if (score >= threshold) {
      suggestions.push({
        id: other.id,
        title: other.title,
        score: Math.min(score, 100),
        reason: reasons.join('; '),
      });
    }
  }

  return {
    taskId,
    suggestions: suggestions.sort((a, b) => b.score - a.score).slice(0, 10),
    count: suggestions.length,
  };
}

/** Add a relation between tasks. */
export async function addRelation(
  from: string,
  to: string,
  type: string,
  reason: string,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<Record<string, unknown>> {
  const acc = accessor ?? (await getTaskAccessor(cwd));

  const fromExists = await acc.taskExists(from);
  if (!fromExists) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task ${from} not found`, {
      fix: `cleo find "${from}"`,
      details: { field: 'from', actual: from },
    });
  }

  const toExists = await acc.taskExists(to);
  if (!toExists) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task ${to} not found`, {
      fix: `cleo find "${to}"`,
      details: { field: 'to', actual: to },
    });
  }

  // Persist to task_relations table via accessor (T5168 fix)
  await acc.addRelation(from, to, type, reason);

  return { from, to, type, reason, added: true };
}

/** Add multiple relation edges after prevalidating the full batch. */
export async function addBatchRelations(
  entries: TasksRelatesAddBatchEntry[],
  opts: { dryRun?: boolean; reasonWaiver?: string; cwd?: string } = {},
  accessor?: DataAccessor,
): Promise<TasksRelatesAddBatchResult> {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new CleoError(ExitCode.VALIDATION_ERROR, 'relations/edges must be a non-empty array', {
      details: { field: 'relations' },
    });
  }

  const acc = accessor ?? (await getTaskAccessor(opts.cwd));
  const relations = entries.map((entry, index) =>
    normalizeBatchEntry(entry, index, opts.reasonWaiver),
  );

  const uniqueTaskIds = new Set<string>();
  for (const relation of relations) {
    uniqueTaskIds.add(relation.from);
    uniqueTaskIds.add(relation.to);
  }
  for (const taskId of uniqueTaskIds) {
    if (!(await acc.taskExists(taskId))) {
      throw new CleoError(ExitCode.NOT_FOUND, `Task ${taskId} not found`, {
        fix: `cleo find "${taskId}"`,
        details: { field: 'taskId', actual: taskId },
      });
    }
  }

  const warnings: TasksRelatesAddBatchResult['warnings'] = relations
    .filter((relation) => relation.waivedReason)
    .map((relation) => ({
      code: 'E_WORKGRAPH_RELATION_REASON_WAIVED',
      message: `Relation ${relation.from} -> ${relation.to} (${relation.type}) used batch reasonWaiver`,
      edge: { from: relation.from, to: relation.to, type: relation.type },
    }));

  for (const relation of relations.filter((edge) => edge.type === 'blocks')) {
    warnings.push({
      code: 'E_WORKGRAPH_DEPENDS_RELATES_MISUSE',
      message: `Relation ${relation.from} -> ${relation.to} is advisory; use task_dependencies for scheduler dependency edges`,
      edge: { from: relation.from, to: relation.to, type: relation.type },
    });
  }

  const groupsGraph = new Map<string, Set<string>>();
  for (const taskId of uniqueTaskIds) {
    const task = await acc.loadSingleTask(taskId);
    for (const relation of task?.relates ?? []) {
      if (relation.type !== 'groups') continue;
      const next = groupsGraph.get(taskId) ?? new Set<string>();
      next.add(relation.taskId);
      groupsGraph.set(taskId, next);
    }
  }
  for (const relation of relations.filter((edge) => edge.type === 'groups')) {
    const next = groupsGraph.get(relation.from) ?? new Set<string>();
    next.add(relation.to);
    groupsGraph.set(relation.from, next);
  }
  const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    for (const child of groupsGraph.get(from) ?? []) {
      if (reaches(child, target, seen)) return true;
    }
    return false;
  };
  for (const relation of relations.filter((edge) => edge.type === 'groups')) {
    if (reaches(relation.to, relation.from)) {
      warnings.push({
        code: 'E_WORKGRAPH_CONTAINMENT_CYCLE',
        message: `Relation ${relation.from} -> ${relation.to} would introduce a groups containment cycle`,
        edge: { from: relation.from, to: relation.to, type: relation.type },
      });
    }
  }

  if (!opts.dryRun) {
    // All validation happens before the first write. The storage layer uses
    // idempotent INSERT ... ON CONFLICT DO NOTHING for duplicate-safe edges.
    for (const relation of relations) {
      await acc.addRelation(relation.from, relation.to, relation.type, relation.reason);
    }
  }

  return {
    dryRun: Boolean(opts.dryRun),
    validatedCount: relations.length,
    created: opts.dryRun ? 0 : relations.length,
    wouldCreate: opts.dryRun ? relations.length : 0,
    relations,
    warnings,
  };
}

/** Remove a relation between tasks. */
export async function removeRelation(
  from: string,
  to: string,
  type?: string,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<Record<string, unknown>> {
  const acc = accessor ?? (await getTaskAccessor(cwd));

  const fromExists = await acc.taskExists(from);
  if (!fromExists) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task ${from} not found`, {
      fix: `cleo find "${from}"`,
      details: { field: 'from', actual: from },
    });
  }

  const toExists = await acc.taskExists(to);
  if (!toExists) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task ${to} not found`, {
      fix: `cleo find "${to}"`,
      details: { field: 'to', actual: to },
    });
  }

  await acc.removeRelation(from, to, type);

  return { from, to, type, removed: true };
}

/** Discover related tasks using various methods. */
export async function discoverRelated(
  taskId: string,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<Record<string, unknown>> {
  return suggestRelated(taskId, { threshold: 30, cwd }, accessor);
}

/** List existing relations for a task. */
export async function listRelations(
  taskId: string,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<Record<string, unknown>> {
  const acc = accessor ?? (await getTaskAccessor(cwd));
  const task = await acc.loadSingleTask(taskId);
  if (!task) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task ${taskId} not found`, {
      fix: `cleo find "${taskId}"`,
      details: { field: 'taskId', actual: taskId },
    });
  }

  // task.relates is populated from task_relations table by loadSingleTask
  const relates = task.relates ?? [];
  return {
    taskId,
    relations: relates,
    count: relates.length,
  };
}
