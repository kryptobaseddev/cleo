/**
 * Tests for `armGoalLoop` (T11496 AC3).
 *
 * Verifies that the function creates a per-saga fuzzy goal with the expected
 * fields and idempotency key, without touching a real DB (store is mocked).
 *
 * @task T11496 E4-GOAL-LOOP
 * @saga T11283 SG-COGNITIVE-SUBSTRATE
 */

import type { GoalRecord } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCreateGoal = vi.fn();

vi.mock('../store.js', () => ({
  createGoal: (...args: unknown[]) => mockCreateGoal(...args),
}));

const { armGoalLoop } = await import('../arm.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGoalRecord(overrides: Partial<GoalRecord> = {}): GoalRecord {
  return {
    id: 'g-arm-1',
    sessionId: null,
    agentId: null,
    parentGoalId: null,
    goalKind: { kind: 'fuzzy' },
    intent: 'test intent',
    criteria: [],
    status: 'active',
    turnBudget: 20,
    turnsUsed: 0,
    pausedReason: null,
    lastVerdict: null,
    createdAt: '2026-05-31T00:00:00.000Z',
    updatedAt: '2026-05-31T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('armGoalLoop (T11496 AC3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateGoal.mockResolvedValue(makeGoalRecord());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls createGoal with a fuzzy goal kind', async () => {
    await armGoalLoop({ sagaId: 'T100' });
    const [params] = mockCreateGoal.mock.calls[0] as [{ goalKind: { kind: string } }];
    expect(params.goalKind.kind).toBe('fuzzy');
  });

  it('encodes sagaId in the intent', async () => {
    await armGoalLoop({ sagaId: 'T100' });
    const [params] = mockCreateGoal.mock.calls[0] as [{ intent: string }];
    expect(params.intent).toContain('T100');
  });

  it('includes sagaTitle in the intent when provided', async () => {
    await armGoalLoop({ sagaId: 'T100', sagaTitle: 'My Saga' });
    const [params] = mockCreateGoal.mock.calls[0] as [{ intent: string }];
    expect(params.intent).toContain('My Saga');
  });

  it('uses the default turn budget of 20', async () => {
    await armGoalLoop({ sagaId: 'T100' });
    const [params] = mockCreateGoal.mock.calls[0] as [{ turnBudget: number }];
    expect(params.turnBudget).toBe(20);
  });

  it('respects an explicit turnBudget override', async () => {
    await armGoalLoop({ sagaId: 'T100', turnBudget: 5 });
    const [params] = mockCreateGoal.mock.calls[0] as [{ turnBudget: number }];
    expect(params.turnBudget).toBe(5);
  });

  it('uses a stable idempotency key (cleo-go:<sagaId>:<epochDay>)', async () => {
    await armGoalLoop({ sagaId: 'T100' });
    const [params] = mockCreateGoal.mock.calls[0] as [{ idempotencyKey: string }];
    expect(params.idempotencyKey).toMatch(/^cleo-go:T100:\d+$/);
  });

  it('generates the same idempotency key on repeated calls within the same day', async () => {
    await armGoalLoop({ sagaId: 'T100' });
    await armGoalLoop({ sagaId: 'T100' });
    const key1 = (mockCreateGoal.mock.calls[0] as [{ idempotencyKey: string }])[0].idempotencyKey;
    const key2 = (mockCreateGoal.mock.calls[1] as [{ idempotencyKey: string }])[0].idempotencyKey;
    expect(key1).toBe(key2);
  });

  it('uses distinct idempotency keys for different sagaIds', async () => {
    await armGoalLoop({ sagaId: 'T100' });
    await armGoalLoop({ sagaId: 'T200' });
    const key1 = (mockCreateGoal.mock.calls[0] as [{ idempotencyKey: string }])[0].idempotencyKey;
    const key2 = (mockCreateGoal.mock.calls[1] as [{ idempotencyKey: string }])[0].idempotencyKey;
    expect(key1).not.toBe(key2);
  });

  it('returns the GoalRecord from createGoal', async () => {
    const expected = makeGoalRecord({ id: 'g-arm-abc' });
    mockCreateGoal.mockResolvedValue(expected);
    const result = await armGoalLoop({ sagaId: 'T100' });
    expect(result).toEqual(expected);
  });

  it('passes cwd through to createGoal', async () => {
    await armGoalLoop({ sagaId: 'T100', cwd: '/test/root' });
    const [, passedCwd] = mockCreateGoal.mock.calls[0] as [unknown, string];
    expect(passedCwd).toBe('/test/root');
  });
});
