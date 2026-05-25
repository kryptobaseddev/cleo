import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import type { DataAccessor } from '../../store/data-accessor.js';
import { collectOrchestrateDashboard, formatDashboardPromptSummary } from '../dashboard.js';

function task(id: string, status: Task['status'], depends: string[] = []): Task {
  return {
    id,
    title: id,
    status,
    type: 'task',
    priority: 'medium',
    size: 'small',
    depends,
    createdAt: '2026-05-24T00:00:00.000Z',
    updatedAt: '2026-05-24T00:00:00.000Z',
  } as Task;
}

function accessor(tasks: Task[]): DataAccessor {
  return {
    queryTasks: async () => ({ tasks, total: tasks.length }),
  } as unknown as DataAccessor;
}

describe('collectOrchestrateDashboard', () => {
  it('aggregates queue, audit rates, and active worktree counts from existing SSoTs', async () => {
    const projectRoot = join(process.cwd(), '.tmp-dashboard-test');
    await mkdir(join(projectRoot, '.cleo', 'audit'), { recursive: true });
    await writeFile(
      join(projectRoot, '.cleo', 'audit', 'worktree-lifecycle.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-05-24T10:00:00.000Z',
          action: 'complete',
          success: true,
        }),
        JSON.stringify({
          timestamp: '2026-05-24T09:00:00.000Z',
          action: 'complete-conflict',
          success: false,
        }),
        JSON.stringify({
          timestamp: '2026-05-22T09:00:00.000Z',
          action: 'complete',
          success: true,
        }),
      ].join('\n'),
    );
    await writeFile(
      join(projectRoot, '.cleo', 'audit', 'force-bypass.jsonl'),
      [
        JSON.stringify({ timestamp: '2026-05-24T08:00:00.000Z', taskId: 'T2' }),
        JSON.stringify({ timestamp: '2026-05-23T13:00:00.000Z', taskId: 'T3' }),
      ].join('\n'),
    );

    const metrics = await collectOrchestrateDashboard(projectRoot, {
      accessor: accessor([
        task('T1', 'done'),
        task('T2', 'pending', ['T1']),
        task('T3', 'pending', ['T9']),
        task('T4', 'active'),
        task('T5', 'blocked'),
      ]),
      now: new Date('2026-05-24T12:00:00.000Z'),
      rateWindowHours: 24,
      worktreeStatusCategories: ['active', 'active', 'locked', 'merged'],
    });

    expect(metrics.queueDepth).toBe(1);
    expect(metrics.queue).toEqual({ ready: 1, pending: 2, active: 1, blocked: 1 });
    expect(metrics.adminMergeRate).toEqual({ count: 1, perHour: 0.04, windowHours: 24 });
    expect(metrics.forceBypassRate).toEqual({ count: 2, perHour: 0.08, windowHours: 24 });
    expect(metrics.activeWorktreeCount).toBe(2);
    expect(metrics.worktrees.total).toBe(4);
  });

  it('formats a compact prompt summary', async () => {
    const metrics = await collectOrchestrateDashboard('/project', {
      accessor: accessor([task('T1', 'pending')]),
      now: new Date('2026-05-24T12:00:00.000Z'),
      rateWindowHours: 24,
      worktreeStatusCategories: ['active'],
    });

    expect(formatDashboardPromptSummary(metrics)).toBe(
      'queue=1 ready / 0 active; worktrees=1 active; adminMerge=0/h; forceBypass=0/h (24h)',
    );
  });
});
