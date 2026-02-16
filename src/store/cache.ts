/**
 * Index caching for O(1) label/phase/hierarchy lookups.
 * Ported from lib/data/cache.sh
 *
 * @epic T4454
 * @task T4530
 */

import type { Task } from '../types/task.js';

/** Cache index mapping labels/phases to task IDs. */
export type IndexMap = Map<string, string[]>;

/**
 * In-memory cache for task indices with checksum-based staleness detection.
 */
export class TaskCache {
  private labelIndex: IndexMap = new Map();
  private phaseIndex: IndexMap = new Map();
  private parentIndex = new Map<string, string | null>();
  private childrenIndex = new Map<string, string[]>();
  private depthIndex = new Map<string, number>();
  private checksum = '';
  private initialized = false;

  /**
   * Compute a checksum from task data for staleness detection.
   */
  private computeChecksum(tasks: Task[]): string {
    return tasks
      .map((t) => `${t.id}:${t.status}:${t.parentId ?? ''}:${t.phase ?? ''}:${(t.labels ?? []).join(',')}`)
      .sort()
      .join('|');
  }

  /**
   * Initialize or rebuild cache from tasks.
   * Returns true if cache was rebuilt, false if already valid.
   */
  init(tasks: Task[]): boolean {
    const newChecksum = this.computeChecksum(tasks);
    if (this.initialized && newChecksum === this.checksum) {
      return false;
    }

    this.buildLabelIndex(tasks);
    this.buildPhaseIndex(tasks);
    this.buildHierarchyIndex(tasks);
    this.checksum = newChecksum;
    this.initialized = true;
    return true;
  }

  private buildLabelIndex(tasks: Task[]): void {
    this.labelIndex.clear();
    for (const task of tasks) {
      if (!task.labels?.length) continue;
      for (const label of task.labels) {
        const existing = this.labelIndex.get(label) ?? [];
        existing.push(task.id);
        this.labelIndex.set(label, existing);
      }
    }
  }

  private buildPhaseIndex(tasks: Task[]): void {
    this.phaseIndex.clear();
    for (const task of tasks) {
      if (!task.phase) continue;
      const existing = this.phaseIndex.get(task.phase) ?? [];
      existing.push(task.id);
      this.phaseIndex.set(task.phase, existing);
    }
  }

  private buildHierarchyIndex(tasks: Task[]): void {
    this.parentIndex.clear();
    this.childrenIndex.clear();
    this.depthIndex.clear();

    const taskMap = new Map(tasks.map((t) => [t.id, t]));

    for (const task of tasks) {
      this.parentIndex.set(task.id, task.parentId ?? null);
      if (task.parentId) {
        const siblings = this.childrenIndex.get(task.parentId) ?? [];
        siblings.push(task.id);
        this.childrenIndex.set(task.parentId, siblings);
      }
    }

    // Compute depths
    for (const task of tasks) {
      let depth = 0;
      let current = task;
      const visited = new Set<string>();
      while (current.parentId && !visited.has(current.parentId)) {
        visited.add(current.parentId);
        const parent = taskMap.get(current.parentId);
        if (!parent) break;
        depth++;
        current = parent;
      }
      this.depthIndex.set(task.id, depth);
    }
  }

  /** Get task IDs by label. */
  getTasksByLabel(label: string): string[] {
    return this.labelIndex.get(label) ?? [];
  }

  /** Get task IDs by phase. */
  getTasksByPhase(phase: string): string[] {
    return this.phaseIndex.get(phase) ?? [];
  }

  /** Get all labels. */
  getAllLabels(): string[] {
    return [...this.labelIndex.keys()];
  }

  /** Get all phases. */
  getAllPhases(): string[] {
    return [...this.phaseIndex.keys()];
  }

  /** Get label count for a specific label. */
  getLabelCount(label: string): number {
    return this.getTasksByLabel(label).length;
  }

  /** Get parent ID for a task. */
  getParent(taskId: string): string | null {
    return this.parentIndex.get(taskId) ?? null;
  }

  /** Get children IDs for a task. */
  getChildren(taskId: string): string[] {
    return this.childrenIndex.get(taskId) ?? [];
  }

  /** Get depth for a task. */
  getDepth(taskId: string): number {
    return this.depthIndex.get(taskId) ?? 0;
  }

  /** Get child count. */
  getChildCount(taskId: string): number {
    return this.getChildren(taskId).length;
  }

  /** Get root tasks (no parent). */
  getRootTasks(): string[] {
    return [...this.parentIndex.entries()]
      .filter(([, parent]) => parent === null)
      .map(([id]) => id);
  }

  /** Get leaf tasks (no children). */
  getLeafTasks(): string[] {
    const parentSet = new Set(this.childrenIndex.keys());
    return [...this.parentIndex.keys()].filter((id) => !parentSet.has(id) || this.getChildCount(id) === 0);
  }

  /** Force invalidation and rebuild. */
  invalidate(): void {
    this.labelIndex.clear();
    this.phaseIndex.clear();
    this.parentIndex.clear();
    this.childrenIndex.clear();
    this.depthIndex.clear();
    this.checksum = '';
    this.initialized = false;
  }

  /** Get cache statistics. */
  getStats(): {
    initialized: boolean;
    labelCount: number;
    phaseCount: number;
    taskCount: number;
    maxDepth: number;
  } {
    let maxDepth = 0;
    for (const d of this.depthIndex.values()) {
      if (d > maxDepth) maxDepth = d;
    }
    return {
      initialized: this.initialized,
      labelCount: this.labelIndex.size,
      phaseCount: this.phaseIndex.size,
      taskCount: this.parentIndex.size,
      maxDepth,
    };
  }
}
