/**
 * Scope-overlap classification.
 *
 * These cases pin the CLASSIFICATION rules, which is where the judgement lives.
 * Detection itself is the duplicate detector's existing similarity functions,
 * already covered by their own tests; what is new here is the decision that a
 * given score plus a given tier/parent relationship means merge rather than
 * absorb, or split rather than link.
 *
 * Verified separately against real data: sweeping saga T9977 (144 live tasks)
 * produced 32 findings at the calibrated default and ZERO merge/absorb, while a
 * synthetic control containing true duplicates produced merge and absorb
 * correctly — so the high-confidence path is conservative rather than dead.
 *
 * @task T12299
 */

import type { DataAccessor, Task } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { OVERLAP_THRESHOLD, reconcileScope } from '../reconcile-scope.js';

const NOW = '2026-09-20T00:00:00.000Z';

function task(id: string, title: string, parentId: string | null, over: Partial<Task> = {}): Task {
  return {
    id,
    title,
    description: '',
    type: 'task',
    status: 'pending',
    priority: 'medium',
    size: 'medium',
    parentId,
    position: 1,
    positionVersion: 0,
    // Ordering is createdAt-ascending, so later ids sort later and the earlier
    // task is always the survivor.
    createdAt: `2026-09-20T00:00:${id.slice(-2)}.000Z`,
    updatedAt: NOW,
    ...over,
  } as Task;
}

/** Accessor over a fixed subtree; records any relation writes. */
function stub(rows: Task[], written: string[] = []): DataAccessor {
  return {
    loadSingleTask: async (id: string) => rows.find((r) => r.id === id) ?? null,
    getSubtree: async () => rows,
    addRelation: async (from: string, to: string, type: string) => {
      written.push(`${from}->${to}:${type}`);
    },
  } as unknown as DataAccessor;
}

const ROOT = task('SG01', 'root saga', null, { type: 'saga' });
const SAME = 'Implement partner sample pricing and billing transaction';

describe('reconcileScope — classification', () => {
  it('calls near-identical SIBLINGS a merge', async () => {
    // Identical titles under one parent. A merge needs to clear
    // MERGE_THRESHOLD (0.90); `SAME` vs `SAME + " flow"` with empty
    // descriptions scores below that and is correctly a `link` instead — the
    // high-confidence path is deliberately hard to trip.
    const rows = [ROOT, task('T01', SAME, 'E1'), task('T02', SAME, 'E1')];
    const r = await reconcileScope({ rootId: 'SG01' }, '/tmp/x', stub(rows));
    expect(r.overlaps).toHaveLength(1);
    expect(r.overlaps[0]?.action).toBe('merge');
    expect(r.overlaps[0]?.relation).toBe('duplicates');
    // The earlier task survives — a stable rule keeps the sweep reproducible.
    expect(r.overlaps[0]?.keepId).toBe('T01');
  });

  it('calls a merely-similar sibling pair a link, not a merge', async () => {
    // The gap between OVERLAP_THRESHOLD and MERGE_THRESHOLD is where most real
    // findings land: shared vocabulary, different work. Measured on saga T9977,
    // `Route createAgentWorktree...` vs `Route destroyAgentWorktree...` sits
    // here at 0.852 and must NOT be proposed as a merge.
    const rows = [
      ROOT,
      task('T01', 'Route createAgentWorktree through core SDK worktree tool', 'E1'),
      task('T02', 'Route destroyAgentWorktree through core SDK worktree tool', 'E1'),
    ];
    const r = await reconcileScope({ rootId: 'SG01' }, '/tmp/x', stub(rows));
    expect(r.overlaps[0]?.action).toBe('link');
    expect(r.overlaps[0]?.relation).toBe('related');
  });

  it('calls a near-identical pair in DIFFERENT containers an absorb, not a merge', async () => {
    // Merging across parents would silently move work between epics.
    const rows = [ROOT, task('T01', SAME, 'E1'), task('T02', SAME, 'E2')];
    const r = await reconcileScope({ rootId: 'SG01' }, '/tmp/x', stub(rows));
    expect(r.overlaps[0]?.action).toBe('absorb');
    expect(r.overlaps[0]?.sameParent).toBe(false);
  });

  it('never proposes anything for genuinely unrelated work', async () => {
    const rows = [
      ROOT,
      task('T01', SAME, 'E1'),
      task('T02', 'Upgrade the CI runner image to Node 24', 'E1'),
    ];
    const r = await reconcileScope({ rootId: 'SG01' }, '/tmp/x', stub(rows));
    expect(r.overlaps).toHaveLength(0);
  });

  it('does not treat a parent and its own child as competing', async () => {
    // A subtask restating its parent's scope is what a decomposition IS.
    const rows = [ROOT, task('T01', SAME, 'E1'), task('T02', SAME, 'T01', { type: 'subtask' })];
    const r = await reconcileScope({ rootId: 'SG01' }, '/tmp/x', stub(rows));
    expect(r.overlaps).toHaveLength(0);
  });

  it('ignores terminal rows — history is not competition', async () => {
    const rows = [
      ROOT,
      task('T01', SAME, 'E1'),
      task('T02', SAME, 'E1', { status: 'done' }),
      task('T03', SAME, 'E1', { status: 'cancelled' }),
    ];
    const r = await reconcileScope({ rootId: 'SG01' }, '/tmp/x', stub(rows));
    expect(r.overlaps).toHaveLength(0);
  });

  it('is read-only without apply, and writes one edge per overlap with it', async () => {
    const rows = [ROOT, task('T01', SAME, 'E1'), task('T02', SAME, 'E1')];

    const dry = await reconcileScope({ rootId: 'SG01' }, '/tmp/x', stub(rows));
    expect(dry.applied).toBe(0);

    const written: string[] = [];
    const wet = await reconcileScope(
      { rootId: 'SG01', apply: true },
      '/tmp/x',
      stub(rows, written),
    );
    expect(wet.applied).toBe(1);
    // Edge points from the later task to the survivor.
    expect(written).toEqual(['T02->T01:duplicates']);
  });

  it('refuses an out-of-range threshold rather than clamping it', async () => {
    const rows = [ROOT, task('T01', SAME, 'E1')];
    await expect(
      reconcileScope({ rootId: 'SG01', threshold: 5 }, '/tmp/x', stub(rows)),
    ).rejects.toThrow(/threshold must be a number between 0 and 1/);
  });

  it('reports a missing root rather than sweeping nothing', async () => {
    await expect(reconcileScope({ rootId: 'NOPE' }, '/tmp/x', stub([]))).rejects.toThrow(
      /Task not found: NOPE/,
    );
  });

  it('defaults to the calibrated threshold', () => {
    // Pinned so a future edit has to restate the measurement in the TSDoc.
    expect(OVERLAP_THRESHOLD).toBe(0.65);
  });
});
