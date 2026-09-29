import type { ScoreTaskInput } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { scoreTask } from '../../../task-tools/score-task-priority.js';

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
