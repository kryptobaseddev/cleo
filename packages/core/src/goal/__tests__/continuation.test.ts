/**
 * Tests for the prompt-cache-safe continuation builder (T11380).
 *
 * Proves:
 *  - the builder returns role === 'user' and emits NO system-role field
 *    (system prompt is never mutated → prompt-cache prefix stays valid);
 *  - byte-stability: identical (goal, verdict) inputs yield identical content
 *    across calls (deterministic — required for cache-prefix reuse);
 *  - terminal verdicts (ok / impossible) and terminal statuses yield NO
 *    continuation (null); only active/paused goals get a nudge;
 *  - the content embeds intent + outstanding criteria + the judge reason;
 *  - the content stays within the documented byte cap.
 *
 * @epic T11290
 * @task T11380
 * @saga T11283
 */

import type { GoalJudgeVerdict, GoalRecord } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { buildContinuation, CONTINUATION_MAX_BYTES } from '../continuation.js';

function goal(overrides: Partial<GoalRecord> = {}): GoalRecord {
  return {
    id: 'g1',
    sessionId: 'ses_A',
    agentId: 'agent-A',
    parentGoalId: null,
    goalKind: { kind: 'fuzzy' },
    intent: 'explore the auth module',
    criteria: ['list the risks', 'note the entrypoints'],
    status: 'active',
    turnBudget: 5,
    turnsUsed: 1,
    pausedReason: null,
    lastVerdict: null,
    createdAt: '2026-05-30T00:00:00.000Z',
    updatedAt: '2026-05-30T00:00:00.000Z',
    ...overrides,
  };
}

const keepGoing: GoalJudgeVerdict = {
  ok: false,
  impossible: false,
  reason: 'two criteria still outstanding',
};

describe('buildContinuation — cache-safety contract', () => {
  it('returns a user-role message and emits no system-role field', () => {
    const continuation = buildContinuation(goal(), keepGoing);
    expect(continuation).not.toBeNull();
    expect(continuation?.role).toBe('user');
    // The object has exactly { role, content } — never a system field.
    expect(Object.keys(continuation ?? {}).sort()).toEqual(['content', 'role']);
    expect(continuation).not.toHaveProperty('system');
  });

  it('is byte-stable for identical (goal, verdict) inputs across calls', () => {
    const g = goal();
    const a = buildContinuation(g, keepGoing);
    const b = buildContinuation(g, keepGoing);
    expect(a?.content).toBe(b?.content);
  });

  it('embeds intent, outstanding criteria, and the judge reason', () => {
    const continuation = buildContinuation(goal(), keepGoing);
    expect(continuation?.content).toContain('explore the auth module');
    expect(continuation?.content).toContain('list the risks');
    expect(continuation?.content).toContain('note the entrypoints');
    expect(continuation?.content).toContain('two criteria still outstanding');
  });

  it('stays within the documented byte cap', () => {
    const longCriteria = Array.from({ length: 200 }, (_, i) => `criterion number ${i} is long`);
    const continuation = buildContinuation(goal({ criteria: longCriteria }), keepGoing);
    const bytes = new TextEncoder().encode(continuation?.content ?? '').length;
    expect(bytes).toBeLessThanOrEqual(CONTINUATION_MAX_BYTES);
  });
});

describe('buildContinuation — terminal yields null', () => {
  it('returns null when the verdict is satisfied (ok)', () => {
    const satisfied: GoalJudgeVerdict = { ok: true, impossible: false, reason: 'done' };
    expect(buildContinuation(goal(), satisfied)).toBeNull();
  });

  it('returns null when the verdict is impossible', () => {
    const impossible: GoalJudgeVerdict = {
      ok: false,
      impossible: true,
      reason: 'task cancelled',
    };
    expect(buildContinuation(goal(), impossible)).toBeNull();
  });

  it('returns null for an abandoned goal status', () => {
    expect(buildContinuation(goal({ status: 'abandoned' }), keepGoing)).toBeNull();
  });

  it('returns null for a satisfied goal status', () => {
    expect(buildContinuation(goal({ status: 'satisfied' }), keepGoing)).toBeNull();
  });

  it('returns a continuation for an active goal', () => {
    expect(buildContinuation(goal({ status: 'active' }), keepGoing)).not.toBeNull();
  });

  it('returns a continuation for a paused goal (resumable)', () => {
    expect(buildContinuation(goal({ status: 'paused' }), keepGoing)).not.toBeNull();
  });
});
