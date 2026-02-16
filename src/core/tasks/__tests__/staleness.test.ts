/**
 * Tests for task staleness detection.
 * @task T4627
 * @epic T4454
 */

import { describe, it, expect } from 'vitest';
import {
  getLastActivity,
  classifyStaleness,
  getStalenessInfo,
  findStaleTasks,
  getStalenessSummary,
  DEFAULT_THRESHOLDS,
} from '../staleness.js';
import type { Task } from '../../../types/task.js';

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: `Task ${overrides.id}`,
    status: 'pending',
    priority: 'medium',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

describe('getLastActivity', () => {
  it('returns updatedAt when most recent', () => {
    const task = makeTask({
      id: 'T001',
      createdAt: daysAgo(10),
      updatedAt: daysAgo(1),
    });
    const result = getLastActivity(task);
    expect(new Date(result).getTime()).toBeCloseTo(new Date(daysAgo(1)).getTime(), -4);
  });

  it('returns completedAt when present and most recent', () => {
    const task = makeTask({
      id: 'T001',
      createdAt: daysAgo(10),
      updatedAt: daysAgo(5),
      completedAt: daysAgo(1),
    });
    const result = getLastActivity(task);
    expect(new Date(result).getTime()).toBeCloseTo(new Date(daysAgo(1)).getTime(), -4);
  });

  it('falls back to createdAt', () => {
    const created = daysAgo(5);
    const task = makeTask({
      id: 'T001',
      createdAt: created,
    });
    // Remove updatedAt if it was set
    delete (task as Record<string, unknown>).updatedAt;
    const result = getLastActivity(task);
    expect(result).toBe(created);
  });
});

describe('classifyStaleness', () => {
  it('returns fresh for recently updated tasks', () => {
    const task = makeTask({ id: 'T001', createdAt: daysAgo(1) });
    expect(classifyStaleness(task)).toBe('fresh');
  });

  it('returns stale after threshold', () => {
    const task = makeTask({ id: 'T001', createdAt: daysAgo(8) });
    expect(classifyStaleness(task)).toBe('stale');
  });

  it('returns critical after critical threshold', () => {
    const task = makeTask({ id: 'T001', createdAt: daysAgo(15) });
    expect(classifyStaleness(task)).toBe('critical');
  });

  it('returns abandoned after abandoned threshold', () => {
    const task = makeTask({ id: 'T001', createdAt: daysAgo(31) });
    expect(classifyStaleness(task)).toBe('abandoned');
  });

  it('returns fresh for completed tasks regardless of age', () => {
    const task = makeTask({ id: 'T001', status: 'done', createdAt: daysAgo(100) });
    expect(classifyStaleness(task)).toBe('fresh');
  });

  it('returns fresh for cancelled tasks regardless of age', () => {
    const task = makeTask({ id: 'T001', status: 'cancelled', createdAt: daysAgo(100) });
    expect(classifyStaleness(task)).toBe('fresh');
  });

  it('uses custom thresholds', () => {
    const task = makeTask({ id: 'T001', createdAt: daysAgo(3) });
    const customThresholds = { stale: 2, critical: 5, abandoned: 10 };
    expect(classifyStaleness(task, customThresholds)).toBe('stale');
  });
});

describe('getStalenessInfo', () => {
  it('returns full staleness info', () => {
    const task = makeTask({ id: 'T001', createdAt: daysAgo(8) });
    const info = getStalenessInfo(task);
    expect(info.taskId).toBe('T001');
    expect(info.level).toBe('stale');
    expect(info.daysSinceUpdate).toBeGreaterThanOrEqual(7);
    expect(info.lastActivity).toBeDefined();
  });
});

describe('findStaleTasks', () => {
  it('finds stale tasks and excludes fresh ones', () => {
    const tasks = [
      makeTask({ id: 'T001', createdAt: daysAgo(1) }),  // fresh
      makeTask({ id: 'T002', createdAt: daysAgo(8) }),  // stale
      makeTask({ id: 'T003', createdAt: daysAgo(15) }), // critical
      makeTask({ id: 'T004', status: 'done', createdAt: daysAgo(100) }), // done = fresh
    ];
    const stale = findStaleTasks(tasks);
    expect(stale).toHaveLength(2);
    expect(stale.map(s => s.taskId)).toContain('T002');
    expect(stale.map(s => s.taskId)).toContain('T003');
  });

  it('sorts by daysSinceUpdate descending', () => {
    const tasks = [
      makeTask({ id: 'T001', createdAt: daysAgo(8) }),
      makeTask({ id: 'T002', createdAt: daysAgo(20) }),
    ];
    const stale = findStaleTasks(tasks);
    expect(stale[0].taskId).toBe('T002');
    expect(stale[1].taskId).toBe('T001');
  });

  it('returns empty when nothing is stale', () => {
    const tasks = [
      makeTask({ id: 'T001', createdAt: daysAgo(0) }),
      makeTask({ id: 'T002', status: 'done', createdAt: daysAgo(100) }),
    ];
    expect(findStaleTasks(tasks)).toHaveLength(0);
  });
});

describe('getStalenessSummary', () => {
  it('computes summary statistics', () => {
    const tasks = [
      makeTask({ id: 'T001', createdAt: daysAgo(0) }),     // fresh
      makeTask({ id: 'T002', createdAt: daysAgo(8) }),     // stale
      makeTask({ id: 'T003', createdAt: daysAgo(15) }),    // critical
      makeTask({ id: 'T004', createdAt: daysAgo(31) }),    // abandoned
      makeTask({ id: 'T005', status: 'done', createdAt: daysAgo(100) }), // excluded
    ];
    const summary = getStalenessSummary(tasks);
    expect(summary.total).toBe(4); // excluding done
    expect(summary.fresh).toBe(1);
    expect(summary.stale).toBe(1);
    expect(summary.critical).toBe(1);
    expect(summary.abandoned).toBe(1);
  });

  it('handles empty task list', () => {
    const summary = getStalenessSummary([]);
    expect(summary.total).toBe(0);
    expect(summary.fresh).toBe(0);
  });
});

describe('DEFAULT_THRESHOLDS', () => {
  it('has expected default values', () => {
    expect(DEFAULT_THRESHOLDS.stale).toBe(7);
    expect(DEFAULT_THRESHOLDS.critical).toBe(14);
    expect(DEFAULT_THRESHOLDS.abandoned).toBe(30);
  });
});
