/**
 * Tests for T948 — Studio dashboard rollup-backed epic progress.
 *
 * Verifies that `_epicRowFromRollups` tallies `execStatus` into dashboard
 * buckets identically to the legacy raw-SQL `_computeEpicProgress` helper,
 * so the owner-flagged `/tasks` vs `/tasks/pipeline` drift is closed.
 *
 * @task T948
 */

import type { TaskRollupPayload } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { _epicRowFromRollups } from '../+page.server.js';

/** Minimal rollup builder. */
function r(id: string, execStatus: TaskRollupPayload['execStatus']): TaskRollupPayload {
  return {
    id,
    execStatus,
    pipelineStage: null,
    gatesVerified: [],
    childrenDone: 0,
    childrenTotal: 0,
    blockedBy: [],
    lastActivityAt: null,
  };
}

describe('_epicRowFromRollups (T948)', () => {
  const parent = { id: 'E1', title: 'Test Epic', status: 'pending' };

  it('emits an empty shape when the epic has no children', () => {
    expect(_epicRowFromRollups(parent, [])).toEqual({
      id: 'E1',
      title: 'Test Epic',
      status: 'pending',
      total: 0,
      done: 0,
      active: 0,
      pending: 0,
      cancelled: 0,
    });
  });

  it('tallies every canonical execStatus bucket', () => {
    const children: TaskRollupPayload[] = [
      r('C1', 'done'),
      r('C2', 'done'),
      r('C3', 'active'),
      r('C4', 'pending'),
      r('C5', 'cancelled'),
    ];
    expect(_epicRowFromRollups(parent, children)).toMatchObject({
      total: 5,
      done: 2,
      active: 1,
      pending: 1,
      cancelled: 1,
    });
  });

  it('never exceeds total across buckets (consistency invariant)', () => {
    // Property check: done + active + pending + cancelled ≤ total for any
    // mix of execStatus values. `blocked`/`archived`/`proposed` are not
    // tallied but still count toward `total` via children.length.
    const children: TaskRollupPayload[] = [
      r('A', 'done'),
      r('B', 'blocked'),
      r('C', 'archived'),
      r('D', 'proposed'),
      r('E', 'pending'),
    ];
    const row = _epicRowFromRollups(parent, children);
    expect(row.total).toBe(5);
    expect(row.done + row.active + row.pending + row.cancelled).toBeLessThanOrEqual(row.total);
  });

  it('preserves parent status on the row so the UI can render a Deferred badge', () => {
    const cancelledParent = { id: 'E9', title: 'Parked', status: 'cancelled' };
    const row = _epicRowFromRollups(cancelledParent, []);
    expect(row.status).toBe('cancelled');
  });
});
