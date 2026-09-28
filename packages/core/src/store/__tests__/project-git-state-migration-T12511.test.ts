/**
 * T12511 migration — `nexus_project_git_state` is created through the REAL
 * global open path, on a fresh store and on a store at main's state (every
 * migration applied except T12511), and a reopen is a no-op.
 *
 * @task T12511
 */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetDualScopeDbCache,
  getDualScopeNativeDb,
  openDualScopeDbAtPath,
} from '../dual-scope-db.js';
import { getDbSyncConstructor } from '../sqlite-native.js';

const T12511 = '20260928030000_t12511-project-git-state';

let testDir: string;
let dbPath: string;

beforeEach(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-git-state-mig-T12511-')));
  dbPath = join(testDir, 'cleo-home', 'cleo.db');
});

afterEach(() => {
  _resetDualScopeDbCache();
  rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** Open through the real chokepoint and return its native handle. */
async function openGlobal(): Promise<DatabaseSync> {
  const handle = await openDualScopeDbAtPath('global', dbPath);
  return getDualScopeNativeDb(handle);
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

function journalHas(db: DatabaseSync, name: string): boolean {
  return db.prepare('SELECT 1 FROM __drizzle_migrations WHERE name = ?').get(name) !== undefined;
}

describe('T12511 nexus_project_git_state migration via openDualScopeDbAtPath(global)', () => {
  it('creates the table keyed like nexus_project_locations and journals it', async () => {
    const db = await openGlobal();
    expect(tableExists(db, 'nexus_project_git_state')).toBe(true);
    expect(journalHas(db, T12511)).toBe(true);
    const cols = db.prepare("PRAGMA table_info('nexus_project_git_state')").all() as Array<{
      name: string;
      pk: number;
    }>;
    expect(cols.filter((c) => c.pk > 0).map((c) => c.name)).toEqual([
      'project_id',
      'device_id',
      'path',
    ]);
    expect(cols.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'branch',
        'head_sha',
        'dirty_count',
        'untracked_count',
        'upstream',
        'ahead',
        'behind',
        'remote_head_sha',
        'remote_fetched_at',
        'probed_at',
        'probe_error_code',
        'probe_error',
      ]),
    );
    const insert = (code: string, fetched: string) =>
      db
        .prepare(
          'INSERT INTO nexus_project_git_state (project_id, device_id, path, probed_at, probe_error_code, remote_fetched_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run('p', 'd', `/w/${code}${fetched}`, '2026-09-28T00:00:00Z', code, fetched);
    expect(() => insert('E_BOGUS', '2026-09-28T00:00:00Z')).toThrow(/CHECK/);
    expect(() => insert('E_GIT_TIMEOUT', 'yesterday')).toThrow(/CHECK/);
    insert('E_GIT_TIMEOUT', '2026-09-28T00:00:00Z');
  });

  it('applies to a store at main state (table and journal row absent)', async () => {
    const first = await openGlobal();
    first.exec('DROP TABLE nexus_project_git_state');
    first.prepare('DELETE FROM __drizzle_migrations WHERE name = ?').run(T12511);
    _resetDualScopeDbCache();

    const Ctor = getDbSyncConstructor();
    const raw = new Ctor(dbPath);
    expect(tableExists(raw, 'nexus_project_git_state')).toBe(false);
    raw.close();

    const db = await openGlobal();
    expect(tableExists(db, 'nexus_project_git_state')).toBe(true);
    expect(journalHas(db, T12511)).toBe(true);
  });

  it('is a no-op on reopen and keeps rows', async () => {
    const db = await openGlobal();
    db.prepare(
      "INSERT INTO nexus_project_git_state (project_id, device_id, path, probed_at) VALUES ('keep', 'd', '/w', '2026-09-28T00:00:00Z')",
    ).run();
    _resetDualScopeDbCache();
    const again = await openGlobal();
    expect(again.prepare('SELECT project_id FROM nexus_project_git_state').all()).toEqual([
      { project_id: 'keep' },
    ]);
  });
});
