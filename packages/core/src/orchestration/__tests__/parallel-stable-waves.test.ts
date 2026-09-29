/**
 * `orchestrate parallel start --wave n` reads the same stable plan as
 * `orchestrate waves` (T12682): wave n is the same wave after earlier work
 * finishes, and its finished tasks are not run again.
 *
 * @task T12682
 */

import type { Task } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { startParallelExecution } from '../parallel.js';

function task(id: string, status: Task['status'], depends?: string[]): Task {
  return {
    id,
    title: id,
    status,
    priority: 'medium',
    createdAt: '2026-09-28T00:00:00Z',
    ...(depends ? { depends } : {}),
  } as Task;
}

function accessor(tasks: Task[]) {
  const meta = new Map<string, unknown>();
  return {
    async getChildren(): Promise<Task[]> {
      return tasks;
    },
    async loadSingleTask(id: string): Promise<Task | null> {
      return id === 'E1' ? task('E1', 'active') : (tasks.find((t) => t.id === id) ?? null);
    },
    // T12692: planEpicWaves loads the project-wide ranking context.
    async queryTasks(): Promise<{ tasks: Task[]; total: number }> {
      return { tasks, total: tasks.length };
    },
    async loadTasks(ids: readonly string[]): Promise<Task[]> {
      return tasks.filter((t) => ids.includes(t.id));
    },
    async getMetaValue<T>(key: string): Promise<T | null> {
      return (meta.get(key) as T | undefined) ?? null;
    },
    async setMetaValue(key: string, value: unknown): Promise<void> {
      meta.set(key, value);
    },
  };
}

describe('parallel start uses stable wave numbers (T12682)', () => {
  it('wave 2 is still wave 2 once wave 1 is done, and runs only its unfinished tasks', async () => {
    const tasks = [
      task('A', 'done'),
      task('B', 'done', ['A']),
      task('C', 'pending', ['A']),
      task('D', 'pending', ['B', 'C']),
    ];
    const started = await startParallelExecution('E1', 2, undefined, accessor(tasks) as never);
    // Wave 2 = {B, C} (after A); B is done, so only C runs.
    expect(started.tasks).toEqual(['C']);
  });
});
