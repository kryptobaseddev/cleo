/**
 * `gateStaleness` offline (what `cleo show` uses) never resolves the merge
 * state, so a show makes no `gh` call; the full check does (T14037).
 *
 * @task T14037
 */

import type { Task } from '@cleocode/contracts';
import { describe, expect, it, vi } from 'vitest';

const merge = vi.hoisted(() => ({ calls: 0 }));

vi.mock('../affected-scope.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../affected-scope.js')>()),
  taskChangeMergeState: vi.fn(async () => {
    merge.calls++;
    return { state: 'unknown' as const };
  }),
}));

const { gateStaleness } = await import('../gate-staleness.js');

/** A task whose testsPassed rests on a scoped (affected) tool:test only. */
const scoped: Task = {
  id: 'T001',
  title: 'scoped evidence',
  description: 'gate staleness fixture',
  status: 'pending',
  priority: 'medium',
  createdAt: '2026-10-27T00:00:00Z',
  verification: {
    passed: false,
    round: 1,
    gates: { testsPassed: true },
    lastAgent: null,
    lastUpdated: null,
    failureLog: [],
    evidence: {
      testsPassed: {
        atoms: [{ kind: 'tool', tool: 'test-affected', exitCode: 0, scope: 'affected' }],
        capturedAt: '2026-10-27T00:00:00Z',
        capturedBy: 'test',
      },
    },
  },
};

describe('gateStaleness offline (T14037)', () => {
  it('offline: scoped evidence makes no merge-state call and gives no merge verdict', async () => {
    merge.calls = 0;
    expect(await gateStaleness(scoped, process.cwd(), undefined, { offline: true })).toEqual([]);
    expect(merge.calls).toBe(0);
  });

  it('the full check (done --plan) resolves the merge state', async () => {
    merge.calls = 0;
    const stale = await gateStaleness(scoped, process.cwd());
    expect(merge.calls).toBe(1);
    expect(stale).toEqual([expect.objectContaining({ gate: 'testsPassed', source: 'superseded' })]);
  });
});
