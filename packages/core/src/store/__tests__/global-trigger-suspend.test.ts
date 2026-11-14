/**
 * The global store has `cleo_trigger_suspend` (T13398). Every capture trigger
 * reads it, so a global store without it fails every write to a captured
 * brain table once `sync.capture` is on.
 *
 * Stores are fresh `cleo.db` files at `<CLEO_HOME>/cleo.db`, opened through
 * the chokepoint (`openDualScopeDbAtPath`).
 *
 * @task T13398
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDualScopeDbCache, openDualScopeDbAtPath } from '../dual-scope-db.js';
import { dropCaptureTriggers, setCaptureEnabled } from '../sync/capture.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../migrations/sync-journal');

let dir: string;
let home: string;

async function openGlobal(): Promise<DatabaseSync> {
  _resetDualScopeDbCache();
  const handle = await openDualScopeDbAtPath('global', join(home, 'cleo.db'));
  return handle.db.$client as DatabaseSync;
}

function hasSuspendTable(db: DatabaseSync): boolean {
  return (
    db
      .prepare(
        "SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = 'cleo_trigger_suspend'",
      )
      .get() !== undefined
  );
}

/** Insert one brain observation and return the capture ops it produced. */
function writeObservation(db: DatabaseSync, id: string): string[] {
  db.exec(
    `INSERT INTO brain_observations (id, type, title, created_at) VALUES ('${id}', 'discovery', 'global', '2026-10-10 10:00:00')`,
  );
  return (
    db
      .prepare(
        "SELECT op FROM _sync_capture WHERE tbl = 'brain_observations' AND rk LIKE ? ORDER BY seq",
      )
      .all(`%${id}%`) as { op: string }[]
  ).map((r) => r.op);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-global-suspend-'));
  home = join(dir, 'cleo');
  mkdirSync(home, { recursive: true });
  vi.stubEnv('CLEO_HOME', home);
  vi.stubEnv('XDG_STATE_HOME', join(dir, 'state'));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
});

afterEach(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('cleo_trigger_suspend in the global store', () => {
  it('a fresh global store has the table, and a captured brain write succeeds once', async () => {
    const db = await openGlobal();
    expect(hasSuspendTable(db)).toBe(true);
    setCaptureEnabled(db, 'global', true, { schemaRoot: SYNC_SCHEMA });
    expect(writeObservation(db, 'O-glob0001')).toEqual(['I']);
  });

  it('an existing global store that lost the table gets it back at open, with capture already on', async () => {
    const first = await openGlobal();
    setCaptureEnabled(first, 'global', true, { schemaRoot: SYNC_SCHEMA });
    // A store from before step 0 covered the global scope: capture triggers
    // installed, no suspension table.
    first.exec('DROP TABLE cleo_trigger_suspend');
    expect(hasSuspendTable(first)).toBe(false);
    const db = await openGlobal();
    expect(hasSuspendTable(db)).toBe(true);
    expect(writeObservation(db, 'O-glob0002')).toEqual(['I']);
  });

  it('turning capture on over a handle that lacks the table creates it with the triggers', async () => {
    const db = await openGlobal();
    db.exec('DROP TABLE cleo_trigger_suspend');
    dropCaptureTriggers(db);
    setCaptureEnabled(db, 'global', true, { schemaRoot: SYNC_SCHEMA });
    expect(hasSuspendTable(db)).toBe(true);
    expect(writeObservation(db, 'O-glob0003')).toEqual(['I']);
  });
});
