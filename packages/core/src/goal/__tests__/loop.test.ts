/**
 * Tests for the turn-budgeted goal loop (T11379).
 *
 * Proves the four AC-mandated transitions and the invariants:
 *  - satisfied   (verdict.ok)
 *  - impossible  (verdict.impossible, no turn consumed)
 *  - abandoned   (turn budget exhausted)
 *  - paused      (judge throws OR returns a malformed verdict — Hermes pattern)
 *  - turnsRemaining never goes negative
 *  - already-terminal goals are inert (no judge call, unchanged)
 *
 * Fully deterministic — the judge is injected, no I/O.
 *
 * @epic T11290
 * @task T11379
 * @saga T11283
 */

import type { GoalJudgeVerdict, GoalRecord } from '@cleocode/contracts';
import { describe, expect, it, vi } from 'vitest';
import { advanceGoal, isWellFormedVerdict } from '../loop.js';

function goalAt(turnsUsed: number, turnBudget: number, status = 'active'): GoalRecord {
  return {
    id: 'g1',
    sessionId: 'ses_A',
    agentId: 'agent-A',
    parentGoalId: null,
    goalKind: { kind: 'fuzzy' },
    intent: 'do the thing',
    criteria: [],
    status: status as GoalRecord['status'],
    turnBudget,
    turnsUsed,
    pausedReason: null,
    lastVerdict: null,
    createdAt: '2026-05-30T00:00:00.000Z',
    updatedAt: '2026-05-30T00:00:00.000Z',
  };
}

const keepGoing: GoalJudgeVerdict = { ok: false, impossible: false, reason: 'not yet' };

describe('advanceGoal — transitions', () => {
  it('satisfied: verdict.ok → status satisfied, no turn consumed', async () => {
    const result = await advanceGoal(goalAt(0, 5), async () => ({
      ok: true,
      impossible: false,
      reason: 'done',
    }));
    expect(result.nextStatus).toBe('satisfied');
    expect(result.turnsRemaining).toBe(5);
  });

  it('impossible: verdict.impossible → status impossible, no turn consumed', async () => {
    const result = await advanceGoal(goalAt(2, 5), async () => ({
      ok: false,
      impossible: true,
      reason: 'task cancelled',
    }));
    expect(result.nextStatus).toBe('impossible');
    // No turn consumed: 5 - 2 = 3 remaining, unchanged.
    expect(result.turnsRemaining).toBe(3);
  });

  it('abandoned: keep-going verdict on the LAST budgeted turn → status abandoned', async () => {
    // 4 used of 5 → 1 remaining; this turn consumes it and exhausts the budget.
    const result = await advanceGoal(goalAt(4, 5), async () => keepGoing);
    expect(result.nextStatus).toBe('abandoned');
    expect(result.turnsRemaining).toBe(0);
    expect(result.verdict.reason).toContain('Turn budget exhausted');
  });

  it('active: keep-going verdict with budget left → status active, one turn consumed', async () => {
    const result = await advanceGoal(goalAt(1, 5), async () => keepGoing);
    expect(result.nextStatus).toBe('active');
    expect(result.turnsRemaining).toBe(3); // (5-1) - 1
  });

  it('paused: judge THROWS → status paused with reason (auto-pause)', async () => {
    const result = await advanceGoal(goalAt(0, 5), async () => {
      throw new Error('network blip');
    });
    expect(result.nextStatus).toBe('paused');
    expect(result.verdict.reason).toContain('network blip');
    // No turn consumed on a pause — the goal can resume from here.
    expect(result.turnsRemaining).toBe(5);
  });

  it('paused: judge returns a MALFORMED verdict → status paused (parse failure)', async () => {
    const result = await advanceGoal(
      goalAt(0, 5),
      // Deliberately malformed (missing impossible/reason).
      async () => ({ ok: false }) as unknown as GoalJudgeVerdict,
    );
    expect(result.nextStatus).toBe('paused');
    expect(result.verdict.reason).toContain('malformed');
  });
});

describe('advanceGoal — invariants', () => {
  it('turnsRemaining never goes negative even past budget', async () => {
    // turnsUsed already > budget (defensive) → remainingBefore floors at 0.
    const result = await advanceGoal(goalAt(99, 5), async () => keepGoing);
    expect(result.turnsRemaining).toBeGreaterThanOrEqual(0);
    expect(result.nextStatus).toBe('abandoned');
  });

  it('already-terminal goal is inert — judge is never called', async () => {
    const judge = vi.fn(async () => keepGoing);
    const result = await advanceGoal(goalAt(3, 5, 'satisfied'), judge);
    expect(result.nextStatus).toBe('satisfied');
    expect(judge).not.toHaveBeenCalled();
  });
});

describe('isWellFormedVerdict', () => {
  it('accepts a complete verdict', () => {
    expect(isWellFormedVerdict({ ok: true, impossible: false, reason: 'x' })).toBe(true);
  });

  it('rejects null, non-objects, and missing fields', () => {
    expect(isWellFormedVerdict(null)).toBe(false);
    expect(isWellFormedVerdict('nope')).toBe(false);
    expect(isWellFormedVerdict({ ok: true })).toBe(false);
    expect(isWellFormedVerdict({ ok: 'yes', impossible: false, reason: 'x' })).toBe(false);
  });
});
