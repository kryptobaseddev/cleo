/**
 * Tests for the evidence-gate-aware goal judge (T11378).
 *
 * Fully hermetic — `getTaskAccessor` is mocked so no DB or network is touched,
 * and the fuzzy path uses a deterministic injected judge so no model is called.
 *
 * Proves:
 *  (a) a `complete T###` goal returns ok=false when the task is pending OR its
 *      gates lack evidence atoms;
 *  (b) returns ok=true when task=done with valid commit+files (implemented) AND
 *      test-run (testsPassed) atoms;
 *  (c) a missing/cancelled task returns impossible;
 *  (d) a fuzzy goal routes to the (mocked) LLM judge and NEVER touches the
 *      evidence path.
 *
 * @epic T11290
 * @task T11378
 * @saga T11283
 */

import type { GoalJudge, GoalJudgeVerdict, GoalRecord, Task } from '@cleocode/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadSingleTaskMock = vi.fn();

vi.mock('../../store/data-accessor.js', () => ({
  getTaskAccessor: async () => ({ loadSingleTask: loadSingleTaskMock }),
}));

import { judgeGoal, StaticGoalJudge } from '../judge.js';

/** Build a minimal goal record for a target-task goal. */
function taskGoal(targetTaskId: string): GoalRecord {
  return {
    id: 'g1',
    sessionId: 'ses_A',
    agentId: 'agent-A',
    parentGoalId: null,
    goalKind: { kind: 'task-completion', targetTaskId },
    intent: `complete ${targetTaskId}`,
    criteria: [],
    status: 'active',
    turnBudget: 5,
    turnsUsed: 0,
    pausedReason: null,
    lastVerdict: null,
    createdAt: '2026-05-30T00:00:00.000Z',
    updatedAt: '2026-05-30T00:00:00.000Z',
  };
}

/** A judge that throws if called — proves the evidence path never delegates. */
const FORBIDDEN_JUDGE: GoalJudge = {
  judge: async () => {
    throw new Error('LLM judge must NOT be called on the task-completion path');
  },
};

/** A minimal Task stub with optional status + verification evidence. */
function stubTask(overrides: Partial<Task>): Task {
  return { id: 'T123', status: 'pending', ...overrides } as Task;
}

beforeEach(() => {
  loadSingleTaskMock.mockReset();
});

describe('judgeGoal — task-completion (evidence path)', () => {
  it('(a) returns ok=false when the task is pending', async () => {
    loadSingleTaskMock.mockResolvedValue(stubTask({ status: 'pending' }));
    const verdict = await judgeGoal(taskGoal('T123'), FORBIDDEN_JUDGE);
    expect(verdict.ok).toBe(false);
    expect(verdict.impossible).toBe(false);
    expect(verdict.reason).toContain('pending');
  });

  it('(a) returns ok=false when the task is done but gates lack evidence atoms', async () => {
    loadSingleTaskMock.mockResolvedValue(
      stubTask({
        status: 'done',
        verification: {
          passed: true,
          round: 1,
          gates: { implemented: true, testsPassed: true },
          evidence: {}, // done, but NO evidence atoms recorded
          lastAgent: null,
          lastUpdated: null,
          failureLog: [],
        },
      }),
    );
    const verdict = await judgeGoal(taskGoal('T123'), FORBIDDEN_JUDGE);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('done but its evidence gates are not satisfied');
  });

  it('(b) returns ok=true when task=done with valid implemented + testsPassed atoms', async () => {
    loadSingleTaskMock.mockResolvedValue(
      stubTask({
        status: 'done',
        verification: {
          passed: true,
          round: 1,
          gates: { implemented: true, testsPassed: true },
          evidence: {
            implemented: {
              atoms: [
                { kind: 'commit', sha: 'abc1234', shortSha: 'abc1234' },
                { kind: 'files', files: [{ path: 'src/a.ts', sha256: 'deadbeef' }] },
              ],
              capturedAt: '2026-05-30T00:00:00.000Z',
              capturedBy: 'agent-A',
            },
            testsPassed: {
              atoms: [
                {
                  kind: 'test-run',
                  path: 'run.json',
                  sha256: 'cafe',
                  passCount: 10,
                  failCount: 0,
                  skipCount: 0,
                },
              ],
              capturedAt: '2026-05-30T00:00:00.000Z',
              capturedBy: 'agent-A',
            },
          },
          lastAgent: null,
          lastUpdated: null,
          failureLog: [],
        },
      }),
    );
    const verdict = await judgeGoal(taskGoal('T123'), FORBIDDEN_JUDGE);
    expect(verdict.ok).toBe(true);
    expect(verdict.impossible).toBe(false);
    expect(verdict.evidence).toContain('implemented:commit');
    expect(verdict.evidence).toContain('testsPassed:test-run');
  });

  it('(c) returns impossible when the target task does not exist', async () => {
    loadSingleTaskMock.mockResolvedValue(null);
    const verdict = await judgeGoal(taskGoal('T999'), FORBIDDEN_JUDGE);
    expect(verdict.ok).toBe(false);
    expect(verdict.impossible).toBe(true);
    expect(verdict.reason).toContain('does not exist');
  });

  it('(c) returns impossible when the target task is cancelled', async () => {
    loadSingleTaskMock.mockResolvedValue(stubTask({ status: 'cancelled' }));
    const verdict = await judgeGoal(taskGoal('T123'), FORBIDDEN_JUDGE);
    expect(verdict.impossible).toBe(true);
    expect(verdict.reason).toContain('cancelled');
  });

  it('rejects done-with-only-implemented (testsPassed unbacked)', async () => {
    loadSingleTaskMock.mockResolvedValue(
      stubTask({
        status: 'done',
        verification: {
          passed: true,
          round: 1,
          gates: { implemented: true },
          evidence: {
            implemented: {
              atoms: [
                { kind: 'commit', sha: 'abc1234', shortSha: 'abc1234' },
                { kind: 'files', files: [{ path: 'src/a.ts', sha256: 'deadbeef' }] },
              ],
              capturedAt: '2026-05-30T00:00:00.000Z',
              capturedBy: 'agent-A',
            },
          },
          lastAgent: null,
          lastUpdated: null,
          failureLog: [],
        },
      }),
    );
    const verdict = await judgeGoal(taskGoal('T123'), FORBIDDEN_JUDGE);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('testsPassed');
  });
});

describe('judgeGoal — fuzzy (LLM fallback path)', () => {
  it('(d) routes a fuzzy goal to the injected judge and never touches the accessor', async () => {
    const expected: GoalJudgeVerdict = {
      ok: true,
      impossible: false,
      reason: 'LLM says satisfied',
    };
    const llmJudge = new StaticGoalJudge(expected);
    const judgeSpy = vi.spyOn(llmJudge, 'judge');

    const fuzzy: GoalRecord = { ...taskGoal('T123'), goalKind: { kind: 'fuzzy' } };
    const verdict = await judgeGoal(fuzzy, llmJudge);

    expect(verdict).toEqual(expected);
    expect(judgeSpy).toHaveBeenCalledOnce();
    // The evidence path was never taken — the task accessor was not consulted.
    expect(loadSingleTaskMock).not.toHaveBeenCalled();
  });
});
