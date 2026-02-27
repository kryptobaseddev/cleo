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

import { getAccessor } from '../../store/data-accessor.js';
import { readJsonFile as storeReadJsonFile, readLogFileEntries, getDataPath } from '../../mcp/engine/store.js';
import { TASK_STATUSES } from '../../store/status-registry.js';

// ============================================================================
// Types (shared)
// ============================================================================

/** Task record shape expected from the data layer. */
interface TaskRecord {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  type?: string;
  phase?: string;
  createdAt: string;
  updatedAt: string | null;
  completedAt?: string | null;
  cancelledAt?: string | null;
  cancellationReason?: string;
  parentId?: string | null;
  position?: number | null;
  positionVersion?: number;
  depends?: string[];
  relates?: Array<{ taskId: string; type: string; reason?: string }>;
  files?: string[];
  acceptance?: string[];
  notes?: string[];
  labels?: string[];
  size?: string | null;
  [key: string]: unknown;
}

/** Tree node representation for task hierarchy. */
export interface TaskTreeNode {
  id: string;
  title: string;
  status: string;
  type?: string;
  children: TaskTreeNode[];
}

/** Complexity factor. */
export interface ComplexityFactor {
  name: string;
  value: number;
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
  const data = await accessor.loadTaskFile();
  return data.tasks as unknown as TaskRecord[];
}

function depsReady(task: TaskRecord, taskMap: Map<string, TaskRecord>): boolean {
  if (!task.depends || task.depends.length === 0) return true;
  return task.depends.every((depId) => {
    const dep = taskMap.get(depId);
    return dep && (dep.status === 'done' || dep.status === 'cancelled');
  });
}

function buildBlockingChain(
  task: TaskRecord,
  taskMap: Map<string, TaskRecord>,
  visited: Set<string> = new Set(),
): string[] {
  const chain: string[] = [];
  if (visited.has(task.id)) return chain;
  visited.add(task.id);

  if (task.depends) {
    for (const depId of task.depends) {
      const dep = taskMap.get(depId);
      if (dep && dep.status !== 'done' && dep.status !== 'cancelled') {
        chain.push(depId);
        chain.push(...buildBlockingChain(dep, taskMap, visited));
      }
    }
  }

  return chain;
}

function buildTreeNode(
  task: TaskRecord,
  childrenMap: Map<string, TaskRecord[]>,
): TaskTreeNode {
  const children = (childrenMap.get(task.id) ?? []).map((child) =>
    buildTreeNode(child, childrenMap),
  );
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    type: task.type,
    children,
  };
}

function countNodes(nodes: TaskTreeNode[]): number {
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
  if (!task || !task.depends || task.depends.length === 0) return 0;

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
  const allTasks = await loadAllTasks(projectRoot);
  const taskMap = new Map(allTasks.map((t) => [t.id, t]));

  const taskPath = getDataPath(projectRoot, 'tasks.json');
  const todoMeta = storeReadJsonFile<{ project?: { currentPhase?: string | null } }>(taskPath);
  const currentPhase = todoMeta?.project?.currentPhase;

  const candidates = allTasks.filter((t) =>
    t.status === 'pending' && depsReady(t, taskMap),
  );

  if (candidates.length === 0) {
    return { suggestions: [], totalCandidates: 0 };
  }

  const scored = candidates.map((task) => {
    const reasons: string[] = [];
    let score = 0;

    score += PRIORITY_SCORE[task.priority] ?? 50;
    reasons.push(`priority: ${task.priority} (+${PRIORITY_SCORE[task.priority] ?? 50})`);

    if (currentPhase && task.phase === currentPhase) {
      score += 20;
      reasons.push(`phase alignment: ${currentPhase} (+20)`);
    }

    if (depsReady(task, taskMap)) {
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
  }).sort((a, b) => b.score - a.score);

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
 * @task T4790
 */
export async function coreTaskBlockers(
  projectRoot: string,
  params?: { analyze?: boolean },
): Promise<{
  blockedTasks: Array<{
    id: string;
    title: string;
    status: string;
    depends?: string[];
    blockingChain: string[];
  }>;
  criticalBlockers: Array<{ id: string; title: string; blocksCount: number }>;
  summary: string;
}> {
  const allTasks = await loadAllTasks(projectRoot);
  const taskMap = new Map(allTasks.map((t) => [t.id, t]));
  const analyze = params?.analyze ?? false;

  const blockedTasks = allTasks.filter((t) => t.status === 'blocked');

  const depBlockedTasks = allTasks.filter((t) =>
    t.status === 'pending' &&
    t.depends &&
    t.depends.length > 0 &&
    t.depends.some((depId) => {
      const dep = taskMap.get(depId);
      return dep && dep.status !== 'done' && dep.status !== 'cancelled';
    }),
  );

  const blockerInfos = [
    ...blockedTasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      depends: t.depends,
      blockingChain: analyze ? buildBlockingChain(t, taskMap) : [],
    })),
    ...depBlockedTasks
      .filter((t) => !blockedTasks.some((bt) => bt.id === t.id))
      .map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        depends: t.depends,
        blockingChain: analyze ? buildBlockingChain(t, taskMap) : [],
      })),
  ];

  const blockerCounts = new Map<string, number>();
  for (const info of blockerInfos) {
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
    blockedTasks: blockerInfos,
    criticalBlockers,
    summary: blockerInfos.length === 0
      ? 'No blocked tasks found'
      : `${blockerInfos.length} blocked task(s)`,
  };
}

// ============================================================================
// taskTree
// ============================================================================

/**
 * Build hierarchy tree.
 * @task T4790
 */
export async function coreTaskTree(
  projectRoot: string,
  taskId?: string,
): Promise<{ tree: TaskTreeNode[]; totalNodes: number }> {
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
 * @task T4790
 */
export async function coreTaskDeps(
  projectRoot: string,
  taskId: string,
): Promise<{
  taskId: string;
  dependsOn: Array<{ id: string; title: string; status: string }>;
  dependedOnBy: Array<{ id: string; title: string; status: string }>;
  unresolvedDeps: string[];
  allDepsReady: boolean;
}> {
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
    .filter((d): d is { id: string; title: string; status: string } => d !== null);

  const dependedOnBy = allTasks
    .filter((t) => t.depends?.includes(taskId))
    .map((t) => ({ id: t.id, title: t.title, status: t.status }));

  const unresolvedDeps = (task.depends ?? []).filter((depId) => !completedIds.has(depId));

  return { taskId, dependsOn, dependedOnBy, unresolvedDeps, allDepsReady: unresolvedDeps.length === 0 };
}

// ============================================================================
// taskRelates
// ============================================================================

/**
 * Show task relations.
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
 * @task T4790
 */
export async function coreTaskRelatesAdd(
  projectRoot: string,
  taskId: string,
  relatedId: string,
  type: string,
  reason?: string,
): Promise<{ from: string; to: string; type: string; added: boolean }> {
  const accessor = await getAccessor(projectRoot);
  const current = await accessor.loadTaskFile();
  if (!current || !current.tasks) {
    throw new Error('No valid tasks.json found');
  }

  const fromTask = current.tasks.find((t) => t.id === taskId) as TaskRecord | undefined;
  if (!fromTask) {
    throw new Error(`Task '${taskId}' not found`);
  }

  const toTask = current.tasks.find((t) => t.id === relatedId);
  if (!toTask) {
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
  await accessor.saveTaskFile(current);

  return { from: taskId, to: relatedId, type, added: true };
}

// ============================================================================
// taskAnalyze
// ============================================================================

/**
 * Analyze tasks for priority and leverage.
 * @task T4790
 */
export async function coreTaskAnalyze(
  projectRoot: string,
  taskId?: string,
): Promise<{
  recommended: { id: string; title: string; leverage: number; reason: string } | null;
  bottlenecks: Array<{ id: string; title: string; blocksCount: number }>;
  tiers: {
    critical: Array<{ id: string; title: string; leverage: number }>;
    high: Array<{ id: string; title: string; leverage: number }>;
    normal: Array<{ id: string; title: string; leverage: number }>;
  };
  metrics: {
    totalTasks: number;
    actionable: number;
    blocked: number;
    avgLeverage: number;
  };
}> {
  const allTasks = await loadAllTasks(projectRoot);

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

  const recommended = scored.length > 0
    ? {
        id: scored[0]!.id,
        title: scored[0]!.title,
        leverage: scored[0]!.leverage,
        reason: 'Highest combined priority and leverage score',
      }
    : null;

  const totalLeverage = Object.values(leverageMap).reduce((s, v) => s + v, 0);
  const avgLeverage = tasks.length > 0
    ? Math.round((totalLeverage / tasks.length) * 100) / 100
    : 0;

  return {
    recommended,
    bottlenecks,
    tiers: {
      critical: critical.map(({ id, title, leverage }) => ({ id, title, leverage })),
      high: high.map(({ id, title, leverage }) => ({ id, title, leverage })),
      normal: normal.slice(0, 10).map(({ id, title, leverage }) => ({ id, title, leverage })),
    },
    metrics: {
      totalTasks: tasks.length,
      actionable: actionable.length,
      blocked: blocked.length,
      avgLeverage,
    },
  };
}

// ============================================================================
// taskRestore
// ============================================================================

/**
 * Restore a cancelled task back to pending.
 * @task T4790
 */
export async function coreTaskRestore(
  projectRoot: string,
  taskId: string,
  params?: { cascade?: boolean; notes?: string },
): Promise<{ task: string; restored: string[]; count: number }> {
  const accessor = await getAccessor(projectRoot);
  const current = await accessor.loadTaskFile();
  if (!current || !current.tasks) {
    throw new Error('No valid tasks.json found');
  }

  const task = current.tasks.find((t) => t.id === taskId) as TaskRecord | undefined;
  if (!task) {
    throw new Error(`Task '${taskId}' not found`);
  }

  if (task.status !== 'cancelled') {
    throw new Error(`Task '${taskId}' is not cancelled (status: ${task.status}). Only cancelled tasks can be restored.`);
  }

  const tasksToRestore: TaskRecord[] = [task];
  if (params?.cascade) {
    const findCancelledChildren = (parentId: string): void => {
      const children = current.tasks.filter(
        (t) => t.parentId === parentId && t.status === 'cancelled',
      );
      for (const child of children) {
        tasksToRestore.push(child as unknown as TaskRecord);
        findCancelledChildren(child.id);
      }
    };
    findCancelledChildren(taskId);
  }

  const now = new Date().toISOString();
  const restored: string[] = [];

  for (const t of tasksToRestore) {
    t.status = 'pending';
    t.cancelledAt = null;
    t.cancellationReason = undefined;
    t.updatedAt = now;

    if (!t.notes) t.notes = [];
    t.notes.push(`[${now}] Restored from cancelled${params?.notes ? ': ' + params.notes : ''}`);
    restored.push(t.id);
  }

  await accessor.saveTaskFile(current);

  return { task: taskId, restored, count: restored.length };
}

// ============================================================================
// taskUnarchive
// ============================================================================

/**
 * Move an archived task back to tasks.json.
 * @task T4790
 */
export async function coreTaskUnarchive(
  projectRoot: string,
  taskId: string,
  params?: { status?: string; preserveStatus?: boolean },
): Promise<{ task: string; unarchived: boolean; title: string; status: string }> {
  const accessor = await getAccessor(projectRoot);
  const taskFile = await accessor.loadTaskFile();
  if (!taskFile || !taskFile.tasks) {
    throw new Error('No valid tasks.json found');
  }

  const archive = await accessor.loadArchive();
  if (!archive || !archive.archivedTasks) {
    throw new Error('No archive file found');
  }

  const taskIndex = archive.archivedTasks.findIndex((t) => t.id === taskId);
  if (taskIndex === -1) {
    throw new Error(`Task '${taskId}' not found in archive`);
  }

  if (taskFile.tasks.some((t) => t.id === taskId)) {
    throw new Error(`Task '${taskId}' already exists in tasks.json`);
  }

  const task = archive.archivedTasks[taskIndex] as TaskRecord & { _archive?: Record<string, unknown> };

  delete task._archive;

  if (!params?.preserveStatus) {
    const targetStatus = params?.status || 'pending';
    task.status = targetStatus;
    if (targetStatus !== 'done') {
      task.completedAt = null;
    }
  }

  task.updatedAt = new Date().toISOString();

  (taskFile.tasks as unknown as TaskRecord[]).push(task);
  archive.archivedTasks.splice(taskIndex, 1);

  await accessor.saveTaskFile(taskFile);
  await accessor.saveArchive(archive);

  return { task: taskId, unarchived: true, title: task.title, status: task.status };
}

// ============================================================================
// taskReorder
// ============================================================================

/**
 * Change task position within its sibling group.
 * @task T4790
 */
export async function coreTaskReorder(
  projectRoot: string,
  taskId: string,
  position: number,
): Promise<{ task: string; reordered: boolean; newPosition: number; totalSiblings: number }> {
  const accessor = await getAccessor(projectRoot);
  const current = await accessor.loadTaskFile();
  if (!current || !current.tasks) {
    throw new Error('No valid tasks.json found');
  }

  const task = current.tasks.find((t) => t.id === taskId);
  if (!task) {
    throw new Error(`Task '${taskId}' not found`);
  }

  const allSiblings = current.tasks
    .filter((t) => t.parentId === task.parentId)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  const currentIndex = allSiblings.findIndex((t) => t.id === taskId);
  const newIndex = Math.max(0, Math.min(position - 1, allSiblings.length - 1));

  allSiblings.splice(currentIndex, 1);
  allSiblings.splice(newIndex, 0, task);

  const now = new Date().toISOString();
  for (let i = 0; i < allSiblings.length; i++) {
    const sibling = current.tasks.find((t) => t.id === allSiblings[i]!.id);
    if (sibling) {
      sibling.position = i + 1;
      sibling.positionVersion = ((sibling.positionVersion as number | undefined) ?? 0) + 1;
      sibling.updatedAt = now;
    }
  }

  await accessor.saveTaskFile(current);

  return { task: taskId, reordered: true, newPosition: newIndex + 1, totalSiblings: allSiblings.length };
}

// ============================================================================
// taskReparent
// ============================================================================

/**
 * Move task under a different parent.
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
  const current = await accessor.loadTaskFile();
  if (!current || !current.tasks) {
    throw new Error('No valid tasks.json found');
  }

  const taskMap = new Map(current.tasks.map((t) => [t.id, t]));
  const task = taskMap.get(taskId) as TaskRecord | undefined;
  if (!task) {
    throw new Error(`Task '${taskId}' not found`);
  }

  const effectiveParentId = newParentId || null;

  if (!effectiveParentId) {
    const oldParent = task.parentId ?? null;
    task.parentId = null;
    if (task.type === 'subtask') task.type = 'task';
    task.updatedAt = new Date().toISOString();

    await accessor.saveTaskFile(current);

    return { task: taskId, reparented: true, oldParent, newParent: null, newType: task.type };
  }

  const newParent = taskMap.get(effectiveParentId);
  if (!newParent) {
    throw new Error(`Parent task '${effectiveParentId}' not found`);
  }

  if (newParent.type === 'subtask') {
    throw new Error(`Cannot parent under subtask '${effectiveParentId}'`);
  }

  // Check circular reference
  let ancestor: TaskRecord | undefined = newParent as unknown as TaskRecord;
  while (ancestor) {
    if (ancestor.id === taskId) {
      throw new Error(`Moving '${taskId}' under '${effectiveParentId}' would create circular reference`);
    }
    if (!ancestor.parentId) break;
    ancestor = taskMap.get(ancestor.parentId) as unknown as TaskRecord | undefined;
    if (!ancestor) break;
  }

  // Check depth limit
  let parentDepth = 0;
  let cur: TaskRecord | undefined = newParent as unknown as TaskRecord;
  while (cur?.parentId) {
    parentDepth++;
    cur = taskMap.get(cur.parentId) as unknown as TaskRecord | undefined;
    if (!cur || parentDepth > 10) break;
  }
  const reparentLimits = getHierarchyLimits(projectRoot);
  if (parentDepth + 1 >= reparentLimits.maxDepth) {
    throw new Error(`Move would exceed max depth of ${reparentLimits.maxDepth}`);
  }

  // Check sibling limit (0 = unlimited)
  const siblingCount = current.tasks.filter((t) => t.parentId === effectiveParentId && t.id !== taskId).length;
  if (reparentLimits.maxSiblings > 0 && siblingCount >= reparentLimits.maxSiblings) {
    throw new Error(`Cannot add child to ${effectiveParentId}: max siblings (${reparentLimits.maxSiblings}) exceeded`);
  }

  const oldParent = task.parentId ?? null;
  task.parentId = effectiveParentId;

  const newDepth = parentDepth + 1;
  if (newDepth === 1) task.type = 'task';
  else if (newDepth >= 2) task.type = 'subtask';

  task.updatedAt = new Date().toISOString();

  await accessor.saveTaskFile(current);

  return { task: taskId, reparented: true, oldParent, newParent: effectiveParentId, newType: task.type };
}

// ============================================================================
// taskPromote
// ============================================================================

/**
 * Promote a subtask to task or task to root.
 * @task T4790
 */
export async function coreTaskPromote(
  projectRoot: string,
  taskId: string,
): Promise<{ task: string; promoted: boolean; previousParent: string | null; typeChanged: boolean }> {
  const accessor = await getAccessor(projectRoot);
  const current = await accessor.loadTaskFile();
  if (!current || !current.tasks) {
    throw new Error('No valid tasks.json found');
  }

  const task = current.tasks.find((t) => t.id === taskId) as TaskRecord | undefined;
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

  await accessor.saveTaskFile(current);

  return { task: taskId, promoted: true, previousParent: oldParent, typeChanged };
}

// ============================================================================
// taskReopen
// ============================================================================

/**
 * Reopen a completed task.
 * @task T4790
 */
export async function coreTaskReopen(
  projectRoot: string,
  taskId: string,
  params?: { status?: string; reason?: string },
): Promise<{ task: string; reopened: boolean; previousStatus: string; newStatus: string }> {
  const accessor = await getAccessor(projectRoot);
  const current = await accessor.loadTaskFile();
  if (!current || !current.tasks) {
    throw new Error('No valid tasks.json found');
  }

  const task = current.tasks.find((t) => t.id === taskId) as TaskRecord | undefined;
  if (!task) {
    throw new Error(`Task '${taskId}' not found`);
  }

  if (task.status !== 'done') {
    throw new Error(`Task '${taskId}' is not completed (status: ${task.status}). Only done tasks can be reopened.`);
  }

  const targetStatus = params?.status || 'pending';
  if (targetStatus !== 'pending' && targetStatus !== 'active') {
    throw new Error(`Invalid target status: ${targetStatus}. Must be 'pending' or 'active'.`);
  }

  const previousStatus = task.status;
  task.status = targetStatus;
  task.completedAt = null;
  task.updatedAt = new Date().toISOString();

  if (!task.notes) task.notes = [];
  const reason = params?.reason;
  task.notes.push(`[${task.updatedAt}] Reopened from ${previousStatus}${reason ? ': ' + reason : ''}`);

  await accessor.saveTaskFile(current);

  return { task: taskId, reopened: true, previousStatus, newStatus: targetStatus };
}

// ============================================================================
// taskComplexityEstimate
// ============================================================================

/**
 * Deterministic complexity scoring from task metadata.
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
  if (descLen < 100) { descScore = 1; descLabel = 'short'; }
  else if (descLen < 500) { descScore = 2; descLabel = 'medium'; }
  else { descScore = 3; descLabel = 'long'; }
  score += descScore;
  factors.push({ name: 'descriptionLength', value: descScore, detail: `${descLabel} (${descLen} chars)` });

  const acceptanceCount = task.acceptance?.length ?? 0;
  const acceptanceScore = Math.min(acceptanceCount, 3);
  score += acceptanceScore;
  factors.push({ name: 'acceptanceCriteria', value: acceptanceScore, detail: `${acceptanceCount} criteria` });

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
// taskDepends
// ============================================================================

/**
 * List dependencies for a task in a given direction.
 * @task T4790
 */
export async function coreTaskDepends(
  projectRoot: string,
  taskId: string,
  direction: 'upstream' | 'downstream' | 'both' = 'both',
): Promise<{
  taskId: string;
  direction: string;
  upstream: Array<{ id: string; title: string; status: string }>;
  downstream: Array<{ id: string; title: string; status: string }>;
}> {
  const allTasks = await loadAllTasks(projectRoot);

  const task = allTasks.find((t) => t.id === taskId);
  if (!task) {
    throw new Error(`Task '${taskId}' not found`);
  }

  const taskMap = new Map(allTasks.map((t) => [t.id, t]));

  const upstream: Array<{ id: string; title: string; status: string }> = [];
  if (direction === 'upstream' || direction === 'both') {
    for (const depId of task.depends ?? []) {
      const dep = taskMap.get(depId);
      if (dep) {
        upstream.push({ id: dep.id, title: dep.title, status: dep.status });
      }
    }
  }

  const downstream: Array<{ id: string; title: string; status: string }> = [];
  if (direction === 'downstream' || direction === 'both') {
    for (const t of allTasks) {
      if (t.depends?.includes(taskId)) {
        downstream.push({ id: t.id, title: t.title, status: t.status });
      }
    }
  }

  return { taskId, direction, upstream, downstream };
}

// ============================================================================
// taskStats
// ============================================================================

/**
 * Compute task statistics.
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
    const rows = tasks.map((t) => [
      t.id,
      `"${(t.title || '').replace(/"/g, '""')}"`,
      t.status,
      t.priority,
      t.type ?? 'task',
      t.parentId ?? '',
      t.createdAt,
    ].join(','));
    const csv = [headers.join(','), ...rows].join('\n');
    return { format: 'csv', content: csv, taskCount: tasks.length };
  }

  return { format: 'json', tasks, taskCount: tasks.length };
}

// ============================================================================
// taskHistory
// ============================================================================

/**
 * Get task history from the log file.
 * @task T4790
 */
export async function coreTaskHistory(
  projectRoot: string,
  taskId: string,
  limit?: number,
): Promise<Array<Record<string, unknown>>> {
  const logPath = getDataPath(projectRoot, 'tasks-log.jsonl');
  const entries = readLogFileEntries(logPath);

  const taskEntries = entries.filter((entry) => {
    if (entry.taskId === taskId) return true;
    if (entry.id === taskId) return true;
    if (typeof entry.details === 'string' && entry.details.includes(taskId)) return true;
    if (typeof entry.message === 'string' && entry.message.includes(taskId)) return true;
    return false;
  });

  taskEntries.sort((a, b) => {
    const timeA = String(a.timestamp ?? a.date ?? '');
    const timeB = String(b.timestamp ?? b.date ?? '');
    return timeB.localeCompare(timeA);
  });

  return limit && limit > 0 ? taskEntries.slice(0, limit) : taskEntries;
}

// ============================================================================
// taskLint
// ============================================================================

/**
 * Lint tasks for common issues.
 * @task T4790
 */
export async function coreTaskLint(
  projectRoot: string,
  taskId?: string,
): Promise<Array<{
  taskId: string;
  severity: 'error' | 'warning';
  rule: string;
  message: string;
}>> {
  const allTasks = await loadAllTasks(projectRoot);

  const tasks = taskId
    ? allTasks.filter((t) => t.id === taskId)
    : allTasks;

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
      issues.push({ taskId: task.id, severity: 'error', rule: 'title-required', message: 'Task is missing a title' });
    }

    if (!task.description || task.description.trim().length === 0) {
      issues.push({ taskId: task.id, severity: 'warning', rule: 'description-required', message: 'Task is missing a description' });
    }

    if (task.title && task.description && task.title.trim() === task.description.trim()) {
      issues.push({ taskId: task.id, severity: 'warning', rule: 'title-description-different', message: 'Title and description should not be identical' });
    }

    if (task.description) {
      const descLower = task.description.toLowerCase();
      if (allDescriptions.has(descLower)) {
        issues.push({ taskId: task.id, severity: 'warning', rule: 'unique-description', message: 'Duplicate task description found' });
      }
      allDescriptions.add(descLower);
    }

    if (!(TASK_STATUSES as readonly string[]).includes(task.status)) {
      issues.push({ taskId: task.id, severity: 'error', rule: 'valid-status', message: `Invalid status: ${task.status}` });
    }

    const now = new Date();
    if (task.createdAt && new Date(task.createdAt) > now) {
      issues.push({ taskId: task.id, severity: 'warning', rule: 'no-future-timestamps', message: 'createdAt is in the future' });
    }

    if (task.parentId && !allTasks.some((t) => t.id === task.parentId)) {
      issues.push({ taskId: task.id, severity: 'error', rule: 'valid-parent', message: `Parent task '${task.parentId}' does not exist` });
    }

    for (const depId of task.depends ?? []) {
      if (!allTasks.some((t) => t.id === depId)) {
        issues.push({ taskId: task.id, severity: 'warning', rule: 'valid-dependency', message: `Dependency '${depId}' does not exist` });
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

  const results: Record<string, Array<{ severity: 'error' | 'warning'; rule: string; message: string }>> = {};

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
      taskIssues.push({ severity: 'warning', rule: 'description-required', message: 'Missing description' });
    }

    if (!(TASK_STATUSES as readonly string[]).includes(task.status)) {
      taskIssues.push({ severity: 'error', rule: 'valid-status', message: `Invalid status: ${task.status}` });
    }

    if (checkMode === 'full') {
      if (task.title && task.description && task.title.trim() === task.description.trim()) {
        taskIssues.push({ severity: 'warning', rule: 'title-description-different', message: 'Title equals description' });
      }

      if (task.parentId && !allTasks.some((t) => t.id === task.parentId)) {
        taskIssues.push({ severity: 'error', rule: 'valid-parent', message: `Parent '${task.parentId}' not found` });
      }

      for (const depId of task.depends ?? []) {
        if (!allTasks.some((t) => t.id === depId)) {
          taskIssues.push({ severity: 'warning', rule: 'valid-dependency', message: `Dependency '${depId}' not found` });
        }
      }

      const now = new Date();
      if (task.createdAt && new Date(task.createdAt) > now) {
        taskIssues.push({ severity: 'warning', rule: 'no-future-timestamps', message: 'createdAt in future' });
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
 * @task T4790
 */
export async function coreTaskImport(
  projectRoot: string,
  source: string,
  overwrite?: boolean,
): Promise<{ imported: number; skipped: number; errors: string[]; remapTable?: Record<string, string> }> {
  const accessor = await getAccessor(projectRoot);
  const current = await accessor.loadTaskFile();
  if (!current || !current.tasks) {
    throw new Error('No valid tasks.json found');
  }

  let importData: unknown;
  try {
    importData = JSON.parse(source);
  } catch {
    throw new Error('Invalid JSON in import source');
  }

  let importTasks: TaskRecord[] = [];
  if (Array.isArray(importData)) {
    importTasks = importData as TaskRecord[];
  } else if (typeof importData === 'object' && importData !== null) {
    const data = importData as Record<string, unknown>;
    if (Array.isArray(data.tasks)) {
      importTasks = data.tasks as TaskRecord[];
    }
  }

  if (importTasks.length === 0) {
    return { imported: 0, skipped: 0, errors: ['No tasks found in import source'] };
  }

  const existingIds = new Set(current.tasks.map((t) => t.id));
  const allIds = new Set(current.tasks.map((t) => t.id));
  const errors: string[] = [];
  let imported = 0;
  let skipped = 0;
  const remapTable: Record<string, string> = {};

  let nextIdNum = 0;
  for (const t of current.tasks) {
    const num = parseInt(t.id.replace('T', ''), 10);
    if (!isNaN(num) && num > nextIdNum) nextIdNum = num;
  }

  const tasksList = current.tasks as unknown as TaskRecord[];

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

    if (overwrite && existingIds.has(importTask.id)) {
      const idx = tasksList.findIndex((t) => t.id === importTask.id);
      if (idx !== -1) {
        tasksList[idx] = newTask;
      }
    } else {
      tasksList.push(newTask);
    }

    allIds.add(newId);
    imported++;
  }

  if (imported > 0) {
    await accessor.saveTaskFile(current);
  }

  return {
    imported,
    skipped,
    errors,
    ...(Object.keys(remapTable).length > 0 ? { remapTable } : {}),
  };
}
