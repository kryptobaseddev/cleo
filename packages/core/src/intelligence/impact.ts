/**
 * Impact analysis module - dependency-aware prediction of downstream effects.
 *
 * Builds on the existing dependency graph infrastructure in phases/deps.ts
 * and orchestration/analyze.ts to provide:
 *   - Task impact assessment (direct + transitive dependents)
 *   - Change impact prediction (cancel, block, complete, reprioritize)
 *   - Blast radius calculation (scope quantification)
 *
 * @module intelligence
 */

import type { Task } from '@cleocode/contracts';
import type { DataAccessor } from '../store/data-accessor.js';
import { getAccessor } from '../store/data-accessor.js';
import { getCriticalPath } from '../tasks/graph-ops.js';
import { getParentChain } from '../tasks/hierarchy.js';
import type {
  AffectedTask,
  BlastRadius,
  BlastRadiusSeverity,
  ChangeImpact,
  ChangeType,
  ImpactAssessment,
} from './types.js';

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Load all tasks from the data store.
 */
async function loadAllTasks(accessor: DataAccessor): Promise<Task[]> {
  const { tasks } = await accessor.queryTasks({});
  return tasks;
}

/**
 * Build a reverse adjacency map: taskId -> set of tasks that depend on it.
 * Reuses buildGraph from phases/deps.ts for the forward graph, then inverts.
 */
function buildDependentsMap(tasks: Task[]): Map<string, Set<string>> {
  const dependents = new Map<string, Set<string>>();

  for (const task of tasks) {
    if (!dependents.has(task.id)) {
      dependents.set(task.id, new Set());
    }
    if (task.depends) {
      for (const depId of task.depends) {
        if (!dependents.has(depId)) {
          dependents.set(depId, new Set());
        }
        dependents.get(depId)!.add(task.id);
      }
    }
  }

  return dependents;
}

/**
 * Collect all transitive dependents via BFS.
 * Returns set excluding the source task itself.
 */
function collectTransitiveDependents(
  taskId: string,
  dependentsMap: Map<string, Set<string>>,
): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [taskId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const deps = dependentsMap.get(current);
    if (!deps) continue;

    for (const depId of deps) {
      if (!visited.has(depId)) {
        visited.add(depId);
        queue.push(depId);
      }
    }
  }

  return visited;
}

/**
 * Count tasks that would be blocked (have unmet dependencies) if
 * the given task is not completed.
 */
function countBlockedWork(
  taskId: string,
  transitiveDependents: Set<string>,
  taskMap: Map<string, Task>,
): number {
  let count = 0;

  for (const depId of transitiveDependents) {
    if (depId === taskId) continue; // Exclude the source task itself
    const task = taskMap.get(depId);
    if (!task) continue;
    // A task is considered blocked-work if it has a dependency on the
    // source task (directly or transitively) and is not yet completed.
    if (task.status !== 'done' && task.status !== 'cancelled') {
      count++;
    }
  }

  return count;
}

/**
 * Find epic IDs whose pipelines are affected by changes to a task.
 * A pipeline is affected if the task or any of its transitive dependents
 * belong to that epic's hierarchy.
 */
function findAffectedPipelines(
  taskId: string,
  transitiveDependents: Set<string>,
  tasks: Task[],
): string[] {
  const affectedEpicIds = new Set<string>();
  const allAffectedIds = new Set([taskId, ...transitiveDependents]);

  for (const id of allAffectedIds) {
    const task = tasks.find((t) => t.id === id);
    if (!task) continue;

    // Walk parent chain to find epics
    const ancestors = getParentChain(id, tasks);
    for (const ancestor of ancestors) {
      if (ancestor.type === 'epic') {
        affectedEpicIds.add(ancestor.id);
      }
    }

    // The task itself might be an epic
    if (task.type === 'epic') {
      affectedEpicIds.add(task.id);
    }
  }

  return Array.from(affectedEpicIds);
}

/**
 * Check whether a task lies on the critical path.
 * Reuses getCriticalPath from tasks/graph-ops.ts.
 */
function isTaskOnCriticalPath(taskId: string, tasks: Task[]): boolean {
  const criticalPath = getCriticalPath(tasks);
  return criticalPath.includes(taskId);
}

/**
 * Classify blast radius severity based on project percentage.
 */
function classifySeverity(projectPercentage: number): BlastRadiusSeverity {
  if (projectPercentage <= 1) return 'isolated';
  if (projectPercentage <= 10) return 'moderate';
  if (projectPercentage <= 30) return 'widespread';
  return 'critical';
}

/**
 * Compute the maximum cascade depth via DFS from the source task
 * through its transitive dependents.
 */
function computeCascadeDepth(
  taskId: string,
  dependentsMap: Map<string, Set<string>>,
): number {
  const visited = new Set<string>();

  function dfs(id: string): number {
    if (visited.has(id)) return 0;
    visited.add(id);

    const deps = dependentsMap.get(id);
    if (!deps || deps.size === 0) return 0;

    let maxDepth = 0;
    for (const depId of deps) {
      const depth = dfs(depId);
      if (depth > maxDepth) maxDepth = depth;
    }

    return maxDepth + 1;
  }

  return dfs(taskId);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Analyze the full downstream impact of a task.
 *
 * Computes direct and transitive dependents, affected lifecycle pipelines,
 * blocked work counts, critical path membership, and blast radius.
 *
 * @param taskId - The task to analyze
 * @param accessor - DataAccessor instance (or auto-created from cwd)
 * @param cwd - Working directory (used if accessor is not provided)
 * @returns Full impact assessment
 */
export async function analyzeTaskImpact(
  taskId: string,
  accessor?: DataAccessor,
  cwd?: string,
): Promise<ImpactAssessment> {
  const acc = accessor ?? (await getAccessor(cwd));
  const tasks = await loadAllTasks(acc);
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  if (!taskMap.has(taskId)) {
    return {
      taskId,
      directDependents: [],
      transitiveDependents: [],
      affectedPipelines: [],
      blockedWorkCount: 0,
      isOnCriticalPath: false,
      blastRadius: {
        directCount: 0,
        transitiveCount: 0,
        epicCount: 0,
        projectPercentage: 0,
        severity: 'isolated',
      },
    };
  }

  const dependentsMap = buildDependentsMap(tasks);
  const directDeps = dependentsMap.get(taskId) ?? new Set<string>();
  const transitiveDeps = collectTransitiveDependents(taskId, dependentsMap);

  const affectedPipelines = findAffectedPipelines(taskId, transitiveDeps, tasks);
  const blockedWorkCount = countBlockedWork(taskId, transitiveDeps, taskMap);
  const onCriticalPath = isTaskOnCriticalPath(taskId, tasks);
  const blastRadius = calculateBlastRadiusFromData(
    taskId,
    directDeps,
    transitiveDeps,
    tasks,
  );

  return {
    taskId,
    directDependents: Array.from(directDeps),
    transitiveDependents: Array.from(transitiveDeps),
    affectedPipelines,
    blockedWorkCount,
    isOnCriticalPath: onCriticalPath,
    blastRadius,
  };
}

/**
 * Analyze the downstream effects of a specific change to a task.
 *
 * Predicts what happens when a task is cancelled, blocked, completed,
 * or reprioritized, including cascading status changes.
 *
 * @param taskId - The task being changed
 * @param changeType - The type of change
 * @param accessor - DataAccessor instance (or auto-created from cwd)
 * @param cwd - Working directory (used if accessor is not provided)
 * @returns Predicted change impact
 */
export async function analyzeChangeImpact(
  taskId: string,
  changeType: ChangeType,
  accessor?: DataAccessor,
  cwd?: string,
): Promise<ChangeImpact> {
  const acc = accessor ?? (await getAccessor(cwd));
  const tasks = await loadAllTasks(acc);
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  const sourceTask = taskMap.get(taskId);
  if (!sourceTask) {
    return {
      taskId,
      changeType,
      affectedTasks: [],
      cascadeDepth: 0,
      recommendation: `Task ${taskId} not found.`,
    };
  }

  const dependentsMap = buildDependentsMap(tasks);
  const transitiveDeps = collectTransitiveDependents(taskId, dependentsMap);
  const cascadeDepth = computeCascadeDepth(taskId, dependentsMap);
  const affectedTasks: AffectedTask[] = [];

  switch (changeType) {
    case 'cancel':
      affectedTasks.push(
        ...predictCancelEffects(taskId, transitiveDeps, dependentsMap, taskMap),
      );
      break;
    case 'block':
      affectedTasks.push(
        ...predictBlockEffects(taskId, transitiveDeps, dependentsMap, taskMap),
      );
      break;
    case 'complete':
      affectedTasks.push(
        ...predictCompleteEffects(taskId, transitiveDeps, dependentsMap, taskMap),
      );
      break;
    case 'reprioritize':
      affectedTasks.push(
        ...predictReprioritizeEffects(taskId, transitiveDeps, taskMap),
      );
      break;
  }

  const recommendation = generateRecommendation(
    changeType,
    affectedTasks.length,
    cascadeDepth,
    taskId,
  );

  return {
    taskId,
    changeType,
    affectedTasks,
    cascadeDepth,
    recommendation,
  };
}

/**
 * Calculate the blast radius for a task.
 *
 * Quantifies how many tasks, epics, and what percentage of the project
 * would be impacted by changes to this task.
 *
 * @param taskId - The task to analyze
 * @param accessor - DataAccessor instance (or auto-created from cwd)
 * @param cwd - Working directory (used if accessor is not provided)
 * @returns Blast radius metrics
 */
export async function calculateBlastRadius(
  taskId: string,
  accessor?: DataAccessor,
  cwd?: string,
): Promise<BlastRadius> {
  const acc = accessor ?? (await getAccessor(cwd));
  const tasks = await loadAllTasks(acc);
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  if (!taskMap.has(taskId)) {
    return {
      directCount: 0,
      transitiveCount: 0,
      epicCount: 0,
      projectPercentage: 0,
      severity: 'isolated',
    };
  }

  const dependentsMap = buildDependentsMap(tasks);
  const directDeps = dependentsMap.get(taskId) ?? new Set<string>();
  const transitiveDeps = collectTransitiveDependents(taskId, dependentsMap);

  return calculateBlastRadiusFromData(taskId, directDeps, transitiveDeps, tasks);
}

// ============================================================================
// Change Effect Predictors
// ============================================================================

/**
 * Predict effects of cancelling a task.
 * Direct dependents whose only unmet dependency is this task become orphaned.
 * Transitive dependents that lose their last prerequisite also cascade.
 */
function predictCancelEffects(
  taskId: string,
  transitiveDeps: Set<string>,
  dependentsMap: Map<string, Set<string>>,
  taskMap: Map<string, Task>,
): AffectedTask[] {
  const affected: AffectedTask[] = [];
  const directDeps = dependentsMap.get(taskId) ?? new Set<string>();

  // Direct dependents: they lose a dependency
  for (const depId of directDeps) {
    const task = taskMap.get(depId);
    if (!task || task.status === 'done' || task.status === 'cancelled') continue;

    const otherUnmetDeps = (task.depends ?? []).filter(
      (d) => d !== taskId && taskMap.has(d) && taskMap.get(d)!.status !== 'done' && taskMap.get(d)!.status !== 'cancelled',
    );

    if (otherUnmetDeps.length === 0) {
      // This was the only blocking dep -- task becomes unblocked but orphaned
      affected.push({
        id: depId,
        title: task.title,
        currentStatus: task.status,
        newStatus: task.status === 'blocked' ? 'pending' : undefined,
        reason: 'Direct dependency cancelled; dependency link becomes orphaned.',
      });
    } else {
      affected.push({
        id: depId,
        title: task.title,
        currentStatus: task.status,
        reason: 'Direct dependency cancelled; other dependencies remain.',
      });
    }
  }

  // Transitive dependents (excluding direct)
  for (const depId of transitiveDeps) {
    if (directDeps.has(depId)) continue;
    const task = taskMap.get(depId);
    if (!task || task.status === 'done' || task.status === 'cancelled') continue;

    affected.push({
      id: depId,
      title: task.title,
      currentStatus: task.status,
      reason: 'Transitive dependency cancelled; may cascade through dependency chain.',
    });
  }

  return affected;
}

/**
 * Predict effects of blocking a task.
 * All downstream dependents that are not yet done become cascading-blocked.
 */
function predictBlockEffects(
  taskId: string,
  transitiveDeps: Set<string>,
  dependentsMap: Map<string, Set<string>>,
  taskMap: Map<string, Task>,
): AffectedTask[] {
  const affected: AffectedTask[] = [];

  for (const depId of transitiveDeps) {
    const task = taskMap.get(depId);
    if (!task || task.status === 'done' || task.status === 'cancelled') continue;

    const isDirect = (dependentsMap.get(taskId) ?? new Set()).has(depId);

    affected.push({
      id: depId,
      title: task.title,
      currentStatus: task.status,
      newStatus: 'blocked',
      reason: isDirect
        ? 'Direct dependency blocked; task cannot proceed.'
        : 'Transitive dependency blocked; cascading block through dependency chain.',
    });
  }

  return affected;
}

/**
 * Predict effects of completing a task.
 * Dependents whose last unmet dependency was this task become unblocked.
 */
function predictCompleteEffects(
  taskId: string,
  transitiveDeps: Set<string>,
  dependentsMap: Map<string, Set<string>>,
  taskMap: Map<string, Task>,
): AffectedTask[] {
  const affected: AffectedTask[] = [];
  const directDeps = dependentsMap.get(taskId) ?? new Set<string>();

  for (const depId of directDeps) {
    const task = taskMap.get(depId);
    if (!task || task.status === 'done' || task.status === 'cancelled') continue;

    const remainingUnmet = (task.depends ?? []).filter(
      (d) =>
        d !== taskId &&
        taskMap.has(d) &&
        taskMap.get(d)!.status !== 'done' &&
        taskMap.get(d)!.status !== 'cancelled',
    );

    if (remainingUnmet.length === 0) {
      affected.push({
        id: depId,
        title: task.title,
        currentStatus: task.status,
        newStatus: task.status === 'blocked' ? 'pending' : task.status,
        reason: 'All dependencies met; task becomes unblocked.',
      });
    } else {
      affected.push({
        id: depId,
        title: task.title,
        currentStatus: task.status,
        reason: `Dependency completed; ${remainingUnmet.length} other dependency(ies) still unmet.`,
      });
    }
  }

  // Note transitive downstream tasks that benefit indirectly
  for (const depId of transitiveDeps) {
    if (directDeps.has(depId)) continue; // Already handled above
    const task = taskMap.get(depId);
    if (!task || task.status === 'done' || task.status === 'cancelled') continue;

    affected.push({
      id: depId,
      title: task.title,
      currentStatus: task.status,
      reason: 'Upstream dependency completed; may unblock cascading work.',
    });
  }

  return affected;
}

/**
 * Predict effects of reprioritizing a task.
 * Downstream tasks may need reordering in execution waves.
 */
function predictReprioritizeEffects(
  taskId: string,
  transitiveDeps: Set<string>,
  taskMap: Map<string, Task>,
): AffectedTask[] {
  const affected: AffectedTask[] = [];

  for (const depId of transitiveDeps) {
    const task = taskMap.get(depId);
    if (!task || task.status === 'done' || task.status === 'cancelled') continue;

    const isDirect = (task.depends ?? []).includes(taskId);
    affected.push({
      id: depId,
      title: task.title,
      currentStatus: task.status,
      reason: isDirect
        ? `Direct dependency ${taskId} reprioritized; execution order may change.`
        : `Upstream dependency ${taskId} reprioritized; cascading reorder possible.`,
    });
  }

  return affected;
}

// ============================================================================
// Blast Radius Computation
// ============================================================================

/**
 * Internal blast radius computation from pre-computed dependency data.
 */
function calculateBlastRadiusFromData(
  taskId: string,
  directDeps: Set<string>,
  transitiveDeps: Set<string>,
  tasks: Task[],
): BlastRadius {
  const totalTasks = tasks.length;

  // Find affected epics
  const affectedEpicIds = new Set<string>();
  const allAffectedIds = new Set([taskId, ...transitiveDeps]);

  for (const id of allAffectedIds) {
    const task = tasks.find((t) => t.id === id);
    if (!task) continue;

    const ancestors = getParentChain(id, tasks);
    for (const ancestor of ancestors) {
      if (ancestor.type === 'epic') {
        affectedEpicIds.add(ancestor.id);
      }
    }

    if (task.type === 'epic') {
      affectedEpicIds.add(task.id);
    }
  }

  const projectPercentage =
    totalTasks > 0
      ? Math.round((transitiveDeps.size / totalTasks) * 100 * 100) / 100
      : 0;

  return {
    directCount: directDeps.size,
    transitiveCount: transitiveDeps.size,
    epicCount: affectedEpicIds.size,
    projectPercentage,
    severity: classifySeverity(projectPercentage),
  };
}

// ============================================================================
// Recommendation Generator
// ============================================================================

/**
 * Generate a human-readable recommendation based on impact analysis.
 */
function generateRecommendation(
  changeType: ChangeType,
  affectedCount: number,
  cascadeDepth: number,
  taskId: string,
): string {
  if (affectedCount === 0) {
    return `No downstream tasks affected. Safe to ${changeType} ${taskId}.`;
  }

  const severity =
    affectedCount > 10
      ? 'High'
      : affectedCount > 3
        ? 'Moderate'
        : 'Low';

  switch (changeType) {
    case 'cancel':
      return (
        `${severity} impact: cancelling ${taskId} affects ${affectedCount} downstream task(s) ` +
        `with cascade depth ${cascadeDepth}. Review affected tasks for orphaned dependencies.`
      );
    case 'block':
      return (
        `${severity} impact: blocking ${taskId} would cascade-block ${affectedCount} downstream task(s) ` +
        `across ${cascadeDepth} level(s). Consider resolving the blocker to unblock the pipeline.`
      );
    case 'complete':
      return (
        `Completing ${taskId} would unblock or partially unblock ${affectedCount} downstream task(s). ` +
        `Cascade depth: ${cascadeDepth}.`
      );
    case 'reprioritize':
      return (
        `${severity} impact: reprioritizing ${taskId} may reorder ${affectedCount} downstream task(s) ` +
        `across ${cascadeDepth} level(s) of dependencies.`
      );
  }
}
