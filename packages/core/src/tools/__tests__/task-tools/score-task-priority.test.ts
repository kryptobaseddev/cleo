import type { ScoreTaskInput } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { rankTasks, scoreTask } from '../../../task-tools/score-task-priority.js';

// Task with a dependency so depsReady bonus only applies when statuses provided
const HIGH_TASK: ScoreTaskInput = {
  id: 'T1',
  title: 'High priority auth task',
  priority: 'high',
  phase: 'v2',
  depends: ['T0'],
  createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(), // 10 days ago
};

// Task with a dependency so no accidental depsReady bonus
const LOW_TASK: ScoreTaskInput = {
  id: 'T2',
  title: 'Low priority cleanup',
  priority: 'low',
  phase: 'v3',
  depends: ['T0'],
  createdAt: new Date().toISOString(), // just created
};

describe('scoreTask', () => {
  it('assigns higher score to a high-priority task vs a low-priority task', () => {
    // Pass taskStatuses without T0 resolved — both get 0 depsReady bonus
    const ctx = { taskStatuses: new Map([['T0', 'pending']]) };
    const highResult = scoreTask(HIGH_TASK, ctx);
    const lowResult = scoreTask(LOW_TASK, ctx);

    expect(highResult.score).toBeGreaterThan(lowResult.score);
    // T12691: tier 1 is the priority band (high 3 > low 1); nothing else applies to LOW.
    expect(highResult.key?.band).toBe(3);
    expect(lowResult.key).toEqual({ band: 1, severity: 0, tiebreak: 0 });
  });

  it('adds phase alignment bonus when task phase matches currentPhase', () => {
    const withoutPhase = scoreTask(HIGH_TASK, {});
    const withPhase = scoreTask(HIGH_TASK, { currentPhase: 'v2' });

    expect(withPhase.score).toBe(withoutPhase.score + 20);
    const phaseFactors = withPhase.factors.filter((f) => f.name === 'phaseAlignment');
    expect(phaseFactors).toHaveLength(1);
    expect(phaseFactors[0].delta).toBe(20);
  });

  it('adds deps readiness bonus when all deps are done/cancelled', () => {
    const taskStatuses = new Map([['T0', 'done']]);
    const withDeps = scoreTask(HIGH_TASK, { taskStatuses });
    const withoutDeps = scoreTask(HIGH_TASK, {});

    expect(withDeps.score).toBe(withoutDeps.score + 10);
    expect(withDeps.factors.some((f) => f.name === 'depsReady')).toBe(true);
  });

  it('adds age bonus for tasks older than 7 days', () => {
    const nowMs = Date.now();
    const result = scoreTask(HIGH_TASK, { nowMs });

    // 10 days old → floor(10/7) = 1 week → +1 age bonus
    const ageFactors = result.factors.filter((f) => f.name === 'age');
    expect(ageFactors).toHaveLength(1);
    expect(ageFactors[0].delta).toBeGreaterThanOrEqual(1);
  });

  it('applies brain success pattern bonus and failure pattern penalty', () => {
    // Task with explicit depends so no accidental depsReady bonus
    const task: ScoreTaskInput = {
      id: 'T3',
      title: 'database migration',
      priority: 'medium',
      depends: ['T0'],
    };
    const noDepCtx = { taskStatuses: new Map([['T0', 'pending']]) };

    const withSuccess = scoreTask(task, {
      ...noDepCtx,
      successPatterns: [{ pattern: 'database' }],
    });
    const withFailure = scoreTask(task, {
      ...noDepCtx,
      failurePatterns: [{ pattern: 'migration' }],
    });

    // T12691 (D11161): BRAIN patterns are informational — they never move the order.
    const plain = scoreTask(task, noDepCtx);
    expect(withSuccess.score).toBe(plain.score);
    expect(withFailure.score).toBe(plain.score);
    expect(withSuccess.factors.find((f) => f.name === 'brainSuccess')).toMatchObject({
      delta: 0,
      tier: null,
    });
    expect(withFailure.factors.find((f) => f.name === 'brainFailure')).toMatchObject({
      delta: 0,
      tier: null,
    });
  });

  it('returns all factor names in result', () => {
    const result = scoreTask(HIGH_TASK, {
      currentPhase: 'v2',
      taskStatuses: new Map([['T0', 'done']]),
      nowMs: Date.now(),
    });

    const names = result.factors.map((f) => f.name);
    expect(names).toContain('band');
    expect(names).toContain('severity');
    expect(names).toContain('phaseAlignment');
    expect(names).toContain('depsReady');
  });
});

describe('rankTasks — D11161 adversarial checks', () => {
  const nowMs = Date.parse('2026-09-29T00:00:00Z');
  const old = '2025-01-01T00:00:00Z';

  it('an unset severity never outranks an attested P1 in the same band, whatever its bonuses', () => {
    const unset: ScoreTaskInput = {
      id: 'T1',
      title: 'unset',
      priority: 'high',
      createdAt: old,
      phase: 'p',
    };
    const p1: ScoreTaskInput = {
      id: 'T2',
      title: 'p1',
      priority: 'high',
      severity: 'P1',
      depends: ['X'],
    };
    const ranked = rankTasks([unset, p1], {
      currentPhase: 'p',
      nowMs,
      taskStatuses: new Map([['X', 'pending']]),
      leverage: new Map([['T1', 99]]),
    });
    expect(ranked.map((r) => r.task.id)).toEqual(['T2', 'T1']);
  });

  it('the maximal tiebreak stays below one severity step', () => {
    const maxed = scoreTask(
      { id: 'T1', title: 'x', priority: 'low', createdAt: old, phase: 'p' },
      { currentPhase: 'p', nowMs, leverage: new Map([['T1', 99]]) },
    );
    expect(maxed.key?.tiebreak).toBe(60);
    expect(maxed.score).toBeLessThan(
      scoreTask({ id: 'T2', title: 'y', priority: 'low', severity: 'P3', depends: ['X'] }, {})
        .score,
    );
  });

  it('is total and NaN-free on malformed input, and independent of input order', () => {
    // Values outside the TaskPriority / TaskSeverity unions, as an unvalidated row could carry.
    const tasks: ScoreTaskInput[] = JSON.parse(
      JSON.stringify([
        {
          id: 'T3',
          title: 'a',
          priority: 'toString',
          severity: 'constructor',
          createdAt: 'garbage',
        },
        { id: 'T1', title: 'b', priority: 'medium' },
        { id: 'T2', title: 'c', priority: 'medium', createdAt: '' },
      ]),
    );
    const forward = rankTasks(tasks, { nowMs });
    const backward = rankTasks([...tasks].reverse(), { nowMs });
    for (const r of forward) expect(Number.isFinite(r.score)).toBe(true);
    expect(forward.map((r) => r.task.id)).toEqual(backward.map((r) => r.task.id));
    expect(forward.map((r) => r.task.id)).toEqual(['T1', 'T2', 'T3']);
  });
});
