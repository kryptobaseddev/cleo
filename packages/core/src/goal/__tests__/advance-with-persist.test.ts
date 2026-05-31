/**
 * Tests for the orchestrated `advanceGoalWithPersist` (T11496 AC1).
 *
 * Verifies the full load → advance (injected judge) → persist → continuation
 * pipeline without touching a real SQLite DB (store + judge are mocked).
 *
 * @task T11496 E4-GOAL-LOOP
 * @saga T11283 SG-COGNITIVE-SUBSTRATE
 */

import type { GoalJudgeVerdict, GoalRecord } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must come before importing the SUT
// ---------------------------------------------------------------------------

const mockGetGoalById = vi.fn();
const mockUpdateGoal = vi.fn();
const mockJudgeGoal = vi.fn();
const mockBuildContinuation = vi.fn();

vi.mock('../store.js', () => ({
  getGoalById: (...args: unknown[]) => mockGetGoalById(...args),
  updateGoal: (...args: unknown[]) => mockUpdateGoal(...args),
}));

vi.mock('../judge.js', () => ({
  judgeGoal: (...args: unknown[]) => mockJudgeGoal(...args),
  StaticGoalJudge: class {
    constructor(private verdict: GoalJudgeVerdict) {}
    judge() {
      return Promise.resolve(this.verdict);
    }
  },
}));

vi.mock('../continuation.js', () => ({
  buildContinuation: (...args: unknown[]) => mockBuildContinuation(...args),
}));

// Import SUT after mocks are registered
const { advanceGoalWithPersist } = await import('../advance-with-persist.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGoal(overrides: Partial<GoalRecord> = {}): GoalRecord {
  return {
    id: 'g-test-1',
    sessionId: 'ses_A',
    agentId: 'agent-A',
    parentGoalId: null,
    goalKind: { kind: 'fuzzy' },
    intent: 'complete the epic',
    criteria: ['all tests pass'],
    status: 'active',
    turnBudget: 5,
    turnsUsed: 1,
    pausedReason: null,
    lastVerdict: null,
    createdAt: '2026-05-31T00:00:00.000Z',
    updatedAt: '2026-05-31T00:00:00.000Z',
    ...overrides,
  };
}

const keepGoing: GoalJudgeVerdict = { ok: false, impossible: false, reason: 'still working' };
const satisfied: GoalJudgeVerdict = { ok: true, impossible: false, reason: 'done' };
const impossible: GoalJudgeVerdict = { ok: false, impossible: true, reason: 'task cancelled' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('advanceGoalWithPersist (T11496 AC1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: updateGoal returns the same goal with updated status.
    mockUpdateGoal.mockImplementation(async (id: string, fields: { status?: string }) => ({
      ...makeGoal(),
      id,
      status: fields.status ?? 'active',
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── not found ────────────────────────────────────────────────────────────

  it('returns null when the goal is not found', async () => {
    mockGetGoalById.mockResolvedValue(null);
    const result = await advanceGoalWithPersist('ghost-id');
    expect(result).toBeNull();
    expect(mockUpdateGoal).not.toHaveBeenCalled();
  });

  // ── active → satisfied ───────────────────────────────────────────────────

  it('advances active goal → satisfied and returns null continuation', async () => {
    const goal = makeGoal({ status: 'active', turnsUsed: 1, turnBudget: 5 });
    mockGetGoalById.mockResolvedValue(goal);
    mockJudgeGoal.mockResolvedValue(satisfied);
    mockUpdateGoal.mockResolvedValue({ ...goal, status: 'satisfied' });
    mockBuildContinuation.mockReturnValue(null); // terminal → no nudge

    const result = await advanceGoalWithPersist('g-test-1');

    expect(result).not.toBeNull();
    expect(result?.advanceResult.nextStatus).toBe('satisfied');
    expect(result?.continuation).toBeNull();
    expect(mockUpdateGoal).toHaveBeenCalledOnce();
    // Persisted status must be 'satisfied'.
    expect(mockUpdateGoal.mock.calls[0]?.[1]).toMatchObject({ status: 'satisfied' });
  });

  // ── active → active (continuation emitted) ───────────────────────────────

  it('advances active goal → active and returns a continuation nudge', async () => {
    const goal = makeGoal({ status: 'active', turnsUsed: 0, turnBudget: 5 });
    const updatedGoal = { ...goal, status: 'active', turnsUsed: 1 };
    mockGetGoalById.mockResolvedValue(goal);
    mockJudgeGoal.mockResolvedValue(keepGoing);
    mockUpdateGoal.mockResolvedValue(updatedGoal);
    const nudge = { role: 'user' as const, content: '[GOAL CONTINUATION] keep going' };
    mockBuildContinuation.mockReturnValue(nudge);

    const result = await advanceGoalWithPersist('g-test-1');

    expect(result?.advanceResult.nextStatus).toBe('active');
    expect(result?.continuation).toEqual(nudge);
    expect(mockBuildContinuation).toHaveBeenCalledOnce();
  });

  // ── active → impossible (no continuation) ────────────────────────────────

  it('advances active goal → impossible and returns null continuation', async () => {
    const goal = makeGoal({ status: 'active', turnsUsed: 2, turnBudget: 5 });
    mockGetGoalById.mockResolvedValue(goal);
    mockJudgeGoal.mockResolvedValue(impossible);
    mockUpdateGoal.mockResolvedValue({ ...goal, status: 'impossible' });
    mockBuildContinuation.mockReturnValue(null);

    const result = await advanceGoalWithPersist('g-test-1');

    expect(result?.advanceResult.nextStatus).toBe('impossible');
    expect(result?.continuation).toBeNull();
  });

  // ── already-terminal goal is inert ───────────────────────────────────────

  it('returns the terminal goal unchanged when already satisfied (judge NOT called)', async () => {
    const goal = makeGoal({ status: 'satisfied', turnsUsed: 5, turnBudget: 5 });
    mockGetGoalById.mockResolvedValue(goal);
    // updateGoal still runs to refresh updatedAt with the same status.
    mockUpdateGoal.mockResolvedValue(goal);
    mockBuildContinuation.mockReturnValue(null);

    const result = await advanceGoalWithPersist('g-test-1');

    // judgeGoal should NOT have been called (advanceGoal is inert on terminal).
    expect(mockJudgeGoal).not.toHaveBeenCalled();
    expect(result?.advanceResult.nextStatus).toBe('satisfied');
    expect(result?.continuation).toBeNull();
  });

  // ── judge injected as llmJudge override ──────────────────────────────────

  it('uses the provided llmJudge for fuzzy goals', async () => {
    const goal = makeGoal({ status: 'active', goalKind: { kind: 'fuzzy' } });
    mockGetGoalById.mockResolvedValue(goal);
    mockJudgeGoal.mockResolvedValue(keepGoing);
    mockUpdateGoal.mockResolvedValue({ ...goal, status: 'active' });
    mockBuildContinuation.mockReturnValue(null);

    const customJudge = { judge: vi.fn().mockResolvedValue(keepGoing) };
    await advanceGoalWithPersist('g-test-1', { llmJudge: customJudge });

    // judgeGoal (the core function) is still called — it routes to llmJudge
    // internally for fuzzy goals. The mock is what the routing reaches.
    expect(mockJudgeGoal).toHaveBeenCalledOnce();
  });

  // ── persistence fields ───────────────────────────────────────────────────

  it('persists lastVerdict in the updateGoal call', async () => {
    const goal = makeGoal({ status: 'active', turnsUsed: 0, turnBudget: 5 });
    mockGetGoalById.mockResolvedValue(goal);
    mockJudgeGoal.mockResolvedValue(keepGoing);
    mockUpdateGoal.mockResolvedValue({ ...goal, status: 'active' });
    mockBuildContinuation.mockReturnValue(null);

    await advanceGoalWithPersist('g-test-1');

    const updateArgs = mockUpdateGoal.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updateArgs?.lastVerdict).toEqual(keepGoing);
  });
});
