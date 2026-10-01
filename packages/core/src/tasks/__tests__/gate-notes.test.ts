/**
 * T12961 — a flaky pass is visible on its gate: `passed (flaky: <files>)`.
 *
 * @task T12961
 */

import type { TaskVerification } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { describeGateNotes } from '../gate-notes.js';

function verification(
  testsPassed: boolean,
  atoms: NonNullable<TaskVerification['evidence']>['testsPassed'],
): TaskVerification {
  return {
    passed: false,
    round: 1,
    gates: { testsPassed },
    evidence: atoms ? { testsPassed: atoms } : {},
    lastAgent: null,
    lastUpdated: null,
    failureLog: [],
  };
}

describe('describeGateNotes', () => {
  const capturedAt = '2026-10-01T00:00:00.000Z';

  it('notes a passed gate whose tool run was flaky', () => {
    const v = verification(true, {
      atoms: [
        { kind: 'tool', tool: 'test', exitCode: 0, flaky: ['src/a.test.ts', 'src/b.test.ts'] },
      ],
      capturedAt,
      capturedBy: 'agent',
    });
    expect(describeGateNotes(v)).toEqual({
      testsPassed: 'passed (flaky: src/a.test.ts, src/b.test.ts)',
    });
  });

  it('says nothing about a clean pass, a failed gate, or no verification', () => {
    const clean = verification(true, {
      atoms: [{ kind: 'tool', tool: 'test', exitCode: 0 }],
      capturedAt,
      capturedBy: 'agent',
    });
    expect(describeGateNotes(clean)).toEqual({});
    const failed = verification(false, {
      atoms: [{ kind: 'tool', tool: 'test', exitCode: 0, flaky: ['x.test.ts'] }],
      capturedAt,
      capturedBy: 'agent',
    });
    expect(describeGateNotes(failed)).toEqual({});
    expect(describeGateNotes(undefined)).toEqual({});
  });
});
