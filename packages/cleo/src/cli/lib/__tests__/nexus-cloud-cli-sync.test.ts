/**
 * `cleo cloud status`: the per-store sync clause reports held writes
 * (journal spec §3.5 Rule 5, T13271).
 *
 * @task T13271
 */

import type { CloudStatusSyncStream, CloudSyncUnknown } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { syncStreamClause } from '../nexus-cloud-cli.js';

const unknown: CloudSyncUnknown = { known: false, needs: 'S4', reason: 'not yet' };

const noUndo: CloudStatusSyncStream['undo'] = {
  bytes: 0,
  budget: 100,
  state: 'ok',
  exceededAt: null,
};

const stream = (
  held: CloudStatusSyncStream['held'],
  undo: CloudStatusSyncStream['undo'] = noUndo,
): CloudStatusSyncStream => ({
  scope: 'project',
  stream: null,
  dbPath: 'cleo.db',
  journalInstalled: true,
  flags: { capture: true, seal: true, push: false, pull: false, strict: false },
  unsealedOps: 0,
  oldestUnsealedAtMs: null,
  lastSealedSeq: 4,
  quarantined: {},
  suspectTables: [],
  held,
  undo,
  unsentOps: { known: false, needs: 'T12343', reason: 'not yet' },
  lastPushedSeq: unknown,
  lastPulledSeq: unknown,
  serverHeadSeq: unknown,
  devices: unknown,
  openConflicts: unknown,
  lag: unknown,
});

describe('cloud status sync clause (T13271)', () => {
  it('names held writes, and how many are older than the warn age', () => {
    const row = {
      table: 'tasks_tasks',
      uid: 'k',
      txn: 'r:1',
      heldAt: '2026-09-01T00:00:00.000Z',
      reason: 'dangling-ref on tasks_tasks/k [parent_id]',
    };
    expect(
      syncStreamClause(stream({ count: 2, oldestAt: row.heldAt, long: [row], warnDays: 7 })),
    ).toContain('2 held by a rebase (1 older than 7 days)');
    expect(
      syncStreamClause(stream({ count: 1, oldestAt: row.heldAt, long: [], warnDays: 7 })),
    ).toContain('; 1 held by a rebase;');
  });

  it('says nothing about holds when there are none', () => {
    expect(
      syncStreamClause(stream({ count: 0, oldestAt: null, long: [], warnDays: 7 })),
    ).not.toContain('held');
  });

  it('warns from 80% of the undo budget and names the scheduled rebind past it (T13253)', () => {
    const none = { count: 0, oldestAt: null, long: [], warnDays: 7 };
    expect(
      syncStreamClause(stream(none, { bytes: 85, budget: 100, state: 'warn', exceededAt: null })),
    ).toContain('undo at 85% of its budget: pull to drain it');
    expect(
      syncStreamClause(
        stream(none, {
          bytes: 120,
          budget: 100,
          state: 'exceeded',
          exceededAt: '2026-10-05T00:00:00.000Z',
        }),
      ),
    ).toContain(
      'undo budget exceeded since 2026-10-05T00:00:00.000Z: a rebind runs at the next pull',
    );
    expect(syncStreamClause(stream(none))).not.toContain('undo');
  });
});
