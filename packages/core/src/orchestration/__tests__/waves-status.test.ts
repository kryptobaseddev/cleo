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

  it('keeps a finished task in its wave, as completed: numbers never shift (T12682)', () => {
    const tasks: Task[] = [
      makeTask('T001', 'done'),
      makeTask('T002', 'pending', { depends: ['T001'] }),
    ];
    const waves = computeWaves(tasks);
    expect(waves.map((w) => [w.waveNumber, w.tasks, w.status])).toEqual([
      [1, ['T001'], 'completed'],
      [2, ['T002'], 'pending'],
    ]);
  });

  it('lists an all-finished epic as completed waves', () => {
    const tasks: Task[] = [makeTask('T001', 'done'), makeTask('T002', 'cancelled')];
    const waves = computeWaves(tasks);
    expect(waves).toEqual([{ waveNumber: 1, tasks: ['T001', 'T002'], status: 'completed' }]);
  });

  it('a wave number is the same before and after earlier work completes (T12682)', () => {
    const plan = (s1: Task['status'], s2: Task['status']) =>
      computeWaves([
        makeTask('T001', s1),
        makeTask('T002', s2, { depends: ['T001'] }),
        makeTask('T003', 'pending', { depends: ['T002'] }),
      ]).map((w) => [w.waveNumber, w.tasks]);
    const before = plan('pending', 'pending');
    expect(plan('done', 'pending')).toEqual(before);
    expect(plan('done', 'done')).toEqual(before);
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
