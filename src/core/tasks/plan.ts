/**
 * Composite planning view - aggregates multiple task queries for planning.
 * @task T4914
 * @epic T4454
 */

import { getAccessor } from '../../store/data-accessor.js';
import { readJsonFile, getDataPath } from '../../mcp/engine/store.js';

// Task record shape for internal use
interface TaskRecord {
  id: string;
  title: string;
  status: string;
  priority: string;
  type?: string;
  phase?: string;
  parentId?: string | null;
  labels?: string[];
  origin?: string;
  depends?: string[];
  blockedBy?: string;
  createdAt: string;
  [key: string]: unknown;
}

/** In-progress epic entry. */
export interface InProgressEpic {
  epicId: string;
  epicTitle: string;
  activeTasks: number;
  completionPercent: number;
}

/** Ready task entry with leverage analysis. */
export interface ReadyTask {
  id: string;
  title: string;
  epicId: string;
  leverage: number;
  score: number;
  reasons: string[];
}

/** Blocked task entry. */
export interface BlockedTask {
  id: string;
  title: string;
  blockedBy: string[];
  blocksCount: number;
}

/** Open bug entry. */
export interface OpenBug {
  id: string;
  title: string;
  priority: string;
  epicId: string;
}

/** Planning metrics. */
export interface PlanMetrics {
  totalEpics: number;
  activeEpics: number;
  totalTasks: number;
  actionable: number;
  blocked: number;
  openBugs: number;
  avgLeverage: number;
}

/** Composite planning view result. */
export interface PlanResult {
  inProgress: InProgressEpic[];
  ready: ReadyTask[];
  blocked: BlockedTask[];
  openBugs: OpenBug[];
  metrics: PlanMetrics;
}

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

/**
 * Calculate leverage score for a task based on how many other tasks depend on it.
 */
function calculateLeverage(taskId: string, taskMap: Map<string, TaskRecord>): number {
  let leverage = 0;
  for (const task of taskMap.values()) {
    if (task.depends?.includes(taskId)) {
      leverage++;
    }
  }
  return leverage;
}

/**
 * Find the epic ID for a task (parent epic, not immediate parent).
 */
function findEpicId(task: TaskRecord, taskMap: Map<string, TaskRecord>): string {
  let current: TaskRecord | undefined = task;
  const visited = new Set<string>();

  while (current?.parentId && !visited.has(current.id)) {
    visited.add(current.id);
    const parent = taskMap.get(current.parentId);
    if (!parent) break;
    if (parent.type === 'epic') {
      return parent.id;
    }
    current = parent;
  }

  // If task itself is an epic
  if (task.type === 'epic') {
    return task.id;
  }

  // Return parentId as fallback, or task's own id
  return task.parentId ?? task.id;
}



/**
 * Get current phase from tasks.json.
 */
function getCurrentPhase(projectRoot: string): string | null {
  const taskPath = getDataPath(projectRoot, 'tasks.json');
  const todoMeta = readJsonFile<{ project?: { currentPhase?: string | null } }>(taskPath);
  return todoMeta?.project?.currentPhase ?? null;
}

/**
 * Calculate completion percentage for an epic.
 */
function calculateEpicCompletion(epicId: string, taskMap: Map<string, TaskRecord>): { activeTasks: number; completionPercent: number } {
  let totalTasks = 0;
  let completedTasks = 0;
  let activeTasks = 0;

  // Count direct children and their descendants
  const collectTasks = (parentId: string): void => {
    for (const task of taskMap.values()) {
      if (task.parentId === parentId) {
        totalTasks++;
        if (task.status === 'done' || task.status === 'cancelled') {
          completedTasks++;
        }
        if (task.status === 'active') {
          activeTasks++;
        }
        // Recursively count descendants
        collectTasks(task.id);
      }
    }
  };

  collectTasks(epicId);

  const completionPercent = totalTasks > 0
    ? Math.round((completedTasks / totalTasks) * 100)
    : 0;

  return { activeTasks, completionPercent };
}

/**
 * Build composite planning view.
 * @task T4914
 */
export async function coreTaskPlan(projectRoot: string): Promise<PlanResult> {
  const allTasks = await loadAllTasks(projectRoot);
  const taskMap = new Map(allTasks.map((t) => [t.id, t]));
  const currentPhase = getCurrentPhase(projectRoot);

  // ========================================================================
  // 1. In-Progress Epics (epics with active status)
  // ========================================================================
  const inProgressEpics: InProgressEpic[] = [];
  for (const task of allTasks) {
    if (task.type === 'epic' && task.status === 'active') {
      const { activeTasks, completionPercent } = calculateEpicCompletion(task.id, taskMap);
      inProgressEpics.push({
        epicId: task.id,
        epicTitle: task.title,
        activeTasks,
        completionPercent,
      });
    }
  }

  // ========================================================================
  // 2. Ready Tasks (pending tasks with deps satisfied)
  // ========================================================================
  const readyTasks: ReadyTask[] = [];
  const pendingTasks = allTasks.filter((t) => t.status === 'pending');

  for (const task of pendingTasks) {
    if (depsReady(task, taskMap)) {
      const leverage = calculateLeverage(task.id, taskMap);
      const epicId = findEpicId(task, taskMap);

      // Calculate score using same logic as tasks.next
      const reasons: string[] = [];
      let score = 0;

      score += PRIORITY_SCORE[task.priority] ?? 50;
      reasons.push(`priority: ${task.priority} (+${PRIORITY_SCORE[task.priority] ?? 50})`);

      if (currentPhase && task.phase === currentPhase) {
        score += 20;
        reasons.push(`phase alignment: ${currentPhase} (+20)`);
      }

      score += 10;
      reasons.push('all dependencies satisfied (+10)');

      if (task.createdAt) {
        const ageMs = Date.now() - new Date(task.createdAt).getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        if (ageDays > 7) {
          const ageBonus = Math.min(15, Math.floor(ageDays / 7));
          score += ageBonus;
          reasons.push(`age: ${Math.floor(ageDays)} days (+${ageBonus})`);
        }
      }

      // Add leverage bonus to score
      if (leverage > 0) {
        score += leverage * 5;
        reasons.push(`leverage: unblocks ${leverage} task(s) (+${leverage * 5})`);
      }

      readyTasks.push({
        id: task.id,
        title: task.title,
        epicId,
        leverage,
        score,
        reasons,
      });
    }
  }

  // Sort by score descending
  readyTasks.sort((a, b) => b.score - a.score);

  // ========================================================================
  // 3. Blocked Tasks
  // ========================================================================
  const blockedTasks: BlockedTask[] = [];

  // Tasks with blocked status
  for (const task of allTasks) {
    if (task.status === 'blocked') {
      const blockedBy: string[] = [];
      if (task.blockedBy) {
        blockedBy.push(task.blockedBy);
      }
      if (task.depends) {
        for (const depId of task.depends) {
          const dep = taskMap.get(depId);
          if (dep && dep.status !== 'done' && dep.status !== 'cancelled') {
            blockedBy.push(depId);
          }
        }
      }

      // Calculate how many tasks this blocks
      let blocksCount = 0;
      for (const t of allTasks) {
        if (t.depends?.includes(task.id)) {
          blocksCount++;
        }
      }

      blockedTasks.push({
        id: task.id,
        title: task.title,
        blockedBy,
        blocksCount,
      });
    }
  }

  // Tasks with unresolved dependencies (pending + has incomplete deps)
  for (const task of allTasks) {
    if (task.status === 'pending' && task.depends && task.depends.length > 0) {
      const hasUnresolvedDeps = task.depends.some((depId) => {
        const dep = taskMap.get(depId);
        return dep && dep.status !== 'done' && dep.status !== 'cancelled';
      });

      if (hasUnresolvedDeps && !blockedTasks.some((b) => b.id === task.id)) {
        const blockedBy = task.depends.filter((depId) => {
          const dep = taskMap.get(depId);
          return dep && dep.status !== 'done' && dep.status !== 'cancelled';
        });

        // Calculate how many tasks this blocks
        let blocksCount = 0;
        for (const t of allTasks) {
          if (t.depends?.includes(task.id)) {
            blocksCount++;
          }
        }

        blockedTasks.push({
          id: task.id,
          title: task.title,
          blockedBy,
          blocksCount,
        });
      }
    }
  }

  // ========================================================================
  // 4. Open Bugs (origin:bug-report OR label:bug)
  // ========================================================================
  const openBugs: OpenBug[] = [];

  for (const task of allTasks) {
    const isBug = task.origin === 'bug-report' || task.labels?.includes('bug');
    const isOpen = task.status !== 'done' && task.status !== 'cancelled';

    if (isBug && isOpen) {
      const epicId = findEpicId(task, taskMap);
      openBugs.push({
        id: task.id,
        title: task.title,
        priority: task.priority,
        epicId,
      });
    }
  }

  // ========================================================================
  // 5. Metrics
  // ========================================================================
  const epics = allTasks.filter((t) => t.type === 'epic');
  const activeEpics = epics.filter((t) => t.status === 'active').length;

  const actionable = allTasks.filter((t) =>
    (t.status === 'pending' || t.status === 'active') &&
    !blockedTasks.some((b) => b.id === t.id)
  ).length;

  const blocked = blockedTasks.length;

  // Calculate average leverage across all tasks
  let totalLeverage = 0;
  for (const task of allTasks) {
    totalLeverage += calculateLeverage(task.id, taskMap);
  }
  const avgLeverage = allTasks.length > 0
    ? Math.round((totalLeverage / allTasks.length) * 100) / 100
    : 0;

  const metrics: PlanMetrics = {
    totalEpics: epics.length,
    activeEpics,
    totalTasks: allTasks.length,
    actionable,
    blocked,
    openBugs: openBugs.length,
    avgLeverage,
  };

  return {
    inProgress: inProgressEpics,
    ready: readyTasks,
    blocked: blockedTasks,
    openBugs,
    metrics,
  };
}
