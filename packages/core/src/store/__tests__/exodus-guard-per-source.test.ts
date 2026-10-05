/**
 * The exodus write guard lifts per source, not on the scope's anchor alone
 * (T13171): each legacy source is copied in one transaction, so a table stays
 * guarded until every source that fills it has committed, even when the anchor
 * table already has rows.
 *
 * @task T13171
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearExodusAborts, emitExodusAbort } from '../exodus/abort-events.js';
import {
  activeExodusWriteGuard,
  EXODUS_ABORT_WRITE_CODE,
  EXODUS_DEFERRED_WRITE_CODE,
  installExodusWriteGuard,
  liftExodusWriteGuard,
  peekExodusWriteGuard,
} from '../exodus/write-guard.js';

let dir: string;
let path: string;
let guarded: DatabaseSync;
/** Plays the migration's own connection, which never sees the temp triggers. */
let copier: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-exodus-guard-'));
  path = join(dir, 'cleo.db');
  guarded = new DatabaseSync(path);
  guarded.exec(
    'CREATE TABLE tasks_tasks (id TEXT); CREATE TABLE tasks_sessions (id TEXT);' +
      'CREATE TABLE brain_observations (id TEXT); CREATE TABLE brain_decisions (id TEXT);',
  );
  copier = new DatabaseSync(path);
  installExodusWriteGuard(
    guarded,
    {
      anchor: 'tasks_tasks',
      tables: ['tasks_tasks', 'tasks_sessions', 'brain_observations', 'brain_decisions'],
      // tasks.db fills the tasks_* tables (sentinel tasks_tasks); brain.db the
      // brain_* tables (sentinel brain_observations, its first table with rows).
      sentinels: {
        tasks_tasks: ['tasks_tasks'],
        tasks_sessions: ['tasks_tasks'],
        brain_observations: ['brain_observations'],
        brain_decisions: ['brain_observations'],
      },
      sources: ['tasks', 'brain'],
      markerPath: null,
      detail: { scope: 'project', dbPath: path, reason: 'test', at: 0, kind: 'deferred' },
    },
    'its migration has not run yet',
  );
});

afterEach(() => {
  clearExodusAborts();
  liftExodusWriteGuard(guarded);
  guarded.close();
  copier.close();
  rmSync(dir, { recursive: true, force: true });
});

const insert = (table: string): void => {
  guarded.prepare(`INSERT INTO ${table} (id) VALUES ('x')`).run();
};

describe('exodus write guard lifts per source (T13171)', () => {
  it('a table whose own source has not committed keeps refusing after the anchor fills', () => {
    // tasks.db committed (its sentinel is the anchor); brain.db is still copying.
    copier.exec("INSERT INTO tasks_tasks (id) VALUES ('t1')");
    insert('tasks_sessions'); // its source committed: writable
    expect(() => insert('brain_decisions')).toThrow(EXODUS_DEFERRED_WRITE_CODE);
    expect(() => insert('brain_observations')).toThrow(EXODUS_DEFERRED_WRITE_CODE);
    // The typed check agrees: the guard is still active.
    expect(activeExodusWriteGuard(guarded)).toBeDefined();
  });

  it('lifts once every source has committed', () => {
    copier.exec("INSERT INTO tasks_tasks (id) VALUES ('t1')");
    copier.exec("INSERT INTO brain_observations (id) VALUES ('o1')");
    insert('brain_decisions');
    expect(activeExodusWriteGuard(guarded)).toBeUndefined();
  });

  it('a table without sentinels waits on the anchor, as before', () => {
    installExodusWriteGuard(
      guarded,
      {
        anchor: 'tasks_tasks',
        tables: ['tasks_tasks', 'brain_decisions'],
        sources: ['stores'],
        markerPath: null,
        detail: { scope: 'project', dbPath: path, reason: 'test', at: 0, kind: 'deferred' },
      },
      'its migration has not run yet',
    );
    expect(() => insert('brain_decisions')).toThrow(EXODUS_DEFERRED_WRITE_CODE);
    copier.exec("INSERT INTO tasks_tasks (id) VALUES ('t1')");
    insert('brain_decisions');
    expect(activeExodusWriteGuard(guarded)).toBeUndefined();
  });

  it('a deferral that ended in an abort reports and refuses as the abort (T13171)', () => {
    expect(peekExodusWriteGuard(guarded)?.detail.kind).toBe('deferred');
    // The migration ran after its admission wait and aborted.
    emitExodusAbort({
      scope: 'project',
      dbPath: path,
      reason: 'parity deficit',
      at: 1,
      kind: 'aborted',
    });
    expect(peekExodusWriteGuard(guarded)?.detail).toMatchObject({
      kind: 'aborted',
      reason: 'parity deficit',
    });
    // The typed check re-arms the triggers, so a raw write names the abort too.
    expect(activeExodusWriteGuard(guarded)?.detail.kind).toBe('aborted');
    expect(() => insert('tasks_sessions')).toThrow(EXODUS_ABORT_WRITE_CODE);
  });

  it('an abort recorded before the deferral does not override it', () => {
    clearExodusAborts();
    emitExodusAbort({ scope: 'project', dbPath: path, reason: 'old', at: -1, kind: 'aborted' });
    expect(peekExodusWriteGuard(guarded)?.detail.kind).toBe('deferred');
  });
});
