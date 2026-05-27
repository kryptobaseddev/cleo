/**
 * Tests for computeWaves wave status computation.
 *
 * Covers T1197: wave status reads task.status directly rather than the
 * local `completed` set (which always excludes non-terminal tasks).
 *
 * @task T1197
 * @epic T1188
 */

import type { Task } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { computeWaves } from '../waves.js';

/** Minimal Task factory for test brevity. */
function makeTask(id: string, status: Task['status'], opts: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    status,
    priority: 'medium',
    type: 'task',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...opts,
  } as Task;
}

describe('computeWaves — wave status (T1197)', () => {
  it('marks a wave as in_progress when at least one task is active', () => {
    const tasks: Task[] = [makeTask('T001', 'active'), makeTask('T002', 'pending')];
    const waves = computeWaves(tasks);
    expect(waves).toHaveLength(1);
    expect(waves[0]!.status).toBe('in_progress');
  });

  it('marks a wave as pending when all tasks are pending', () => {
    const tasks: Task[] = [makeTask('T001', 'pending'), makeTask('T002', 'pending')];
    const waves = computeWaves(tasks);
    expect(waves).toHaveLength(1);
    expect(waves[0]!.status).toBe('pending');
  });

  it('excludes done/cancelled tasks from waves entirely', () => {
    const tasks: Task[] = [
      makeTask('T001', 'done'),
      makeTask('T002', 'pending', { depends: ['T001'] }),
    ];
    const waves = computeWaves(tasks);
    // Wave 1 contains only T002 (T001 is pre-completed and excluded)
    expect(waves).toHaveLength(1);
    expect(waves[0]!.tasks).toContain('T002');
    expect(waves[0]!.tasks).not.toContain('T001');
  });

  it('returns empty array when all tasks are done', () => {
    const tasks: Task[] = [makeTask('T001', 'done'), makeTask('T002', 'cancelled')];
    const waves = computeWaves(tasks);
    expect(waves).toHaveLength(0);
  });

  it('correctly separates tasks into sequential waves by dependency', () => {
    const tasks: Task[] = [
      makeTask('T001', 'pending'),
      makeTask('T002', 'pending', { depends: ['T001'] }),
      makeTask('T003', 'pending', { depends: ['T002'] }),
    ];
    const waves = computeWaves(tasks);
    expect(waves).toHaveLength(3);
    expect(waves[0]!.tasks).toEqual(['T001']);
    expect(waves[1]!.tasks).toEqual(['T002']);
    expect(waves[2]!.tasks).toEqual(['T003']);
  });

  it('mixed active/pending in wave results in in_progress', () => {
    const tasks: Task[] = [
      makeTask('T001', 'active'),
      makeTask('T002', 'pending'),
      makeTask('T003', 'active'),
    ];
    const waves = computeWaves(tasks);
    expect(waves).toHaveLength(1);
    expect(waves[0]!.status).toBe('in_progress');
  });

  it('wave 1 is in_progress, wave 2 is pending when dep on wave 1', () => {
    const tasks: Task[] = [
      makeTask('T001', 'active'),
      makeTask('T002', 'pending', { depends: ['T001'] }),
    ];
    const waves = computeWaves(tasks);
    expect(waves).toHaveLength(2);
    expect(waves[0]!.status).toBe('in_progress');
    expect(waves[1]!.status).toBe('pending');
  });

  it('wave numbers start at 1 and increment', () => {
    const tasks: Task[] = [
      makeTask('T001', 'pending'),
      makeTask('T002', 'pending', { depends: ['T001'] }),
    ];
    const waves = computeWaves(tasks);
    expect(waves[0]!.waveNumber).toBe(1);
    expect(waves[1]!.waveNumber).toBe(2);
  });

  it('handles tasks with no dependencies (all in wave 1)', () => {
    const tasks: Task[] = [
      makeTask('T001', 'pending'),
      makeTask('T002', 'active'),
      makeTask('T003', 'pending'),
    ];
    const waves = computeWaves(tasks);
    expect(waves).toHaveLength(1);
    expect(waves[0]!.tasks.sort()).toEqual(['T001', 'T002', 'T003']);
  });

  it('remaining cycle tasks appended as a final pending wave', () => {
    // Cyclic deps: T001 depends on T002, T002 depends on T001 — neither can schedule.
    // computeWaves breaks out of the while loop and appends remaining as-is.
    const tasks: Task[] = [
      makeTask('T001', 'pending', { depends: ['T002'] }),
      makeTask('T002', 'pending', { depends: ['T001'] }),
    ];
    const waves = computeWaves(tasks);
    // Both tasks are unreachable; they end up in the overflow wave
    expect(waves).toHaveLength(1);
    expect(waves[0]!.status).toBe('pending');
    expect(waves[0]!.tasks.sort()).toEqual(['T001', 'T002']);
  });
});
