/**
 * Dependency checking - validate task dependency graphs.
 * Ported from lib/tasks/dependency-check.sh
 *
 * @epic T4454
 * @task T4529
 */

import type { Task } from '@cleocode/contracts';
import type { DataAccessor } from '../store/data-accessor.js';

/** Result of a dependency validation check. */
export interface DependencyCheckResult {
  valid: boolean;
  errors: DependencyError[];
  warnings: DependencyWarning[];
}

/** A dependency error. */
export interface DependencyError {
  code: string;
  taskId: string;
  message: string;
  relatedIds?: string[];
}

/** A dependency warning. */
export interface DependencyWarning {
  code: string;
  taskId: string;
  message: string;
}

/**
 * Test whether an observed dependency status satisfies execution readiness.
 *
 * @remarks
 * Only done and archived records satisfy the spawn contract. Cancelled work,
 * missing status and unrecognized input remain unsatisfied. Completion waivers
 * are a separate policy and are not applied by this predicate.
 *
 * @param status - Status observed from a dependency record, if available.
 * @returns Whether the dependency supplies satisfactory readiness evidence.
 * @example
 * ```ts
 * isReadinessDependencySatisfied('archived'); // true
 * isReadinessDependencySatisfied('cancelled'); // false
 * ```
 */
export function isReadinessDependencySatisfied(status: string | undefined): boolean {
  return status === 'done' || status === 'archived';
}

/**
 * Return dependencies that prevent a task from being spawned.
 *
 * @remarks
 * Readiness follows the spawn contract: only done and archived dependencies
 * satisfy it. Missing tasks and cancelled work remain blockers. Completion
 * waivers apply to completion validation, not to this readiness decision.
 * The caller owns loading the dependency population and surfacing read failures.
 *
 * @param depends - The task's explicit hard dependency identifiers.
 * @param taskLookup - Successfully loaded dependency records, keyed by identity.
 * @returns Blocking identifiers in their original dependency order.
 *
 * @example
 * ```ts
 * const blockers = getReadinessDependencyBlockers(['T1'], new Map());
 * // blockers is ['T1']: absence is not evidence of completed work.
 * ```
 */
export function getReadinessDependencyBlockers(
  depends: readonly string[] | undefined,
  taskLookup: ReadonlyMap<string, Task>,
): string[] {
  return (depends ?? []).filter((id) => {
    const status = taskLookup.get(id)?.status;
    return !isReadinessDependencySatisfied(status);
  });
}

/**
 * Resolve explicit hard dependency evidence beyond a selected task population.
 *
 * @remarks
 * The returned lookup includes the selected rows and canonically loaded external
 * dependencies, including archived records. It is evidence for readiness, not a
 * replacement selection for counts, containment, scoring, or candidate discovery.
 * Missing records remain absent so the readiness policy can report their IDs as
 * blockers. Read failures propagate and never become a successful empty lookup.
 *
 * @param selected - Successfully loaded tasks whose dependencies will be assessed.
 * @param accessor - Canonical accessor bound to the owning project.
 * @returns A separate identity lookup containing selected and external evidence.
 * @throws Error when the required canonical dependency read fails.
 * @example
 * ```ts
 * const lookup = await loadReadinessDependencyLookup(selectedTasks, accessor);
 * const blockers = getReadinessDependencyBlockers(selectedTasks[0]?.depends, lookup);
 * ```
 */
export async function loadReadinessDependencyLookup(
  selected: readonly Task[],
  accessor: DataAccessor,
): Promise<Map<string, Task>> {
  const lookup = new Map(selected.map((task) => [task.id, task]));
  const externalIds = [...new Set(selected.flatMap((task) => task.depends ?? []))].filter(
    (id) => !lookup.has(id),
  );
  if (externalIds.length > 0) {
    for (const task of await accessor.loadTasks(externalIds)) lookup.set(task.id, task);
  }
  return lookup;
}

/**
 * Detect circular dependencies using DFS.
 * Returns the cycle path if found, empty array otherwise.
 */
export function detectCircularDeps(taskId: string, tasks: Task[]): string[] {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  const path: string[] = [];

  function dfs(id: string): string[] {
    visited.add(id);
    recursionStack.add(id);
    path.push(id);

    const task = taskMap.get(id);
    if (task?.depends) {
      for (const depId of task.depends) {
        if (!visited.has(depId)) {
          const cycle = dfs(depId);
          if (cycle.length > 0) return cycle;
        } else if (recursionStack.has(depId)) {
          // Found cycle - return path from depId to current + depId
          const cycleStart = path.indexOf(depId);
          return [...path.slice(cycleStart), depId];
        }
      }
    }

    path.pop();
    recursionStack.delete(id);
    return [];
  }

  return dfs(taskId);
}

/**
 * Check if adding a dependency would create a cycle.
 */
export function wouldCreateCycle(fromId: string, toId: string, tasks: Task[]): boolean {
  // Temporarily add the dependency and check
  const modified = tasks.map((t) => {
    if (t.id === fromId) {
      return { ...t, depends: [...(t.depends ?? []), toId] };
    }
    return t;
  });
  return detectCircularDeps(fromId, modified).length > 0;
}

/**
 * Get tasks that are blocked (have unmet dependencies).
 *
 * Excludes tasks in terminal states (`done`, `cancelled`, `archived`) and the
 * Tier 2 proposal queue (`proposed`) — `proposed` tasks are not part of the
 * active execution dependency graph.
 *
 * `archived` tasks satisfy dependencies (treated equivalent to done) — T1954.
 */
export function getBlockedTasks(tasks: Task[]): Task[] {
  const completedIds = new Set(
    tasks
      .filter((t) => t.status === 'done' || t.status === 'cancelled' || t.status === 'archived')
      .map((t) => t.id),
  );

  return tasks.filter((t) => {
    if (!t.depends?.length) return false;
    if (t.status === 'done' || t.status === 'cancelled') return false;
    if (t.status === 'archived') return false;
    if (t.status === 'proposed') return false;
    return t.depends.some((depId) => !completedIds.has(depId));
  });
}

/**
 * Get tasks that are ready (all dependencies met).
 *
 * Excludes tasks in terminal states (`done`, `cancelled`, `archived`) and the
 * Tier 2 proposal queue (`proposed`). `proposed` tasks represent agent-suggested
 * work pending owner review and must never be auto-picked by the sentient loop
 * or orchestrator (T946 / Round 2 audit §8).
 *
 * `archived` tasks satisfy dependencies (treated equivalent to done) — T1954.
 */
export function getReadyTasks(tasks: Task[]): Task[] {
  const completedIds = new Set(
    tasks
      .filter((t) => t.status === 'done' || t.status === 'cancelled' || t.status === 'archived')
      .map((t) => t.id),
  );

  return tasks.filter((t) => {
    if (t.status === 'done' || t.status === 'cancelled') return false;
    if (t.status === 'archived') return false;
    if (t.status === 'proposed') return false;
    if (!t.depends?.length) return true;
    return t.depends.every((depId) => completedIds.has(depId));
  });
}

/**
 * Get tasks that depend on a given task.
 */
export function getDependents(taskId: string, tasks: Task[]): Task[] {
  return tasks.filter((t) => t.depends?.includes(taskId));
}

/**
 * Get dependent IDs.
 */
export function getDependentIds(taskId: string, tasks: Task[]): string[] {
  return getDependents(taskId, tasks).map((t) => t.id);
}

/**
 * Get unresolved dependencies for a task (deps that are not done/cancelled/archived).
 *
 * `archived` tasks satisfy dependencies (treated equivalent to done) — T1954.
 */
export function getUnresolvedDeps(taskId: string, tasks: Task[]): string[] {
  const task = tasks.find((t) => t.id === taskId);
  if (!task?.depends?.length) return [];

  const completedIds = new Set(
    tasks
      .filter((t) => t.status === 'done' || t.status === 'cancelled' || t.status === 'archived')
      .map((t) => t.id),
  );

  return task.depends.filter((depId) => !completedIds.has(depId));
}

/**
 * Validate dependencies for missing references.
 */
export function validateDependencyRefs(tasks: Task[]): DependencyError[] {
  const taskIds = new Set(tasks.map((t) => t.id));
  const errors: DependencyError[] = [];

  for (const task of tasks) {
    if (!task.depends?.length) continue;
    for (const depId of task.depends) {
      if (!taskIds.has(depId)) {
        errors.push({
          code: 'E_DEP_NOT_FOUND',
          taskId: task.id,
          message: `Task ${task.id} depends on ${depId}, which does not exist`,
          relatedIds: [depId],
        });
      }
    }
  }

  return errors;
}

/**
 * Full dependency graph validation.
 */
export function validateDependencies(tasks: Task[]): DependencyCheckResult {
  const errors: DependencyError[] = [];
  const warnings: DependencyWarning[] = [];

  // Check for missing references
  errors.push(...validateDependencyRefs(tasks));

  // Check for circular dependencies
  const visited = new Set<string>();
  for (const task of tasks) {
    if (visited.has(task.id)) continue;
    if (!task.depends?.length) continue;

    const cycle = detectCircularDeps(task.id, tasks);
    if (cycle.length > 0) {
      errors.push({
        code: 'E_CIRCULAR_DEP',
        taskId: task.id,
        message: `Circular dependency detected: ${cycle.join(' -> ')}`,
        relatedIds: cycle,
      });
      // Mark all in cycle as visited to avoid duplicate reports
      for (const id of cycle) {
        visited.add(id);
      }
    }
  }

  // Check for self-dependencies
  for (const task of tasks) {
    if (task.depends?.includes(task.id)) {
      errors.push({
        code: 'E_SELF_DEP',
        taskId: task.id,
        message: `Task ${task.id} depends on itself`,
      });
    }
  }

  // Warn about completed tasks with unmet dependencies
  for (const task of tasks) {
    if (task.status === 'done' && task.depends?.length) {
      const unresolved = getUnresolvedDeps(task.id, tasks);
      if (unresolved.length > 0) {
        warnings.push({
          code: 'W_COMPLETED_WITH_UNMET_DEPS',
          taskId: task.id,
          message: `Completed task ${task.id} has unmet dependencies: ${unresolved.join(', ')}`,
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Topological sort of tasks by dependencies.
 * Returns sorted task IDs or null if cycle detected.
 */
export function topologicalSort(tasks: Task[]): string[] | null {
  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>();

  // Initialize
  for (const task of tasks) {
    inDegree.set(task.id, 0);
    adjList.set(task.id, []);
  }

  // Build adjacency list (dependency -> dependent)
  for (const task of tasks) {
    if (!task.depends?.length) continue;
    for (const depId of task.depends) {
      if (adjList.has(depId)) {
        adjList.get(depId)!.push(task.id);
        inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
      }
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    sorted.push(id);

    for (const dependent of adjList.get(id) ?? []) {
      const newDegree = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, newDegree);
      if (newDegree === 0) queue.push(dependent);
    }
  }

  // If not all tasks sorted, there's a cycle
  if (sorted.length !== tasks.length) return null;
  return sorted;
}

/**
 * Walk upstream recursively through a task's dependency chain.
 * Returns all non-done/non-cancelled/non-archived dependency IDs (deduplicated).
 * Uses a visited set for cycle protection.
 *
 * `archived` tasks satisfy dependencies (treated equivalent to done) — T1954.
 */
export function getTransitiveBlockers(taskId: string, tasks: Task[]): string[] {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const task = taskMap.get(taskId);
  if (!task?.depends?.length) return [];

  const blockers = new Set<string>();
  const visited = new Set<string>();

  function walk(id: string): void {
    if (visited.has(id)) return;
    visited.add(id);

    const t = taskMap.get(id);
    if (!t?.depends?.length) return;

    for (const depId of t.depends) {
      const dep = taskMap.get(depId);
      if (!dep) continue;
      if (dep.status === 'done' || dep.status === 'cancelled' || dep.status === 'archived')
        continue;
      blockers.add(depId);
      walk(depId);
    }
  }

  walk(taskId);
  return [...blockers];
}

/**
 * From the transitive blockers, return only "leaf" blockers — those whose
 * own dependencies are all resolved (done/cancelled/archived) or that have no
 * dependencies at all. These are the root-cause tasks that need action first.
 *
 * `archived` tasks satisfy dependencies (treated equivalent to done) — T1954.
 */
export function getLeafBlockers(taskId: string, tasks: Task[]): string[] {
  const blockerIds = getTransitiveBlockers(taskId, tasks);
  if (blockerIds.length === 0) return [];

  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const completedIds = new Set(
    tasks
      .filter((t) => t.status === 'done' || t.status === 'cancelled' || t.status === 'archived')
      .map((t) => t.id),
  );

  return blockerIds.filter((id) => {
    const t = taskMap.get(id);
    if (!t?.depends?.length) return true;
    return t.depends.every((depId) => completedIds.has(depId));
  });
}
