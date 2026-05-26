/**
 * Core implementation for `tasks.context` — task-scoped context pack with token budget.
 *
 * Combines identity + acceptance criteria + blockers + docs + graph edges
 * (from taskSlice) + recent activity within a configurable token budget,
 * with explicit omission tracking and expansion hints.
 *
 * When `scope` is `'saga'` or `'epic'`, also includes rollup summaries
 * and the ready frontier for the scope.
 *
 * @task T10629
 * @task T10630
 */

import type {
  DataAccessor,
  Task,
  TasksContextAcceptanceEntry,
  TasksContextActivityEvent,
  TasksContextBlockerEntry,
  TasksContextBudget,
  TasksContextDocEntry,
  TasksContextOmission,
  TasksContextParams,
  TasksContextResult,
  TasksScopeMember,
  TasksScopeReadyEntry,
  TasksScopeRollup,
  TasksSliceResult,
} from '@cleocode/contracts';
import { SAGA_GROUPS_RELATION } from '../sagas/constants.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { coreTaskSlice } from './task-data.js';

const DEFAULT_BUDGET_TOKENS = 1500;
const DEFAULT_ACTIVITY_LIMIT = 10;
const DEFAULT_EDGE_DEPTH = 1;
const ESTIMATED_TOKENS_PER_CHAR = 0.25;

function clampPositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length * ESTIMATED_TOKENS_PER_CHAR);
}

function estimateObjectTokens(obj: unknown): number {
  return estimateTokens(JSON.stringify(obj));
}

async function loadTaskWithAccessor(
  taskId: string,
  accessor: DataAccessor,
): Promise<{ task: Task }> {
  const task = await accessor.loadSingleTask(taskId);
  if (!task) throw new Error(`Task '${taskId}' not found`);
  return { task };
}

async function buildIdentity(
  task: Task,
): Promise<TasksContextResult['identity']> {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    type: task.type,
    priority: task.priority,
    description: task.description,
    parentId: task.parentId ?? null,
  };
}

async function buildAcceptance(
  task: Task,
): Promise<TasksContextAcceptanceEntry[]> {
  if (!task.acceptance || task.acceptance.length === 0) return [];
  const acEntries: TasksContextAcceptanceEntry[] = [];
  for (let i = 0; i < task.acceptance.length; i++) {
    const ac = task.acceptance[i];
    const text = typeof ac === 'string' ? ac : JSON.stringify(ac);
    const alias = `AC${i + 1}`;
    acEntries.push({ alias, text });
  }
  return acEntries;
}

async function buildBlockers(
  task: Task,
  accessor: DataAccessor,
): Promise<TasksContextBlockerEntry[]> {
  const blockers: TasksContextBlockerEntry[] = [];

  if (task.depends && task.depends.length > 0) {
    for (const depId of task.depends) {
      const dep = await accessor.loadSingleTask(depId);
      if (dep && dep.status !== 'done' && dep.status !== 'cancelled') {
        blockers.push({
          taskId: dep.id,
          title: dep.title,
          status: dep.status,
          kind: 'dependency',
        });
      }
    }
  }

  if (task.status === 'blocked' && task.blockedBy) {
    blockers.push({
      taskId: task.id,
      title: task.blockedBy,
      status: task.status,
      kind: 'gate',
    });
  }

  return blockers;
}

async function buildDocs(
  _task: Task,
  _accessor: DataAccessor,
): Promise<TasksContextDocEntry[]> {
  return [];
}

async function buildEdges(
  projectRoot: string,
  taskId: string,
  edgeDepth: number,
  includeRelates: boolean,
): Promise<{ edges: TasksContextResult['edges']; slice: TasksSliceResult }> {
  const slice = await coreTaskSlice(projectRoot, taskId, {
    depth: edgeDepth,
    direction: 'around',
    includeRelates,
  });

  const edges: TasksContextResult['edges'] = {
    upstream: slice.upstream,
    downstream: slice.downstream,
    siblings: slice.siblings,
    ...(slice.related ? { related: slice.related } : {}),
  };

  return { edges, slice };
}

async function buildActivity(
  taskId: string,
  accessor: DataAccessor,
  limit: number,
): Promise<TasksContextActivityEvent[]> {
  const rows = await accessor.queryAuditLog({
    taskIds: [taskId],
    limit,
  });

  return rows.map((row: { timestamp: string; action: string; actor?: string | null; detailsJson?: string | null }) => ({
    timestamp: row.timestamp,
    action: row.action,
    actor: row.actor ?? undefined,
    details: row.detailsJson ?? undefined,
  }));
}

function makeOmission(
  path: string,
  reason: TasksContextOmission['reason'],
  message: string,
  count?: number,
  expansionCommand?: string,
): TasksContextOmission {
  return {
    path,
    reason,
    message,
    ...(count !== undefined ? { count } : {}),
    ...(expansionCommand !== undefined ? { expansionCommand } : {}),
  };
}

// ---------------------------------------------------------------------------
// Saga / Epic scope helpers (T10630)
// ---------------------------------------------------------------------------

/**
 * Determine if a task is saga-shaped (first-class `type='saga'` or
 * legacy `type='epic'` with `labels` containing `'saga'`).
 *
 * @task T10630
 */
function isSagaShaped(task: Task): boolean {
  if (task.type === 'saga') return true;
  if (task.type !== 'epic') return false;
  return (task.labels ?? []).includes('saga');
}

/**
 * Build rollup + members + ready frontier for a saga.
 *
 * Resolves member epics via `task_relations.type='groups'` edges,
 * computes aggregate status rollup, and fetches the ready frontier
 * across all member epics.
 *
 * @task T10630
 */
async function buildSagaScope(
  projectRoot: string,
  saga: Task,
  accessor: DataAccessor,
): Promise<{
  rollup: TasksScopeRollup;
  members: TasksScopeMember[];
  readyFrontier: TasksScopeReadyEntry[];
}> {
  // Resolve member epics via relates
  const sagaWithRelates = await accessor.loadSingleTask(saga.id);
  const memberIds: string[] = [];
  if (sagaWithRelates?.relates) {
    for (const rel of sagaWithRelates.relates) {
      if (rel.type === SAGA_GROUPS_RELATION) {
        memberIds.push(rel.taskId);
      }
    }
  }

  // Load member epic details
  const members: TasksScopeMember[] = [];
  let done = 0;
  let active = 0;
  let blocked = 0;
  let pending = 0;

  for (const epicId of memberIds) {
    const epic = await accessor.loadSingleTask(epicId);
    if (!epic) continue;
    members.push({ epicId: epic.id, title: epic.title, status: epic.status });
    switch (epic.status) {
      case 'done': done++; break;
      case 'active': active++; break;
      case 'blocked': blocked++; break;
      default: pending++; break;
    }
  }

  const total = members.length;
  const rollup: TasksScopeRollup = {
    total,
    done,
    active,
    blocked,
    pending,
    completionPct: total > 0 ? Math.round((done / total) * 100) : 0,
  };

  // Resolve ready frontier across member epics via orchestrate ready
  const readyFrontier: TasksScopeReadyEntry[] = [];
  try {
    const { orchestrateReady } = await import('../orchestrate/query-ops.js');
    const seenIds = new Set<string>();
    for (const epicId of memberIds) {
      try {
        const readyResult = await orchestrateReady(epicId, projectRoot);
        if (!readyResult.success) continue;
        const rData = readyResult.data as
          | { readyTasks?: Array<{ id: string; title: string; priority: string; depends: string[] }> }
          | undefined;
        for (const t of rData?.readyTasks ?? []) {
          if (seenIds.has(t.id)) continue;
          seenIds.add(t.id);
          readyFrontier.push({
            id: t.id,
            title: t.title,
            priority: t.priority,
            depends: t.depends,
          });
        }
      } catch {
        // Skip member epics that fail ready resolution
      }
    }
  } catch {
    // orchestrateReady module unavailable — omit ready frontier
  }

  return { rollup, members, readyFrontier };
}

/**
 * Build rollup + ready frontier for an epic.
 *
 * Computes aggregate status rollup across child tasks and
 * fetches the ready frontier.
 *
 * @task T10630
 */
async function buildEpicScope(
  projectRoot: string,
  epic: Task,
  accessor: DataAccessor,
): Promise<{
  rollup: TasksScopeRollup;
  readyFrontier: TasksScopeReadyEntry[];
}> {
  // Get child tasks
  const { tasks: allTasks } = await accessor.queryTasks({});
  const children = allTasks.filter((t) => t.parentId === epic.id);

  let done = 0;
  let activeC = 0;
  let blocked = 0;
  let pending = 0;

  for (const child of children) {
    switch (child.status) {
      case 'done': done++; break;
      case 'active': activeC++; break;
      case 'blocked': blocked++; break;
      default: pending++; break;
    }
  }

  const total = children.length;
  const rollup: TasksScopeRollup = {
    total,
    done,
    active: activeC,
    blocked,
    pending,
    completionPct: total > 0 ? Math.round((done / total) * 100) : 0,
  };

  // Resolve ready frontier via orchestrate ready
  const readyFrontier: TasksScopeReadyEntry[] = [];
  try {
    const { orchestrateReady } = await import('../orchestrate/query-ops.js');
    const readyResult = await orchestrateReady(epic.id, projectRoot);
    if (readyResult.success) {
      const rData = readyResult.data as
        | { readyTasks?: Array<{ id: string; title: string; priority: string; depends: string[] }> }
        | undefined;
      for (const t of rData?.readyTasks ?? []) {
        readyFrontier.push({
          id: t.id,
          title: t.title,
          priority: t.priority,
          depends: t.depends,
        });
      }
    }
  } catch {
    // orchestrateReady module unavailable — omit ready frontier
  }

  return { rollup, readyFrontier };
}

/**
 * Build a bounded task-scoped context pack.
 *
 * When `params.scope` is `'saga'`, resolves member-epic rollup + ready
 * frontier across all members. When `'epic'`, resolves child-task rollup
 * + ready frontier. Otherwise behaves as a single-task pack (T10629
 * baseline).
 *
 * @param projectRoot - Absolute path to the CLEO project root
 * @param params - Context pack parameters
 * @returns Bounded context pack with omission tracking
 *
 * @task T10629
 * @task T10630
 */
export async function coreTaskContext(
  projectRoot: string,
  params: TasksContextParams,
): Promise<TasksContextResult> {
  const budgetTokens = clampPositiveInteger(params.budgetTokens, DEFAULT_BUDGET_TOKENS);
  const includeAcceptance = params.includeAcceptance ?? true;
  const includeBlockers = params.includeBlockers ?? true;
  const includeDocs = params.includeDocs ?? true;
  const includeEdges = params.includeEdges ?? true;
  const includeActivity = params.includeActivity ?? true;
  const activityLimit = clampPositiveInteger(params.activityLimit, DEFAULT_ACTIVITY_LIMIT);
  const edgeDepth = clampPositiveInteger(params.edgeDepth, DEFAULT_EDGE_DEPTH);
  const scope = params.scope;

  const accessor = await getTaskAccessor(projectRoot);
  const { task } = await loadTaskWithAccessor(params.taskId, accessor);

  const omissions: TasksContextOmission[] = [];
  const expansionHints: Record<string, string> = {};
  let estimatedTokens = 0;

  const identity = await buildIdentity(task);
  estimatedTokens += estimateObjectTokens(identity);

  // ── Scope-aware data (T10630) ─────────────────────────────────────────
  let rollup: TasksScopeRollup | undefined;
  let members: TasksScopeMember[] | undefined;
  let readyFrontier: TasksScopeReadyEntry[] | undefined;

  if (scope === 'saga' && isSagaShaped(task)) {
    try {
      const sagaData = await buildSagaScope(projectRoot, task, accessor);
      rollup = sagaData.rollup;
      members = sagaData.members;
      readyFrontier = sagaData.readyFrontier;
    } catch {
      omissions.push(
        makeOmission(
          'rollup',
          'not_available',
          'Saga rollup unavailable: failed to resolve member epics',
          undefined,
          `cleo saga rollup ${task.id}`,
        ),
      );
    }
  } else if (scope === 'epic' && task.type === 'epic') {
    try {
      const epicData = await buildEpicScope(projectRoot, task, accessor);
      rollup = epicData.rollup;
      readyFrontier = epicData.readyFrontier;
    } catch {
      omissions.push(
        makeOmission(
          'rollup',
          'not_available',
          'Epic rollup unavailable: failed to resolve child tasks',
          undefined,
          `cleo orchestrate status ${task.id}`,
        ),
      );
    }
  }

  // Budget rollup data
  if (rollup !== undefined) {
    const rollupTokens = estimateObjectTokens(rollup);
    if (estimatedTokens + rollupTokens <= budgetTokens) {
      estimatedTokens += rollupTokens;
    } else {
      omissions.push(
        makeOmission(
          'rollup',
          'budget_exceeded',
          `Rollup summary omitted: exceeds remaining budget`,
          undefined,
          scope === 'saga'
            ? `cleo saga rollup ${task.id}`
            : `cleo orchestrate status ${task.id}`,
        ),
      );
      rollup = undefined;
    }
  }

  if (members !== undefined && members.length > 0) {
    const memberTokens = estimateObjectTokens(members);
    if (estimatedTokens + memberTokens <= budgetTokens) {
      estimatedTokens += memberTokens;
    } else {
      omissions.push(
        makeOmission(
          'members',
          'budget_exceeded',
          `Saga members (${members.length}) omitted: exceed remaining budget`,
          members.length,
          `cleo saga members ${task.id}`,
        ),
      );
      members = undefined;
    }
  }

  if (readyFrontier !== undefined && readyFrontier.length > 0) {
    const frontierTokens = estimateObjectTokens(readyFrontier);
    if (estimatedTokens + frontierTokens <= budgetTokens) {
      estimatedTokens += frontierTokens;
    } else {
      omissions.push(
        makeOmission(
          'readyFrontier',
          'budget_exceeded',
          `Ready frontier (${readyFrontier.length} tasks) omitted: exceeds remaining budget`,
          readyFrontier.length,
          scope === 'saga'
            ? `cleo orchestrate ready ${task.id}`
            : `cleo orchestrate ready ${task.id}`,
        ),
      );
      readyFrontier = undefined;
    }
  }

  // ── Per-task sections (existing T10629 behaviour) ─────────────────────

  let acceptance: TasksContextAcceptanceEntry[] | undefined;
  if (includeAcceptance) {
    const acEntries = await buildAcceptance(task);
    const acTokens = estimateObjectTokens(acEntries);
    if (estimatedTokens + acTokens <= budgetTokens) {
      acceptance = acEntries;
      estimatedTokens += acTokens;
    } else {
      omissions.push(
        makeOmission(
          'acceptance',
          'budget_exceeded',
          `Acceptance criteria omitted: ${acEntries.length} criteria exceed remaining budget`,
          acEntries.length,
        ),
      );
      expansionHints['acceptance'] = `Re-run with higher budgetTokens to include ${acEntries.length} acceptance criteria`;
    }
  } else {
    omissions.push(makeOmission('acceptance', 'not_requested', 'Acceptance criteria excluded by includeAcceptance=false'));
  }

  let blockers: TasksContextBlockerEntry[] | undefined;
  if (includeBlockers) {
    const blockerEntries = await buildBlockers(task, accessor);
    const blockerTokens = estimateObjectTokens(blockerEntries);
    if (estimatedTokens + blockerTokens <= budgetTokens) {
      blockers = blockerEntries;
      estimatedTokens += blockerTokens;
    } else {
      omissions.push(
        makeOmission(
          'blockers',
          'budget_exceeded',
          `Blockers omitted: ${blockerEntries.length} blockers exceed remaining budget`,
          blockerEntries.length,
        ),
      );
      expansionHints['blockers'] = `Re-run with higher budgetTokens to include ${blockerEntries.length} blockers`;
    }
  } else {
    omissions.push(makeOmission('blockers', 'not_requested', 'Blockers excluded by includeBlockers=false'));
  }

  let docs: TasksContextDocEntry[] | undefined;
  if (includeDocs) {
    const docEntries = await buildDocs(task, accessor);
    const docTokens = estimateObjectTokens(docEntries);
    if (estimatedTokens + docTokens <= budgetTokens) {
      docs = docEntries;
      estimatedTokens += docTokens;
    } else {
      omissions.push(
        makeOmission(
          'docs',
          'budget_exceeded',
          `Docs omitted: ${docEntries.length} docs exceed remaining budget`,
          docEntries.length,
        ),
      );
      expansionHints['docs'] = `Re-run with higher budgetTokens to include ${docEntries.length} attached docs`;
    }
  } else {
    omissions.push(makeOmission('docs', 'not_requested', 'Docs excluded by includeDocs=false'));
  }

  let edges: TasksContextResult['edges'] | undefined;
  if (includeEdges) {
    const { edges: edgeData, slice } = await buildEdges(projectRoot, task.id, edgeDepth, true);
    const edgeTokens = estimateObjectTokens(edgeData);
    if (estimatedTokens + edgeTokens <= budgetTokens) {
      edges = edgeData;
      estimatedTokens += edgeTokens;
    } else {
      const upstreamCount = slice.upstream.length;
      const downstreamCount = slice.downstream.length;
      const siblingCount = slice.siblings.length;
      const relatedCount = slice.related?.length ?? 0;
      omissions.push(
        makeOmission(
          'edges',
          'budget_exceeded',
          `Graph edges omitted: ${upstreamCount} upstream, ${downstreamCount} downstream, ${siblingCount} siblings, ${relatedCount} related exceed remaining budget`,
          upstreamCount + downstreamCount + siblingCount + relatedCount,
        ),
      );
      expansionHints['edges'] = `Re-run with higher budgetTokens or reduce edgeDepth to include graph edges (upstream=${upstreamCount}, downstream=${downstreamCount}, siblings=${siblingCount}, related=${relatedCount})`;
    }
  } else {
    omissions.push(makeOmission('edges', 'not_requested', 'Graph edges excluded by includeEdges=false'));
  }

  let activity: TasksContextActivityEvent[] | undefined;
  if (includeActivity) {
    const activityEntries = await buildActivity(task.id, accessor, activityLimit);
    const activityTokens = estimateObjectTokens(activityEntries);
    if (estimatedTokens + activityTokens <= budgetTokens) {
      activity = activityEntries;
      estimatedTokens += activityTokens;
    } else {
      omissions.push(
        makeOmission(
          'activity',
          'budget_exceeded',
          `Activity omitted: ${activityEntries.length} events exceed remaining budget`,
          activityEntries.length,
        ),
      );
      expansionHints['activity'] = `Re-run with higher budgetTokens or reduce activityLimit to include ${activityEntries.length} activity events`;
    }
  } else {
    omissions.push(makeOmission('activity', 'not_requested', 'Activity excluded by includeActivity=false'));
  }

  const budget: TasksContextBudget = {
    tokenBudget: budgetTokens,
    estimatedTokens,
    remainingTokens: Math.max(0, budgetTokens - estimatedTokens),
    truncated: omissions.length > 0,
  };

  return {
    taskId: task.id,
    generatedAt: new Date().toISOString(),
    budget,
    identity,
    ...(acceptance ? { acceptance } : {}),
    ...(blockers ? { blockers } : {}),
    ...(docs ? { docs } : {}),
    ...(edges ? { edges } : {}),
    ...(activity ? { activity } : {}),
    ...(rollup ? { rollup } : {}),
    ...(members ? { members } : {}),
    ...(readyFrontier ? { readyFrontier } : {}),
    omissions,
    expansionHints,
  };
}
