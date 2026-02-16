/**
 * Graph cache - memoized dependency graph operations.
 * Ported from lib/tasks/graph-cache.sh
 *
 * @epic T4454
 * @task T4529
 */

import type { Task } from '../../types/task.js';
import { getDescendantIds, getChildIds } from './hierarchy.js';
import { getDependentIds } from './dependency-check.js';
import { computeDependencyWaves, type DependencyWave } from './graph-ops.js';

/** Cache entry with TTL tracking. */
interface CacheEntry<T> {
  value: T;
  timestamp: number;
}

/**
 * Graph cache for expensive dependency calculations.
 * Automatically invalidates when tasks change.
 */
export class GraphCache {
  private descendantsCache = new Map<string, CacheEntry<string[]>>();
  private childrenCache = new Map<string, CacheEntry<string[]>>();
  private dependentsCache = new Map<string, CacheEntry<string[]>>();
  private wavesCache: CacheEntry<DependencyWave[]> | null = null;
  private taskChecksum: string = '';
  private ttlMs: number;

  constructor(options?: { ttlMs?: number }) {
    this.ttlMs = options?.ttlMs ?? 30_000; // 30 second default TTL
  }

  /**
   * Compute a simple checksum from task data to detect changes.
   */
  private computeChecksum(tasks: Task[]): string {
    // Use task count + IDs + statuses + deps as a quick checksum
    const parts = tasks.map(
      (t) => `${t.id}:${t.status}:${t.parentId ?? ''}:${(t.depends ?? []).join(',')}`,
    );
    return parts.sort().join('|');
  }

  /**
   * Check if cache is still valid for given tasks.
   */
  private isValid(tasks: Task[]): boolean {
    return this.computeChecksum(tasks) === this.taskChecksum;
  }

  /**
   * Check if a cache entry has expired.
   */
  private isExpired<T>(entry: CacheEntry<T>): boolean {
    return Date.now() - entry.timestamp > this.ttlMs;
  }

  /**
   * Invalidate all caches.
   */
  invalidate(): void {
    this.descendantsCache.clear();
    this.childrenCache.clear();
    this.dependentsCache.clear();
    this.wavesCache = null;
    this.taskChecksum = '';
  }

  /**
   * Ensure cache is fresh for the given task set.
   */
  private ensureFresh(tasks: Task[]): void {
    if (!this.isValid(tasks)) {
      this.invalidate();
      this.taskChecksum = this.computeChecksum(tasks);
    }
  }

  /**
   * Get descendants of a task (cached).
   */
  getDescendants(taskId: string, tasks: Task[]): string[] {
    this.ensureFresh(tasks);

    const cached = this.descendantsCache.get(taskId);
    if (cached && !this.isExpired(cached)) {
      return cached.value;
    }

    const result = getDescendantIds(taskId, tasks);
    this.descendantsCache.set(taskId, { value: result, timestamp: Date.now() });
    return result;
  }

  /**
   * Get children of a task (cached).
   */
  getChildren(taskId: string, tasks: Task[]): string[] {
    this.ensureFresh(tasks);

    const cached = this.childrenCache.get(taskId);
    if (cached && !this.isExpired(cached)) {
      return cached.value;
    }

    const result = getChildIds(taskId, tasks);
    this.childrenCache.set(taskId, { value: result, timestamp: Date.now() });
    return result;
  }

  /**
   * Get dependents of a task (cached).
   */
  getDependents(taskId: string, tasks: Task[]): string[] {
    this.ensureFresh(tasks);

    const cached = this.dependentsCache.get(taskId);
    if (cached && !this.isExpired(cached)) {
      return cached.value;
    }

    const result = getDependentIds(taskId, tasks);
    this.dependentsCache.set(taskId, { value: result, timestamp: Date.now() });
    return result;
  }

  /**
   * Get dependency waves (cached).
   */
  getWaves(tasks: Task[]): DependencyWave[] {
    this.ensureFresh(tasks);

    if (this.wavesCache && !this.isExpired(this.wavesCache)) {
      return this.wavesCache.value;
    }

    const result = computeDependencyWaves(tasks);
    this.wavesCache = { value: result, timestamp: Date.now() };
    return result;
  }

  /**
   * Get cache statistics.
   */
  getStats(): {
    descendantsSize: number;
    childrenSize: number;
    dependentsSize: number;
    hasWaves: boolean;
  } {
    return {
      descendantsSize: this.descendantsCache.size,
      childrenSize: this.childrenCache.size,
      dependentsSize: this.dependentsCache.size,
      hasWaves: this.wavesCache !== null,
    };
  }
}
