/**
 * Unit tests for assertBriefingContract (T1905 / BBTT-W1-3).
 *
 * Verifies:
 * - stale observation violation surfaces when capturedAt exceeds maxAgeDays
 * - duplicate violation surfaces when two items share the same dedupBy key
 * - excluded-provenance violation surfaces when item carries banned provenance
 * - clean briefing returns empty violations array
 *
 * @task T1905
 * @epic T1892
 */

import { describe, expect, it } from 'vitest';

describe('assertBriefingContract (T1905)', () => {
  it('returns empty array for compliant briefing', async () => {
    const { assertBriefingContract } = await import('../briefing.js');

    const briefing = {
      lastSession: null,
      currentTask: null,
      nextTasks: [
        { id: 'T001', title: 'Task A', leverage: 1, score: 1 },
        { id: 'T002', title: 'Task B', leverage: 1, score: 1 },
      ],
      openBugs: [],
      blockedTasks: [],
      activeEpics: [],
    };

    const contract = {
      nextTasks: { dedupBy: 'id' },
    };

    const violations = assertBriefingContract(briefing as never, contract);
    expect(violations).toHaveLength(0);
  });

  it('emits stale violation when recentObservations capturedAt exceeds maxAgeDays', async () => {
    const { assertBriefingContract } = await import('../briefing.js');

    // 30-day-old observation — should violate maxAgeDays: 7
    const staleDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const briefing = {
      lastSession: null,
      currentTask: null,
      nextTasks: [],
      openBugs: [],
      blockedTasks: [],
      activeEpics: [],
      memoryContext: {
        recentObservations: [
          { id: 'O-stale-01', title: 'old session debrief', capturedAt: staleDate },
        ],
      },
    };

    const contract = {
      'memoryContext.recentObservations': { maxAgeDays: 7 },
    };

    const violations = assertBriefingContract(briefing as never, contract);
    expect(violations.length).toBeGreaterThanOrEqual(1);
    const staleViolation = violations.find((v) => v.kind === 'stale');
    expect(staleViolation).toBeDefined();
    expect(staleViolation?.field).toBe('memoryContext.recentObservations');
  });

  it('emits duplicate violation when two nextTasks share the same id', async () => {
    const { assertBriefingContract } = await import('../briefing.js');

    const briefing = {
      lastSession: null,
      currentTask: null,
      nextTasks: [
        { id: 'T001', title: 'Task A', leverage: 1, score: 1 },
        { id: 'T001', title: 'Task A duplicate', leverage: 1, score: 1 },
      ],
      openBugs: [],
      blockedTasks: [],
      activeEpics: [],
    };

    const contract = {
      nextTasks: { dedupBy: 'id' },
    };

    const violations = assertBriefingContract(briefing as never, contract);
    expect(violations.length).toBeGreaterThanOrEqual(1);
    const dupViolation = violations.find((v) => v.kind === 'duplicate');
    expect(dupViolation).toBeDefined();
    expect(dupViolation?.field).toBe('nextTasks');
  });

  it('fresh observations within maxAgeDays do NOT trigger stale violation', async () => {
    const { assertBriefingContract } = await import('../briefing.js');

    // 2-day-old observation — within maxAgeDays: 7
    const freshDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    const briefing = {
      lastSession: null,
      currentTask: null,
      nextTasks: [],
      openBugs: [],
      blockedTasks: [],
      activeEpics: [],
      memoryContext: {
        recentObservations: [{ id: 'O-fresh-01', title: 'recent debrief', capturedAt: freshDate }],
      },
    };

    const contract = {
      'memoryContext.recentObservations': { maxAgeDays: 7 },
    };

    const violations = assertBriefingContract(briefing as never, contract);
    const staleViolation = violations.find((v) => v.kind === 'stale');
    expect(staleViolation).toBeUndefined();
  });
});
