/**
 * Core task non-CRUD operations - business logic extracted from task-engine.ts.
 *
 * These are pure business logic functions that throw on failure and return
 * data directly (no EngineResult wrapper). The engine layer wraps these
 * in try/catch to produce EngineResult.
 *
 * Covers: next, blockers, tree, deps, relates, relatesAdd, analyze, restore,
 * unarchive, reorder, reparent, promote, reopen, complexityEstimate, depends,
 * stats, export, history, lint, batchValidate, import
 *
 * @task T4790
 * @epic T4654
 */

import type {
  BottleneckTask,
  ProjectMeta,
  Task,
  TaskAnalysisResult,
  TaskDepsResult,
  TaskRef,
  TaskStatus,
} from '@cleocode/contracts';
import { TASK_STATUSES } from '@cleocode/contracts';
import { getAccessor } from '../store/data-accessor.js';
import { getDataPath, readJsonFile as storeReadJsonFile } from '../store/file-utils.js';
import { canCancel } from './cancel-ops.js';
import {
  detectCircularDeps,
  getBlockedTasks,
  getLeafBlockers,
  getReadyTasks,
  getTransitiveBlockers,
  validateDependencies,
} from './dependency-check.js';
import { depsReady } from './deps-ready.js';
import { isTerminalPipelineStage } from './pipeline-stage.js';

// ============================================================================
// Types (shared)
// ============================================================================

/** Task record shape expected from the data layer — alias for the contracts Task type. */
type TaskRecord = Task;

/** Tree node representation for task hierarchy. */
export interface FlatTreeNode {
  /** Unique task identifier (e.g. "T001"). */
  id: string;
  /** Human-readable task title. */
  title: string;
  /** Current task status (e.g. "pending", "done"). */
  status: string;
  /**
   * Task type classification.
   * @defaultValue "task"
   */
  type?: string;
  /** Child nodes in the hierarchy tree. */
  children: FlatTreeNode[];
}

/** Complexity factor contributing to a task's size estimate. */
export interface ComplexityFactor {
  /** Factor name (e.g. "descriptionLength", "dependencyDepth"). */
  name: string;
  /** Numeric score contribution from this factor. */
  value: number;
  /** Human-readable explanation of the score (e.g. "short (42 chars)"). */
  detail: string;
}

// ============================================================================
// Helpers
// ============================================================================

const PRIORITY_SCORE: Record<string, number> = {
  critical: 100,
  high: 75,
  medium: 50,
  low: 25,
};

async function loadAllTasks(projectRoot: string): Promise<TaskRecord[]> {
  const accessor = await getAccessor(projectRoot);
  const { tasks } = await accessor.queryTasks({});
  return tasks;
}

/**
 * Recursively build a tree node for a task, sorting children by position ASC.
 *
 * Children are sorted by their `position` field (null/undefined treated as 0)
 * using a stable comparison so equal positions preserve insertion order.
 *
 * @param task        - The task to build a node for.
 * @param childrenMap - Map of parentId to ordered child list.
 */
function buildTreeNode(task: TaskRecord, childrenMap: Map<string, TaskRecord[]>): FlatTreeNode {
  const rawChildren = childrenMap.get(task.id) ?? [];
  // Sort children by position ASC; treat null/undefined as 0 for stable ordering.
  const sortedChildren = [...rawChildren].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const children = sortedChildren.map((child) => buildTreeNode(child, childrenMap));
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    type: task.type,
    children,
  };
}

function buildUpstreamTree(
  taskId: string,
  taskMap: Map<string, TaskRecord>,
  visited: Set<string> = new Set(),
): FlatTreeNode[] {
  const task = taskMap.get(taskId);
  if (!task?.depends?.length) return [];

  const nodes: FlatTreeNode[] = [];
  for (const depId of task.depends) {
    if (visited.has(depId)) continue;
    visited.add(depId);

    const dep = taskMap.get(depId);
    if (!dep) continue;

    nodes.push({
      id: dep.id,
      title: dep.title,
      status: dep.status,
      type: dep.type,
      children: buildUpstreamTree(depId, taskMap, visited),
    });
  }
  return nodes;
}

function countNodes(nodes: FlatTreeNode[]): number {
  let count = nodes.length;
  for (const node of nodes) {
    count += countNodes(node.children);
  }
  return count;
}

function measureDependencyDepth(
  taskId: string,
  taskMap: Map<string, TaskRecord>,
  visited: Set<string> = new Set(),
): number {
  if (visited.has(taskId)) return 0;
  visited.add(taskId);

  const task = taskMap.get(taskId);
  if (!task?.depends || task.depends.length === 0) return 0;

  let maxDepth = 0;
  for (const depId of task.depends) {
    const depth = 1 + measureDependencyDepth(depId, taskMap, visited);
    if (depth > maxDepth) maxDepth = depth;
  }
  return maxDepth;
}

function getHierarchyLimits(projectRoot: string): { maxDepth: number; maxSiblings: number } {
  const configPath = getDataPath(projectRoot, 'config.json');
  const config = storeReadJsonFile<Record<string, unknown>>(configPath);

  let maxDepth = 3;
  let maxSiblings = 0;

  if (config) {
    const hierarchy = config.hierarchy as Record<string, unknown> | undefined;
    if (hierarchy) {
      if (typeof hierarchy.maxDepth === 'number') maxDepth = hierarchy.maxDepth;
      if (typeof hierarchy.maxSiblings === 'number') maxSiblings = hierarchy.maxSiblings;
    }
  }

  return { maxDepth, maxSiblings };
}

// ============================================================================
// taskNext
// ============================================================================

/**
 * Suggest next task to work on based on priority, phase, age, and deps.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param params - Optional scoring configuration
 * @param params.count - Number of suggestions to return (default: 1)
 * @param params.explain - When true, include scoring reasons in each suggestion
 * @returns Ranked suggestions with scores and the total number of eligible candidates
 *
 * @remarks
 * Scoring considers priority weight, current phase alignment, dependency readiness,
 * task age, and brain success/failure pattern matches. Results are sorted descending by score.
 *
 * @example
 * ```typescript
 * const { suggestions } = await coreTaskNext('/project', { count: 3, explain: true });
 * console.log(suggestions[0].id, suggestions[0].score);
 * ```
 *
 * @task T4790
 */
export async function coreTaskNext(
  projectRoot: string,
  params?: { count?: number; explain?: boolean },
): Promise<{
  suggestions: Array<{
    id: string;
    title: string;
    priority: string;
    phase: string | null;
    score: number;
    reasons?: string[];
  }>;
  totalCandidates: number;
}> {
  const accessor = await getAccessor(projectRoot);
  const allTasks = await loadAllTasks(projectRoot);
  const taskMap = new Map(allTasks.map((t) => [t.id, t]));

  const projectMeta = await accessor.getMetaValue<ProjectMeta>('project_meta');
  const currentPhase = projectMeta?.currentPhase ?? null;

  const candidates = allTasks.filter(
    (t) => t.status === 'pending' && !t.cancelledAt && depsReady(t.depends, taskMap),
  );

  if (candidates.length === 0) {
    return { suggestions: [], totalCandidates: 0 };
  }

  const scored = candidates
    .map((task) => {
      const reasons: string[] = [];
      let score = 0;

      score += PRIORITY_SCORE[task.priority] ?? 50;
      reasons.push(`priority: ${task.priority} (+${PRIORITY_SCORE[task.priority] ?? 50})`);

      if (currentPhase && task.phase === currentPhase) {
        score += 20;
        reasons.push(`phase alignment: ${currentPhase} (+20)`);
      }

      if (depsReady(task.depends, taskMap)) {
        score += 10;
        reasons.push('all dependencies satisfied (+10)');
      }

      if (task.createdAt) {
        const ageMs = Date.now() - new Date(task.createdAt).getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        if (ageDays > 7) {
          const ageBonus = Math.min(15, Math.floor(ageDays / 7));
          score += ageBonus;
          reasons.push(`age: ${Math.floor(ageDays)} days (+${ageBonus})`);
        }
      }

      return { task, score, reasons };
    })
    .sort((a, b) => b.score - a.score);

  // Brain pattern scoring (best-effort)
  try {
    const { searchPatterns } = await import('../memory/patterns.js');
    const [successPatterns, failurePatterns] = await Promise.all([
      searchPatterns(projectRoot, { type: 'success', limit: 20 }),
      searchPatterns(projectRoot, { type: 'failure', limit: 20 }),
    ]);

    if (successPatterns.length > 0 || failurePatterns.length > 0) {
      for (const item of scored) {
        const titleLower = item.task.title.toLowerCase();
        const labels = (item.task.labels ?? []).map((l: string) => l.toLowerCase());
        const matchText = [titleLower, ...labels].join(' ');

        for (const sp of successPatterns) {
          if (matchText.includes(sp.pattern.toLowerCase())) {
            item.score += 10;
            item.reasons.push(`brain: success pattern match "${sp.pattern}" (+10)`);
            break;
          }
        }
        for (const fp of failurePatterns) {
          if (matchText.includes(fp.pattern.toLowerCase())) {
            item.score -= 5;
            item.reasons.push(`brain: failure pattern match "${fp.pattern}" (-5)`);
            break;
          }
        }
      }
      scored.sort((a, b) => b.score - a.score);
    }
  } catch {
    // Brain pattern scoring is best-effort
  }

  const count = Math.min(params?.count || 1, scored.length);
  const explain = params?.explain ?? false;

  const suggestions = scored.slice(0, count).map(({ task, score, reasons }) => ({
    id: task.id,
    title: task.title,
    priority: task.priority,
    phase: task.phase ?? null,
    score,
    ...(explain && { reasons }),
  }));

  return { suggestions, totalCandidates: candidates.length };
}

// ============================================================================
// taskBlockers
// ============================================================================

/**
 * Show blocked tasks and analyze blocking chains.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param params - Optional analysis configuration
 * @param params.analyze - When true, compute transitive blocking chains
 * @param params.limit - Maximum number of blocked tasks to return (default: 20)
 * @returns Blocked tasks with optional blocking chains, critical bottleneck tasks, and a summary
 *
 * @remarks
 * Collects both explicitly blocked tasks and dependency-blocked pending tasks.
 * Critical blockers are the top 5 tasks that appear most frequently in blocking chains.
 *
 * @example
 * ```typescript
 * const result = await coreTaskBlockers('/project', { analyze: true, limit: 10 });
 * console.log(result.summary, result.criticalBlockers);
 * ```
 *
 * @task T4790
 */
export async function coreTaskBlockers(
  projectRoot: string,
  params?: { analyze?: boolean; limit?: number },
): Promise<{
  blockedTasks: Array<{
    id: string;
    title: string;
    status: string;
    depends?: string[];
    blockingChain: string[];
  }>;
  criticalBlockers: BottleneckTask[];
  summary: string;
  total: number;
  limit: number;
}> {
  const allTasks = await loadAllTasks(projectRoot);
  const taskMap = new Map(allTasks.map((t) => [t.id, t]));
  const analyze = params?.analyze ?? false;
  const effectiveLimit = params?.limit ?? 20;

  const blockedTasks = allTasks.filter((t) => t.status === 'blocked');

  const depBlockedTasks = allTasks.filter(
    (t) =>
      t.status === 'pending' &&
      t.depends &&
      t.depends.length > 0 &&
      t.depends.some((depId) => {
        const dep = taskMap.get(depId);
        return dep && dep.status !== 'done' && dep.status !== 'cancelled';
      }),
  );

  const tasksAsTask = allTasks;
  const blockerInfos = [
    ...blockedTasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      depends: t.depends,
      blockingChain: analyze ? getTransitiveBlockers(t.id, tasksAsTask) : [],
    })),
    ...depBlockedTasks
      .filter((t) => !blockedTasks.some((bt) => bt.id === t.id))
      .map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        depends: t.depends,
        blockingChain: analyze ? getTransitiveBlockers(t.id, tasksAsTask) : [],
      })),
  ];

  const total = blockerInfos.length;
  const pagedBlockerInfos = blockerInfos.slice(0, effectiveLimit);

  const blockerCounts = new Map<string, number>();
  for (const info of pagedBlockerInfos) {
    for (const depId of info.blockingChain) {
      blockerCounts.set(depId, (blockerCounts.get(depId) ?? 0) + 1);
    }
  }

  const criticalBlockers = [...blockerCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, count]) => {
      const task = taskMap.get(id);
      return { id, title: task?.title ?? 'Unknown', blocksCount: count };
    });

  return {
    blockedTasks: pagedBlockerInfos,
    criticalBlockers,
    summary: total === 0 ? 'No blocked tasks found' : `${total} blocked task(s)`,
    total,
    limit: effectiveLimit,
  };
}

// ============================================================================
// taskTree
// ============================================================================

/**
 * Build hierarchy tree for tasks.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param taskId - Optional root task ID; when provided, builds the subtree rooted at this task
 * @returns The tree nodes and total node count
 *
 * @remarks
 * When no taskId is given, returns all root-level tasks with their full subtrees.
 * When a taskId is given, returns that single task as the root with its descendants.
 *
 * @example
 * ```typescript
 * const { tree, totalNodes } = await coreTaskTree('/project', 'T042');
 * console.log(`${totalNodes} nodes in subtree`);
 * ```
 *
 * @task T4790
 */
export async function coreTaskTree(
  projectRoot: string,
  taskId?: string,
): Promise<{ tree: FlatTreeNode[]; totalNodes: number }> {
  const allTasks = await loadAllTasks(projectRoot);

  if (taskId) {
    const task = allTasks.find((t) => t.id === taskId);
    if (!task) {
      throw new Error(`Task '${taskId}' not found`);
    }
  }

  const childrenMap = new Map<string, TaskRecord[]>();
  for (const task of allTasks) {
    const parentKey = task.parentId ?? '__root__';
    if (!childrenMap.has(parentKey)) {
      childrenMap.set(parentKey, []);
    }
    childrenMap.get(parentKey)!.push(task);
  }

  let roots: TaskRecord[];
  if (taskId) {
    roots = [allTasks.find((t) => t.id === taskId)!];
  } else {
    roots = childrenMap.get('__root__') ?? [];
  }

  const tree = roots.map((root) => buildTreeNode(root, childrenMap));

  return { tree, totalNodes: countNodes(tree) };
}

// ============================================================================
// taskDeps
// ============================================================================

/**
 * Show dependencies for a task.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param taskId - The task ID to inspect dependencies for
 * @returns Upstream and downstream dependencies, unresolved deps, and readiness flag
 *
 * @remarks
 * Returns both the tasks this task depends on (upstream) and the tasks that depend
 * on it (downstream). Unresolved deps are those not yet done or cancelled.
 *
 * @example
 * ```typescript
 * const deps = await coreTaskDeps('/project', 'T100');
 * if (!deps.allDepsReady) console.log('Blocked by:', deps.unresolvedDeps);
 * ```
 *
 * @task T4790
 */
export async function coreTaskDeps(projectRoot: string, taskId: string): Promise<TaskDepsResult> {
  const allTasks = await loadAllTasks(projectRoot);
  const task = allTasks.find((t) => t.id === taskId);
  if (!task) {
    throw new Error(`Task '${taskId}' not found`);
  }

  const taskMap = new Map(allTasks.map((t) => [t.id, t]));
  const completedIds = new Set(
    allTasks.filter((t) => t.status === 'done' || t.status === 'cancelled').map((t) => t.id),
  );

  const dependsOn = (task.depends ?? [])
    .map((depId) => {
      const dep = taskMap.get(depId);
      return dep ? { id: dep.id, title: dep.title, status: dep.status } : null;
    })
    .filter((d) => d !== null);

  const dependedOnBy = allTasks
    .filter((t) => t.depends?.includes(taskId))
    .map((t) => ({ id: t.id, title: t.title, status: t.status }));

  const unresolvedDeps = (task.depends ?? []).filter((depId) => !completedIds.has(depId));

  return {
    taskId,
    dependsOn,
    dependedOnBy,
    unresolvedDeps,
    allDepsReady: unresolvedDeps.length === 0,
  };
}

// ============================================================================
// taskRelates
// ============================================================================

/**
 * Show task relations.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param taskId - The task ID to retrieve relations for
 * @returns The task's relations array and count
 *
 * @remarks
 * Relations are non-dependency links between tasks (e.g. "related-to", "duplicates").
 * Unlike dependencies, relations do not affect blocking or scheduling.
 *
 * @example
 * ```typescript
 * const { relations, count } = await coreTaskRelates('/project', 'T050');
 * console.log(`${count} relations found`);
 * ```
 *
 * @task T4790
 */
export async function coreTaskRelates(
  projectRoot: string,
  taskId: string,
): Promise<{
  taskId: string;
  relations: Array<{ taskId: string; type: string; reason?: string }>;
  count: number;
}> {
  const allTasks = await loadAllTasks(projectRoot);
  const task = allTasks.find((t) => t.id === taskId);
  if (!task) {
    throw new Error(`Task '${taskId}' not found`);
  }

  const relations = task.relates ?? [];
  return { taskId, relations, count: relations.length };
}

// ============================================================================
// taskRelatesAdd
// ============================================================================

/**
 * Add a relation between two tasks.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param taskId - The source task ID
 * @param relatedId - The target task ID to relate to
 * @param type - Relation type (e.g. "related-to", "duplicates", "blocks")
 * @param reason - Optional human-readable reason for the relation
 * @returns Confirmation of the added relation with source, target, and type
 *
 * @remarks
 * Persists the relation both on the task's `relates` array and in the
 * `task_relations` table for bidirectional querying.
 *
 * @example
 * ```typescript
 * const result = await coreTaskRelatesAdd('/project', 'T010', 'T020', 'related-to', 'Shared scope');
 * console.log(result.added); // true
 * ```
 *
 * @task T4790
 */
export async function coreTaskRelatesAdd(
  projectRoot: string,
  taskId: string,
  relatedId: string,
  type: string,
  reason?: string,
): Promise<{ from: string; to: string; type: string; reason?: string; added: boolean }> {
  const accessor = await getAccessor(projectRoot);

  const fromTask = await accessor.loadSingleTask(taskId);
  if (!fromTask) {
    throw new Error(`Task '${taskId}' not found`);
  }

  const toExists = await accessor.taskExists(relatedId);
  if (!toExists) {
    throw new Error(`Task '${relatedId}' not found`);
  }

  if (!fromTask.relates) {
    fromTask.relates = [];
  }

  fromTask.relates.push({
    taskId: relatedId,
    type,
    reason: reason || undefined,
  });

  fromTask.updatedAt = new Date().toISOString();
  await accessor.upsertSingleTask(fromTask);

  // Persist to task_relations table (T5168)
  await accessor.addRelation(taskId, relatedId, type, reason);

  return { from: taskId, to: relatedId, type, reason, added: true };
}

// ============================================================================
// taskAnalyze
// ============================================================================

/**
 * Analyze tasks for priority and leverage.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param taskId - Optional task or epic ID to scope the analysis; omit for project-wide
 * @param params - Optional analysis configuration
 * @param params.tierLimit - Maximum tasks per priority tier in the response (default: 10)
 * @returns Analysis with recommended next task, bottlenecks, priority tiers, and aggregate metrics
 *
 * @remarks
 * Computes a leverage score per task (how many other tasks it unblocks) and combines
 * it with priority to produce a ranked recommendation. Bottlenecks are the top 5
 * incomplete tasks that block the most others.
 *
 * @example
 * ```typescript
 * const analysis = await coreTaskAnalyze('/project', undefined, { tierLimit: 5 });
 * if (analysis.recommended) console.log('Work on:', analysis.recommended.id);
 * ```
 *
 * @task T4790
 */
export async function coreTaskAnalyze(
  projectRoot: string,
  taskId?: string,
  params?: { tierLimit?: number },
): Promise<TaskAnalysisResult & { tierLimit: number }> {
  const allTasks = await loadAllTasks(projectRoot);
  const effectiveTierLimit = params?.tierLimit ?? 10;

  const tasks = taskId
    ? allTasks.filter((t) => t.id === taskId || t.parentId === taskId)
    : allTasks;

  const blocksMap: Record<string, string[]> = {};
  for (const task of tasks) {
    if (task.depends) {
      for (const dep of task.depends) {
        if (!blocksMap[dep]) blocksMap[dep] = [];
        blocksMap[dep]!.push(task.id);
      }
    }
  }

  const leverageMap: Record<string, number> = {};
  for (const task of tasks) {
    leverageMap[task.id] = (blocksMap[task.id] ?? []).length;
  }

  const actionable = tasks.filter((t) => t.status === 'pending' || t.status === 'active');
  const blocked = tasks.filter((t) => t.status === 'blocked');

  const bottlenecks = tasks
    .filter((t) => (blocksMap[t.id]?.length ?? 0) > 0 && t.status !== 'done')
    .map((t) => ({ id: t.id, title: t.title, blocksCount: blocksMap[t.id]!.length }))
    .sort((a, b) => b.blocksCount - a.blocksCount)
    .slice(0, 5);

  const scored = actionable.map((t) => ({
    id: t.id,
    title: t.title,
    leverage: leverageMap[t.id] ?? 0,
    priority: t.priority,
  }));

  scored.sort((a, b) => {
    const priorityWeight: Record<string, number> = { critical: 100, high: 50, medium: 20, low: 5 };
    const aScore = (priorityWeight[a.priority ?? 'medium'] ?? 20) + a.leverage * 10;
    const bScore = (priorityWeight[b.priority ?? 'medium'] ?? 20) + b.leverage * 10;
    return bScore - aScore;
  });

  const critical = scored.filter((t) => t.priority === 'critical');
  const high = scored.filter((t) => t.priority === 'high');
  const normal = scored.filter((t) => t.priority !== 'critical' && t.priority !== 'high');

  const recommended =
    scored.length > 0
      ? {
          id: scored[0]!.id,
          title: scored[0]!.title,
          leverage: scored[0]!.leverage,
          reason: 'Highest combined priority and leverage score',
        }
      : null;

  const totalLeverage = Object.values(leverageMap).reduce((s, v) => s + v, 0);
  const avgLeverage = tasks.length > 0 ? Math.round((totalLeverage / tasks.length) * 100) / 100 : 0;

  return {
    recommended,
    bottlenecks,
    tiers: {
      critical: critical
        .slice(0, effectiveTierLimit)
        .map(({ id, title, leverage }) => ({ id, title, leverage })),
      high: high
        .slice(0, effectiveTierLimit)
        .map(({ id, title, leverage }) => ({ id, title, leverage })),
      normal: normal
        .slice(0, effectiveTierLimit)
        .map(({ id, title, leverage }) => ({ id, title, leverage })),
    },
    metrics: {
      totalTasks: tasks.length,
      actionable: actionable.length,
      blocked: blocked.length,
      avgLeverage,
    },
    tierLimit: effectiveTierLimit,
  };
}

// ============================================================================
// taskRestore
// ============================================================================

/**
 * Restore a cancelled task back to pending.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param taskId - The cancelled task ID to restore
 * @param params - Optional restore options
 * @param params.cascade - When true, also restores cancelled child tasks recursively
 * @param params.notes - Optional note appended to each restored task's notes array
 * @returns The task ID, list of restored task IDs, and total count
 *
 * @remarks
 * Only tasks with status "cancelled" can be restored. Restored tasks are set to
 * "pending" with cancellation metadata cleared. A timestamped note is appended.
 *
 * @example
 * ```typescript
 * const { restored, count } = await coreTaskRestore('/project', 'T099', { cascade: true });
 * console.log(`Restored ${count} tasks:`, restored);
 * ```
 *
 * @task T4790
 */
export async function coreTaskRestore(
  projectRoot: string,
  taskId: string,
  params?: { cascade?: boolean; notes?: string },
): Promise<{ task: string; restored: string[]; count: number }> {
  const accessor = await getAccessor(projectRoot);

  const task = await accessor.loadSingleTask(taskId);
  if (!task) {
    throw new Error(`Task '${taskId}' not found`);
  }

  if (task.status !== 'cancelled') {
    throw new Error(
      `Task '${taskId}' is not cancelled (status: ${task.status}). Only cancelled tasks can be restored.`,
    );
  }

  const tasksToRestore: TaskRecord[] = [task];
  if (params?.cascade) {
    const findCancelledChildren = async (parentId: string): Promise<void> => {
      const children = await accessor.getChildren(parentId);
      const cancelledChildren = children.filter((t) => t.status === 'cancelled');
      for (const child of cancelledChildren) {
        tasksToRestore.push(child);
        await findCancelledChildren(child.id);
      }
    };
    await findCancelledChildren(taskId);
  }

  const now = new Date().toISOString();
  const restored: string[] = [];

  for (const t of tasksToRestore) {
    t.status = 'pending';
    t.cancelledAt = undefined;
    t.cancellationReason = undefined;
    t.updatedAt = now;
    // T871: when a task was cancelled, pipelineStage was advanced to the
    // terminal `cancelled` marker. On restore we re-enter the active chain
    // — reset to a sensible default so `updateTask`'s forward-only
    // validator doesn't treat the task as permanently terminal.
    if (t.pipelineStage === 'cancelled') {
      t.pipelineStage = t.type === 'epic' ? 'research' : 'implementation';
    }

    if (!t.notes) t.notes = [];
    t.notes.push(`[${now}] Restored from cancelled${params?.notes ? ': ' + params.notes : ''}`);
    restored.push(t.id);
  }

  for (const t of tasksToRestore) {
    await accessor.upsertSingleTask(t);
  }

  return { task: taskId, restored, count: restored.length };
}

// ============================================================================
// taskCancel
// ============================================================================

/**
 * Cancel a task (sets status to 'cancelled', a soft terminal state).
 * Use restore to reverse. Use delete for permanent removal.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param taskId - The task ID to cancel
 * @param params - Optional cancel options
 * @param params.reason - Human-readable cancellation reason stored on the task
 * @returns Confirmation with cancelled flag and timestamp
 *
 * @remarks
 * Cancellation is a soft terminal state -- the task remains in the database and
 * can be restored via {@link coreTaskRestore}. Not all statuses are cancellable;
 * the `canCancel` guard determines eligibility.
 *
 * @example
 * ```typescript
 * const result = await coreTaskCancel('/project', 'T077', { reason: 'Superseded by T080' });
 * console.log(result.cancelledAt);
 * ```
 *
 * @task T4529
 */
export async function coreTaskCancel(
  projectRoot: string,
  taskId: string,
  params?: { reason?: string },
): Promise<{ task: string; cancelled: boolean; reason?: string; cancelledAt: string }> {
  const accessor = await getAccessor(projectRoot);
  const task = await accessor.loadSingleTask(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  const check = canCancel(task);
  if (!check.allowed) {
    throw new Error(check.reason!);
  }

  const cancelledAt = new Date().toISOString();
  task.status = 'cancelled';
  task.cancelledAt = cancelledAt;
  task.cancellationReason = params?.reason ?? undefined;
  task.updatedAt = cancelledAt;
  // T871: keep status and pipelineStage in lock-step. Cancelled tasks must
  // leave the active RCASD-IVTR+C chain so Studio Pipeline routes them to
  // the dedicated CANCELLED column instead of lingering in research/
  // implementation/release.
  if (!isTerminalPipelineStage(task.pipelineStage)) {
    task.pipelineStage = 'cancelled';
  }
  await accessor.upsertSingleTask(task);

  return { task: taskId, cancelled: true, reason: params?.reason, cancelledAt };
}

// ============================================================================
// taskUnarchive
// ============================================================================

/**
 * Move an archived task back to active tasks.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param taskId - The archived task ID to unarchive
 * @param params - Optional unarchive options
 * @param params.status - Target status for the restored task (default: "pending")
 * @param params.preserveStatus - When true, keeps the task's original archived status
 * @returns Confirmation with task ID, title, and resulting status
 *
 * @remarks
 * Removes the task from the archive file and upserts it into the active task store.
 * Throws if the task already exists in active tasks or is not found in the archive.
 *
 * @example
 * ```typescript
 * const result = await coreTaskUnarchive('/project', 'T055', { status: 'active' });
 * console.log(`${result.title} is now ${result.status}`);
 * ```
 *
 * @task T4790
 */
export async function coreTaskUnarchive(
  projectRoot: string,
  taskId: string,
  params?: { status?: string; preserveStatus?: boolean },
): Promise<{ task: string; unarchived: boolean; title: string; status: string }> {
  const accessor = await getAccessor(projectRoot);

  // Check if task already exists in active tasks
  const existingTask = await accessor.taskExists(taskId);
  if (existingTask) {
    throw new Error(`Task '${taskId}' already exists in active tasks`);
  }

  const archive = await accessor.loadArchive();
  if (!archive?.archivedTasks) {
    throw new Error('No archive file found');
  }

  const taskIndex = archive.archivedTasks.findIndex((t) => t.id === taskId);
  if (taskIndex === -1) {
    throw new Error(`Task '${taskId}' not found in archive`);
  }

  const task = archive.archivedTasks[taskIndex]!;

  // Remove archive metadata if present on the raw record
  if ('_archive' in task) {
    Reflect.deleteProperty(task, '_archive');
  }

  if (!params?.preserveStatus) {
    const rawStatus = params?.status || 'pending';
    if (!(TASK_STATUSES as readonly string[]).includes(rawStatus)) {
      throw new Error(`Invalid status: ${rawStatus}`);
    }
    // rawStatus is validated above as a member of TASK_STATUSES
    const targetStatus = rawStatus as TaskStatus;
    if (targetStatus !== 'done') {
      task.completedAt = undefined;
    }
  }

  task.updatedAt = new Date().toISOString();

  // Fine-grained: upsert the restored task (now active)
  await accessor.upsertSingleTask(task);

  return { task: taskId, unarchived: true, title: task.title, status: task.status };
}

// ============================================================================
// taskReorder
// ============================================================================

/**
 * Change task position within its sibling group.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param taskId - The task ID to reorder
 * @param position - Target 1-based position within the sibling group
 * @returns Confirmation with the new position and total sibling count
 *
 * @remarks
 * Reorders by adjusting `position` and `positionVersion` fields on all siblings.
 * Position is clamped to valid bounds. Uses bulk field updates for efficiency.
 *
 * @example
 * ```typescript
 * const result = await coreTaskReorder('/project', 'T012', 1);
 * console.log(`Moved to position ${result.newPosition} of ${result.totalSiblings}`);
 * ```
 *
 * @task T4790
 */
export async function coreTaskReorder(
  projectRoot: string,
  taskId: string,
  position: number,
): Promise<{ task: string; reordered: boolean; newPosition: number; totalSiblings: number }> {
  const accessor = await getAccessor(projectRoot);

  const task = await accessor.loadSingleTask(taskId);
  if (!task) {
    throw new Error(`Task '${taskId}' not found`);
  }

  // Get siblings: tasks with same parentId
  const parentFilter = task.parentId ? { parentId: task.parentId } : {};
  const { tasks: siblingCandidates } = await accessor.queryTasks(parentFilter);
  // For root-level tasks (no parentId), filter to only those without a parentId
  const allSiblings = task.parentId
    ? siblingCandidates.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    : siblingCandidates
        .filter((t) => !t.parentId)
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  const currentIndex = allSiblings.findIndex((t) => t.id === taskId);
  const newIndex = Math.max(0, Math.min(position - 1, allSiblings.length - 1));

  allSiblings.splice(currentIndex, 1);
  allSiblings.splice(newIndex, 0, task);

  // Use bulk SQL for position updates (T025) — updateTaskFields is lighter than upsertSingleTask
  const now = new Date().toISOString();
  for (let i = 0; i < allSiblings.length; i++) {
    const sibling = allSiblings[i]!;
    const newPos = i + 1;
    const newVersion = ((sibling.positionVersion as number | undefined) ?? 0) + 1;
    // Only update if position actually changed
    if (sibling.position !== newPos || sibling.id === taskId) {
      await accessor.updateTaskFields(sibling.id, {
        position: newPos,
        positionVersion: newVersion,
        updatedAt: now,
      });
    }
    sibling.position = newPos;
    sibling.positionVersion = newVersion;
    sibling.updatedAt = now;
  }

  return {
    task: taskId,
    reordered: true,
    newPosition: newIndex + 1,
    totalSiblings: allSiblings.length,
  };
}

// ============================================================================
// taskReparent
// ============================================================================

/**
 * Move task under a different parent.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param taskId - The task ID to reparent
 * @param newParentId - The new parent task ID, or null to promote to root level
 * @returns Confirmation with old and new parent IDs and optional type change
 *
 * @remarks
 * Validates against circular references, depth limits, and sibling limits from
 * the project hierarchy config. Automatically adjusts task type based on new depth
 * (depth 1 = "task", depth >= 2 = "subtask").
 *
 * @example
 * ```typescript
 * const result = await coreTaskReparent('/project', 'T015', 'T010');
 * console.log(`Moved from ${result.oldParent} to ${result.newParent}`);
 * ```
 *
 * @task T4790
 */
export async function coreTaskReparent(
  projectRoot: string,
  taskId: string,
  newParentId: string | null,
): Promise<{
  task: string;
  reparented: boolean;
  oldParent: string | null;
  newParent: string | null;
  newType?: string;
}> {
  const accessor = await getAccessor(projectRoot);

  const task = await accessor.loadSingleTask(taskId);
  if (!task) {
    throw new Error(`Task '${taskId}' not found`);
  }

  const effectiveParentId = newParentId || null;

  if (!effectiveParentId) {
    const oldParent = task.parentId ?? null;
    task.parentId = null;
    if (task.type === 'subtask') task.type = 'task';
    task.updatedAt = new Date().toISOString();

    await accessor.upsertSingleTask(task);

    return { task: taskId, reparented: true, oldParent, newParent: null, newType: task.type };
  }

  const newParent = await accessor.loadSingleTask(effectiveParentId);
  if (!newParent) {
    throw new Error(`Parent task '${effectiveParentId}' not found`);
  }

  if (newParent.type === 'subtask') {
    throw new Error(`Cannot parent under subtask '${effectiveParentId}'`);
  }

  // Check circular reference using subtree
  const subtree = await accessor.getSubtree(taskId);
  if (subtree.some((t) => t.id === effectiveParentId)) {
    throw new Error(
      `Moving '${taskId}' under '${effectiveParentId}' would create circular reference`,
    );
  }

  // Check depth limit using ancestor chain
  const ancestors = await accessor.getAncestorChain(effectiveParentId);
  const parentDepth = ancestors.length;
  const reparentLimits = getHierarchyLimits(projectRoot);
  if (parentDepth + 1 >= reparentLimits.maxDepth) {
    throw new Error(`Move would exceed max depth of ${reparentLimits.maxDepth}`);
  }

  // Check sibling limit (0 = unlimited)
  const children = await accessor.getChildren(effectiveParentId);
  const siblingCount = children.filter((t) => t.id !== taskId).length;
  if (reparentLimits.maxSiblings > 0 && siblingCount >= reparentLimits.maxSiblings) {
    throw new Error(
      `Cannot add child to ${effectiveParentId}: max siblings (${reparentLimits.maxSiblings}) exceeded`,
    );
  }

  const oldParent = task.parentId ?? null;
  task.parentId = effectiveParentId;

  const newDepth = parentDepth + 1;
  if (newDepth === 1) task.type = 'task';
  else if (newDepth >= 2) task.type = 'subtask';

  task.updatedAt = new Date().toISOString();

  await accessor.upsertSingleTask(task);

  return {
    task: taskId,
    reparented: true,
    oldParent,
    newParent: effectiveParentId,
    newType: task.type,
  };
}

// ============================================================================
// taskPromote
// ============================================================================

/**
 * Promote a subtask to task or task to root.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param taskId - The task ID to promote
 * @returns Confirmation with previous parent and whether the type changed
 *
 * @remarks
 * Removes the task's parentId, making it a root-level task. If the task was
 * a "subtask", its type is changed to "task". No-op if the task is already root-level.
 *
 * @example
 * ```typescript
 * const result = await coreTaskPromote('/project', 'T025');
 * if (result.promoted) console.log('Detached from', result.previousParent);
 * ```
 *
 * @task T4790
 */
export async function coreTaskPromote(
  projectRoot: string,
  taskId: string,
): Promise<{
  task: string;
  promoted: boolean;
  previousParent: string | null;
  typeChanged: boolean;
}> {
  const accessor = await getAccessor(projectRoot);

  const task = await accessor.loadSingleTask(taskId);
  if (!task) {
    throw new Error(`Task '${taskId}' not found`);
  }

  if (!task.parentId) {
    return { task: taskId, promoted: false, previousParent: null, typeChanged: false };
  }

  const oldParent = task.parentId;
  task.parentId = null;
  task.updatedAt = new Date().toISOString();

  let typeChanged = false;
  if (task.type === 'subtask') {
    task.type = 'task';
    typeChanged = true;
  }

  await accessor.upsertSingleTask(task);

  return { task: taskId, promoted: true, previousParent: oldParent, typeChanged };
}

// ============================================================================
// taskReopen
// ============================================================================

/**
 * Reopen a completed task.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param taskId - The completed task ID to reopen
 * @param params - Optional reopen options
 * @param params.status - Target status after reopening ("pending" or "active", default: "pending")
 * @param params.reason - Optional reason appended to the task's notes
 * @returns Confirmation with previous and new status
 *
 * @remarks
 * Only tasks with status "done" can be reopened. Clears the `completedAt` timestamp
 * and appends a timestamped note recording the reopen event.
 *
 * @example
 * ```typescript
 * const result = await coreTaskReopen('/project', 'T033', { status: 'active', reason: 'Tests failed' });
 * console.log(`${result.previousStatus} -> ${result.newStatus}`);
 * ```
 *
 * @task T4790
 */
export async function coreTaskReopen(
  projectRoot: string,
  taskId: string,
  params?: { status?: string; reason?: string },
): Promise<{ task: string; reopened: boolean; previousStatus: string; newStatus: string }> {
  const accessor = await getAccessor(projectRoot);

  const task = await accessor.loadSingleTask(taskId);
  if (!task) {
    throw new Error(`Task '${taskId}' not found`);
  }

  if (task.status !== 'done') {
    throw new Error(
      `Task '${taskId}' is not completed (status: ${task.status}). Only done tasks can be reopened.`,
    );
  }

  const targetStatus = params?.status || 'pending';
  if (targetStatus !== 'pending' && targetStatus !== 'active') {
    throw new Error(`Invalid target status: ${targetStatus}. Must be 'pending' or 'active'.`);
  }

  const previousStatus = task.status;
  task.status = targetStatus as TaskStatus;
  task.completedAt = undefined;
  task.updatedAt = new Date().toISOString();

  if (!task.notes) task.notes = [];
  const reason = params?.reason;
  task.notes.push(
    `[${task.updatedAt}] Reopened from ${previousStatus}${reason ? ': ' + reason : ''}`,
  );

  await accessor.upsertSingleTask(task);

  return { task: taskId, reopened: true, previousStatus, newStatus: targetStatus };
}

// ============================================================================
// taskComplexityEstimate
// ============================================================================

/**
 * Deterministic complexity scoring from task metadata.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param params - Parameters containing the task ID to estimate
 * @param params.taskId - The task ID to compute complexity for
 * @returns Complexity size ("small"/"medium"/"large"), numeric score, contributing factors, and metadata counts
 *
 * @remarks
 * Scores are computed from description length, acceptance criteria count, dependency depth,
 * subtask count, and file reference count. Each factor contributes 0-3 points.
 * Total score 0-3 = small, 4-7 = medium, 8+ = large.
 *
 * @example
 * ```typescript
 * const est = await coreTaskComplexityEstimate('/project', { taskId: 'T042' });
 * console.log(`${est.size} (score: ${est.score})`);
 * ```
 *
 * @task T4790
 */
export async function coreTaskComplexityEstimate(
  projectRoot: string,
  params: { taskId: string },
): Promise<{
  size: 'small' | 'medium' | 'large';
  score: number;
  factors: ComplexityFactor[];
  dependencyDepth: number;
  subtaskCount: number;
  fileCount: number;
}> {
  const allTasks = await loadAllTasks(projectRoot);

  const task = allTasks.find((t) => t.id === params.taskId);
  if (!task) {
    throw new Error(`Task '${params.taskId}' not found`);
  }

  const factors: ComplexityFactor[] = [];
  let score = 0;

  const descLen = (task.description || '').length;
  let descScore: number;
  let descLabel: string;
  if (descLen < 100) {
    descScore = 1;
    descLabel = 'short';
  } else if (descLen < 500) {
    descScore = 2;
    descLabel = 'medium';
  } else {
    descScore = 3;
    descLabel = 'long';
  }
  score += descScore;
  factors.push({
    name: 'descriptionLength',
    value: descScore,
    detail: `${descLabel} (${descLen} chars)`,
  });

  const acceptanceCount = task.acceptance?.length ?? 0;
  const acceptanceScore = Math.min(acceptanceCount, 3);
  score += acceptanceScore;
  factors.push({
    name: 'acceptanceCriteria',
    value: acceptanceScore,
    detail: `${acceptanceCount} criteria`,
  });

  const taskMap = new Map(allTasks.map((t) => [t.id, t]));
  const dependencyDepth = measureDependencyDepth(params.taskId, taskMap);
  const depthScore = Math.min(dependencyDepth, 3);
  score += depthScore;
  factors.push({ name: 'dependencyDepth', value: depthScore, detail: `depth ${dependencyDepth}` });

  const subtaskCount = allTasks.filter((t) => t.parentId === params.taskId).length;
  const subtaskScore = Math.min(subtaskCount, 3);
  score += subtaskScore;
  factors.push({ name: 'subtaskCount', value: subtaskScore, detail: `${subtaskCount} subtasks` });

  const fileCount = task.files?.length ?? 0;
  const fileScore = Math.min(fileCount, 3);
  score += fileScore;
  factors.push({ name: 'fileReferences', value: fileScore, detail: `${fileCount} files` });

  let size: 'small' | 'medium' | 'large';
  if (score <= 3) size = 'small';
  else if (score <= 7) size = 'medium';
  else size = 'large';

  return { size, score, factors, dependencyDepth, subtaskCount, fileCount };
}

// ============================================================================
// taskDepsOverview
// ============================================================================

/**
 * Overview of all dependencies across the project.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @returns Project-wide dependency summary including blocked tasks, ready tasks, and validation results
 *
 * @remarks
 * Aggregates dependency data across all tasks to provide a high-level view of
 * the dependency graph health, including which tasks are blocked and what would unblock them.
 *
 * @example
 * ```typescript
 * const overview = await coreTaskDepsOverview('/project');
 * console.log(`${overview.blockedTasks.length} blocked, ${overview.readyTasks.length} ready`);
 * ```
 *
 * @task T5157
 */
export async function coreTaskDepsOverview(projectRoot: string): Promise<{
  totalTasks: number;
  tasksWithDeps: number;
  blockedTasks: Array<TaskRef & { unblockedBy: string[] }>;
  readyTasks: TaskRef[];
  validation: { valid: boolean; errorCount: number; warningCount: number };
}> {
  const allTasks = await loadAllTasks(projectRoot);
  const tasksAsTask = allTasks;

  const tasksWithDeps = allTasks.filter((t) => t.depends && t.depends.length > 0);
  const blocked = getBlockedTasks(tasksAsTask);
  const ready = getReadyTasks(tasksAsTask);
  const validation = validateDependencies(tasksAsTask);

  return {
    totalTasks: allTasks.length,
    tasksWithDeps: tasksWithDeps.length,
    blockedTasks: blocked.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      unblockedBy: (t.depends ?? []).filter((depId) => {
        const dep = allTasks.find((x) => x.id === depId);
        return dep && dep.status !== 'done' && dep.status !== 'cancelled';
      }),
    })),
    readyTasks: ready
      .filter((t) => t.status !== 'done' && t.status !== 'cancelled')
      .map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
      })),
    validation: {
      valid: validation.valid,
      errorCount: validation.errors.length,
      warningCount: validation.warnings.length,
    },
  };
}

// ============================================================================
// taskDepsCycles
// ============================================================================

/**
 * Detect circular dependencies across the project.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @returns Whether cycles exist and the list of detected cycles with their task paths
 *
 * @remarks
 * Iterates through all tasks with dependencies and uses cycle detection to find
 * circular chains. Each cycle includes the full path (e.g. [A, B, C, A]) and
 * the tasks involved with their titles.
 *
 * @example
 * ```typescript
 * const { hasCycles, cycles } = await coreTaskDepsCycles('/project');
 * if (hasCycles) console.log('Circular deps:', cycles.map(c => c.path.join(' -> ')));
 * ```
 *
 * @task T5157
 */
export async function coreTaskDepsCycles(projectRoot: string): Promise<{
  hasCycles: boolean;
  cycles: Array<{ path: string[]; tasks: Array<Pick<TaskRef, 'id' | 'title'>> }>;
}> {
  const allTasks = await loadAllTasks(projectRoot);
  const tasksAsTask = allTasks;
  const taskMap = new Map(allTasks.map((t) => [t.id, t]));

  const visited = new Set<string>();
  const cycles: Array<{ path: string[]; tasks: Array<Pick<TaskRef, 'id' | 'title'>> }> = [];

  for (const task of allTasks) {
    if (visited.has(task.id)) continue;
    if (!task.depends?.length) continue;

    const cycle = detectCircularDeps(task.id, tasksAsTask);
    if (cycle.length > 0) {
      cycles.push({
        path: cycle,
        // Deduplicate: detectCircularDeps returns [A,B,C,A] where
        // last element closes the cycle. Use Set for robustness.
        tasks: [...new Set(cycle)].map((id) => {
          const t = taskMap.get(id);
          return { id, title: t?.title ?? 'unknown' };
        }),
      });
      for (const id of cycle) {
        visited.add(id);
      }
    }
  }

  return { hasCycles: cycles.length > 0, cycles };
}

// ============================================================================
// taskDepends
// ============================================================================

/**
 * List dependencies for a task in a given direction.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param taskId - The task ID to inspect
 * @param direction - Direction to traverse: "upstream" (what this task depends on), "downstream" (what depends on it), or "both"
 * @param options - Optional display configuration
 * @param options.tree - When true, includes a recursive upstream dependency tree
 * @returns Upstream and downstream deps, transitive chain length, leaf blockers, and readiness status
 *
 * @remarks
 * Combines direct dependency lookups with transitive analysis. Leaf blockers are
 * the deepest unresolved tasks in the dependency chain -- resolving them first
 * has the most impact on unblocking.
 *
 * @example
 * ```typescript
 * const deps = await coreTaskDepends('/project', 'T100', 'both', { tree: true });
 * console.log('Leaf blockers:', deps.leafBlockers.map(b => b.id));
 * ```
 *
 * @task T4790
 */
export async function coreTaskDepends(
  projectRoot: string,
  taskId: string,
  direction: 'upstream' | 'downstream' | 'both' = 'both',
  options?: { tree?: boolean },
): Promise<{
  taskId: string;
  direction: string;
  upstream: TaskRef[];
  downstream: TaskRef[];
  unresolvedChain: number;
  leafBlockers: TaskRef[];
  allDepsReady: boolean;
  hint?: string;
  upstreamTree?: FlatTreeNode[];
}> {
  const allTasks = await loadAllTasks(projectRoot);

  const task = allTasks.find((t) => t.id === taskId);
  if (!task) {
    throw new Error(`Task '${taskId}' not found`);
  }

  const taskMap = new Map(allTasks.map((t) => [t.id, t]));

  const upstream: TaskRef[] = [];
  if (direction === 'upstream' || direction === 'both') {
    for (const depId of task.depends ?? []) {
      const dep = taskMap.get(depId);
      if (dep) {
        upstream.push({ id: dep.id, title: dep.title, status: dep.status });
      }
    }
  }

  const downstream: TaskRef[] = [];
  if (direction === 'downstream' || direction === 'both') {
    for (const t of allTasks) {
      if (t.depends?.includes(taskId)) {
        downstream.push({ id: t.id, title: t.title, status: t.status });
      }
    }
  }

  // Transitive dependency hints
  const tasksAsTask = allTasks;
  const transitiveIds = getTransitiveBlockers(taskId, tasksAsTask);
  const unresolvedChain = transitiveIds.length;

  const leafIds = getLeafBlockers(taskId, tasksAsTask);
  const leafBlockers = leafIds.map((id) => {
    const t = taskMap.get(id)!;
    return { id: t.id, title: t.title, status: t.status };
  });

  const allDepsReady = unresolvedChain === 0;
  const hint =
    unresolvedChain > 0
      ? `Run 'ct deps show ${taskId} --tree' for full dependency graph`
      : undefined;

  // Optional upstream tree
  let upstreamTree: FlatTreeNode[] | undefined;
  if (options?.tree) {
    upstreamTree = buildUpstreamTree(taskId, taskMap);
  }

  return {
    taskId,
    direction,
    upstream,
    downstream,
    unresolvedChain,
    leafBlockers,
    allDepsReady,
    ...(hint && { hint }),
    ...(upstreamTree && { upstreamTree }),
  };
}

// ============================================================================
// taskStats
// ============================================================================

/**
 * Compute task statistics.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param epicId - Optional epic ID to scope stats to that subtree
 * @returns Status counts, priority distribution, and type distribution
 *
 * @remarks
 * When an epicId is provided, statistics are scoped to that epic and all its
 * transitive children. Without an epicId, stats cover the entire project.
 *
 * @example
 * ```typescript
 * const stats = await coreTaskStats('/project', 'T001');
 * console.log(`${stats.done}/${stats.total} complete`);
 * ```
 *
 * @task T4790
 */
export async function coreTaskStats(
  projectRoot: string,
  epicId?: string,
): Promise<{
  total: number;
  pending: number;
  active: number;
  blocked: number;
  done: number;
  cancelled: number;
  byPriority: Record<string, number>;
  byType: Record<string, number>;
}> {
  const allTasks = await loadAllTasks(projectRoot);

  let tasks = allTasks;

  if (epicId) {
    const epicIds = new Set<string>();
    epicIds.add(epicId);
    const collectChildren = (parentId: string) => {
      for (const t of allTasks) {
        if (t.parentId === parentId && !epicIds.has(t.id)) {
          epicIds.add(t.id);
          collectChildren(t.id);
        }
      }
    };
    collectChildren(epicId);
    tasks = allTasks.filter((t) => epicIds.has(t.id));
  }

  const byStatus: Record<string, number> = {};
  const byPriority: Record<string, number> = {};
  const byType: Record<string, number> = {};

  for (const task of tasks) {
    byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
    byPriority[task.priority] = (byPriority[task.priority] ?? 0) + 1;
    const taskType = task.type ?? 'task';
    byType[taskType] = (byType[taskType] ?? 0) + 1;
  }

  return {
    total: tasks.length,
    pending: byStatus['pending'] ?? 0,
    active: byStatus['active'] ?? 0,
    blocked: byStatus['blocked'] ?? 0,
    done: byStatus['done'] ?? 0,
    cancelled: byStatus['cancelled'] ?? 0,
    byPriority,
    byType,
  };
}

// ============================================================================
// taskExport
// ============================================================================

/**
 * Export tasks as JSON or CSV.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param params - Optional export configuration
 * @param params.format - Output format: "json" (default) or "csv"
 * @param params.status - Filter to only tasks with this status
 * @param params.parent - Filter to tasks under this parent ID (recursive)
 * @returns Export payload with format, content/tasks, and task count
 *
 * @remarks
 * CSV output includes columns: id, title, status, priority, type, parentId, createdAt.
 * JSON output returns the full task objects. Both formats support status and parent filtering.
 *
 * @example
 * ```typescript
 * const result = await coreTaskExport('/project', { format: 'csv', status: 'done' });
 * console.log(result.content); // CSV string
 * ```
 *
 * @task T4790
 */
export async function coreTaskExport(
  projectRoot: string,
  params?: { format?: 'json' | 'csv'; status?: string; parent?: string },
): Promise<unknown> {
  const allTasks = await loadAllTasks(projectRoot);

  let tasks = allTasks;

  if (params?.status) {
    tasks = tasks.filter((t) => t.status === params.status);
  }

  if (params?.parent) {
    const parentIds = new Set<string>();
    parentIds.add(params.parent);
    const collectChildren = (parentId: string) => {
      for (const t of allTasks) {
        if (t.parentId === parentId && !parentIds.has(t.id)) {
          parentIds.add(t.id);
          collectChildren(t.id);
        }
      }
    };
    collectChildren(params.parent);
    tasks = tasks.filter((t) => parentIds.has(t.id));
  }

  if (params?.format === 'csv') {
    const headers = ['id', 'title', 'status', 'priority', 'type', 'parentId', 'createdAt'];
    const rows = tasks.map((t) =>
      [
        t.id,
        `"${(t.title || '').replace(/"/g, '""')}"`,
        t.status,
        t.priority,
        t.type ?? 'task',
        t.parentId ?? '',
        t.createdAt,
      ].join(','),
    );
    const csv = [headers.join(','), ...rows].join('\n');
    return { format: 'csv', content: csv, taskCount: tasks.length };
  }

  return { format: 'json', tasks, taskCount: tasks.length };
}

// ============================================================================
// taskHistory
// ============================================================================

/**
 * Get task history from the audit log.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param taskId - The task ID to retrieve history for
 * @param limit - Maximum number of history entries to return (default: 100)
 * @returns Array of audit log entries ordered by timestamp descending
 *
 * @remarks
 * Queries the SQLite audit_log table for all operations on the given task.
 * Returns an empty array if the database is unavailable or no entries exist.
 *
 * @example
 * ```typescript
 * const history = await coreTaskHistory('/project', 'T042', 10);
 * for (const entry of history) console.log(entry.timestamp, entry.operation);
 * ```
 *
 * @task T4790
 */
export async function coreTaskHistory(
  projectRoot: string,
  taskId: string,
  limit?: number,
): Promise<Array<Record<string, unknown>>> {
  try {
    const { getDb } = await import('../store/sqlite.js');
    const { auditLog } = await import('../store/tasks-schema.js');
    const { sql } = await import('drizzle-orm');

    const db = await getDb(projectRoot);
    const maxRows = limit && limit > 0 ? limit : 100;

    const rows = await db.all<{
      id: string;
      timestamp: string;
      action: string;
      task_id: string;
      actor: string;
      details_json: string | null;
      before_json: string | null;
      after_json: string | null;
      domain: string | null;
      operation: string | null;
      session_id: string | null;
      request_id: string | null;
      duration_ms: number | null;
      success: number | null;
      source: string | null;
      gateway: string | null;
      error_message: string | null;
    }>(
      sql`SELECT * FROM ${auditLog}
          WHERE ${auditLog.taskId} = ${taskId}
          ORDER BY ${auditLog.timestamp} DESC
          LIMIT ${maxRows}`,
    );

    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      operation: row.operation ?? row.action,
      action: row.action,
      taskId: row.task_id,
      actor: row.actor,
      details: row.details_json ? JSON.parse(row.details_json) : {},
      before: row.before_json ? JSON.parse(row.before_json) : undefined,
      after: row.after_json ? JSON.parse(row.after_json) : undefined,
      domain: row.domain,
      sessionId: row.session_id,
      requestId: row.request_id,
      durationMs: row.duration_ms,
      success: row.success === null ? undefined : row.success === 1,
      source: row.source,
      gateway: row.gateway,
      error: row.error_message,
    }));
  } catch {
    return [];
  }
}

// ============================================================================
// taskLint
// ============================================================================

/**
 * Lint tasks for common issues.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param taskId - Optional task ID to lint; omit to lint all tasks
 * @returns Array of lint issues with severity, rule name, and descriptive message
 *
 * @remarks
 * Checks for: duplicate IDs, missing titles, missing descriptions, identical
 * title/description, duplicate descriptions, invalid statuses, future timestamps,
 * invalid parent references, and invalid dependency references.
 *
 * @example
 * ```typescript
 * const issues = await coreTaskLint('/project');
 * const errors = issues.filter(i => i.severity === 'error');
 * console.log(`${errors.length} errors found`);
 * ```
 *
 * @task T4790
 */
export async function coreTaskLint(
  projectRoot: string,
  taskId?: string,
): Promise<
  Array<{
    taskId: string;
    severity: 'error' | 'warning';
    rule: string;
    message: string;
  }>
> {
  const allTasks = await loadAllTasks(projectRoot);

  const tasks = taskId ? allTasks.filter((t) => t.id === taskId) : allTasks;

  if (taskId && tasks.length === 0) {
    throw new Error(`Task '${taskId}' not found`);
  }

  const issues: Array<{
    taskId: string;
    severity: 'error' | 'warning';
    rule: string;
    message: string;
  }> = [];

  const allDescriptions = new Set<string>();
  const allIds = new Set<string>();

  for (const task of allTasks) {
    if (allIds.has(task.id)) {
      issues.push({
        taskId: task.id,
        severity: 'error',
        rule: 'unique-id',
        message: `Duplicate task ID: ${task.id}`,
      });
    }
    allIds.add(task.id);

    if (taskId && task.id !== taskId) {
      if (task.description) allDescriptions.add(task.description.toLowerCase());
      continue;
    }

    if (!task.title || task.title.trim().length === 0) {
      issues.push({
        taskId: task.id,
        severity: 'error',
        rule: 'title-required',
        message: 'Task is missing a title',
      });
    }

    if (!task.description || task.description.trim().length === 0) {
      issues.push({
        taskId: task.id,
        severity: 'warning',
        rule: 'description-required',
        message: 'Task is missing a description',
      });
    }

    if (task.title && task.description && task.title.trim() === task.description.trim()) {
      issues.push({
        taskId: task.id,
        severity: 'warning',
        rule: 'title-description-different',
        message: 'Title and description should not be identical',
      });
    }

    if (task.description) {
      const descLower = task.description.toLowerCase();
      if (allDescriptions.has(descLower)) {
        issues.push({
          taskId: task.id,
          severity: 'warning',
          rule: 'unique-description',
          message: 'Duplicate task description found',
        });
      }
      allDescriptions.add(descLower);
    }

    if (!(TASK_STATUSES as readonly string[]).includes(task.status)) {
      issues.push({
        taskId: task.id,
        severity: 'error',
        rule: 'valid-status',
        message: `Invalid status: ${task.status}`,
      });
    }

    const now = new Date();
    if (task.createdAt && new Date(task.createdAt) > now) {
      issues.push({
        taskId: task.id,
        severity: 'warning',
        rule: 'no-future-timestamps',
        message: 'createdAt is in the future',
      });
    }

    if (task.parentId && !allTasks.some((t) => t.id === task.parentId)) {
      issues.push({
        taskId: task.id,
        severity: 'error',
        rule: 'valid-parent',
        message: `Parent task '${task.parentId}' does not exist`,
      });
    }

    for (const depId of task.depends ?? []) {
      if (!allTasks.some((t) => t.id === depId)) {
        issues.push({
          taskId: task.id,
          severity: 'warning',
          rule: 'valid-dependency',
          message: `Dependency '${depId}' does not exist`,
        });
      }
    }
  }

  return issues;
}

// ============================================================================
// taskBatchValidate
// ============================================================================

/**
 * Validate multiple tasks at once.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param taskIds - Array of task IDs to validate
 * @param checkMode - Validation depth: "full" runs all checks, "quick" checks only title/description/status
 * @returns Per-task validation results and an aggregate summary with error/warning counts
 *
 * @remarks
 * In "full" mode, additional checks include title-description equality, parent existence,
 * dependency existence, and future timestamp detection. Tasks that are not found are
 * reported as errors.
 *
 * @example
 * ```typescript
 * const { summary } = await coreTaskBatchValidate('/project', ['T001', 'T002'], 'full');
 * console.log(`${summary.validTasks}/${summary.totalTasks} valid`);
 * ```
 *
 * @task T4790
 */
export async function coreTaskBatchValidate(
  projectRoot: string,
  taskIds: string[],
  checkMode: 'full' | 'quick' = 'full',
): Promise<{
  results: Record<string, Array<{ severity: 'error' | 'warning'; rule: string; message: string }>>;
  summary: {
    totalTasks: number;
    validTasks: number;
    invalidTasks: number;
    totalIssues: number;
    errors: number;
    warnings: number;
  };
}> {
  const allTasks = await loadAllTasks(projectRoot);

  const results: Record<
    string,
    Array<{ severity: 'error' | 'warning'; rule: string; message: string }>
  > = {};

  let totalErrors = 0;
  let totalWarnings = 0;

  for (const id of taskIds) {
    const task = allTasks.find((t) => t.id === id);
    if (!task) {
      results[id] = [{ severity: 'error', rule: 'exists', message: `Task '${id}' not found` }];
      totalErrors++;
      continue;
    }

    const taskIssues: Array<{ severity: 'error' | 'warning'; rule: string; message: string }> = [];

    if (!task.title || task.title.trim().length === 0) {
      taskIssues.push({ severity: 'error', rule: 'title-required', message: 'Missing title' });
    }
    if (!task.description || task.description.trim().length === 0) {
      taskIssues.push({
        severity: 'warning',
        rule: 'description-required',
        message: 'Missing description',
      });
    }

    if (!(TASK_STATUSES as readonly string[]).includes(task.status)) {
      taskIssues.push({
        severity: 'error',
        rule: 'valid-status',
        message: `Invalid status: ${task.status}`,
      });
    }

    if (checkMode === 'full') {
      if (task.title && task.description && task.title.trim() === task.description.trim()) {
        taskIssues.push({
          severity: 'warning',
          rule: 'title-description-different',
          message: 'Title equals description',
        });
      }

      if (task.parentId && !allTasks.some((t) => t.id === task.parentId)) {
        taskIssues.push({
          severity: 'error',
          rule: 'valid-parent',
          message: `Parent '${task.parentId}' not found`,
        });
      }

      for (const depId of task.depends ?? []) {
        if (!allTasks.some((t) => t.id === depId)) {
          taskIssues.push({
            severity: 'warning',
            rule: 'valid-dependency',
            message: `Dependency '${depId}' not found`,
          });
        }
      }

      const now = new Date();
      if (task.createdAt && new Date(task.createdAt) > now) {
        taskIssues.push({
          severity: 'warning',
          rule: 'no-future-timestamps',
          message: 'createdAt in future',
        });
      }
    }

    results[id] = taskIssues;
    totalErrors += taskIssues.filter((i) => i.severity === 'error').length;
    totalWarnings += taskIssues.filter((i) => i.severity === 'warning').length;
  }

  const invalidTasks = Object.values(results).filter((issues) =>
    issues.some((i) => i.severity === 'error'),
  ).length;

  return {
    results,
    summary: {
      totalTasks: taskIds.length,
      validTasks: taskIds.length - invalidTasks,
      invalidTasks,
      totalIssues: totalErrors + totalWarnings,
      errors: totalErrors,
      warnings: totalWarnings,
    },
  };
}

// ============================================================================
// taskImport
// ============================================================================

/**
 * Import tasks from a JSON source string.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param source - JSON string containing an array of tasks or an object with a `tasks` array
 * @param overwrite - When true, overwrites existing tasks with matching IDs; otherwise skips them
 * @returns Import summary with counts of imported, skipped, errors, and optional ID remap table
 *
 * @remarks
 * When a task ID collides with an existing one and overwrite is false, a new sequential
 * ID is assigned and recorded in the remapTable. Tasks missing required id or title
 * fields are skipped with an error message.
 *
 * @example
 * ```typescript
 * const json = JSON.stringify([{ id: 'T500', title: 'New task', status: 'pending', priority: 'medium' }]);
 * const result = await coreTaskImport('/project', json, false);
 * console.log(`Imported ${result.imported}, skipped ${result.skipped}`);
 * ```
 *
 * @task T4790
 */
export async function coreTaskImport(
  projectRoot: string,
  source: string,
  overwrite?: boolean,
): Promise<{
  imported: number;
  skipped: number;
  errors: string[];
  remapTable?: Record<string, string>;
}> {
  const accessor = await getAccessor(projectRoot);

  // Load all existing task IDs using queryTasks (bulk operation needs full ID set)
  const { tasks: existingTasks } = await accessor.queryTasks({});

  let importData: unknown;
  try {
    importData = JSON.parse(source);
  } catch {
    throw new Error('Invalid JSON in import source');
  }

  let importTasks: TaskRecord[] = [];
  if (Array.isArray(importData)) {
    importTasks = importData;
  } else if (typeof importData === 'object' && importData !== null) {
    const data = importData as Record<string, unknown>;
    if (Array.isArray(data.tasks)) {
      importTasks = data.tasks;
    }
  }

  if (importTasks.length === 0) {
    return { imported: 0, skipped: 0, errors: ['No tasks found in import source'] };
  }

  const existingIds = new Set(existingTasks.map((t) => t.id));
  const allIds = new Set(existingTasks.map((t) => t.id));
  const errors: string[] = [];
  let imported = 0;
  let skipped = 0;
  const remapTable: Record<string, string> = {};

  let nextIdNum = 0;
  for (const t of existingTasks) {
    const num = parseInt(t.id.replace('T', ''), 10);
    if (!Number.isNaN(num) && num > nextIdNum) nextIdNum = num;
  }

  for (const importTask of importTasks) {
    if (!importTask.id || !importTask.title) {
      errors.push(`Skipped task with missing id or title`);
      skipped++;
      continue;
    }

    if (existingIds.has(importTask.id) && !overwrite) {
      skipped++;
      continue;
    }

    let newId = importTask.id;
    if (allIds.has(importTask.id) && !overwrite) {
      nextIdNum++;
      newId = `T${String(nextIdNum).padStart(3, '0')}`;
      remapTable[importTask.id] = newId;
    }

    const now = new Date().toISOString();
    const newTask: TaskRecord = {
      ...importTask,
      id: newId,
      createdAt: importTask.createdAt || now,
      updatedAt: now,
    };

    // Use targeted upsert per task instead of bulk saveTaskFile
    await accessor.upsertSingleTask(newTask);

    allIds.add(newId);
    imported++;
  }

  return {
    imported,
    skipped,
    errors,
    ...(Object.keys(remapTable).length > 0 ? { remapTable } : {}),
  };
}
