/**
 * T12512 migration — `nexus_project_registry` gains `last_probed_at` and
 * `last_opened_at` (ISO-8601 CHECKed, NULL by default) plus an index on
 * `last_opened_at`, through the REAL global open path; a reopen is a no-op.
 *
 * @task T12512
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

const T12512 = '20260929010000_t12512-registry-probed-opened';

let testDir: string;
let dbPath: string;

beforeEach(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-registry-mig-T12512-')));
  dbPath = join(testDir, 'cleo-home', 'cleo.db');
});

afterEach(() => {
  _resetDualScopeDbCache();
  rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function openGlobal(): Promise<DatabaseSync> {
  return getDualScopeNativeDb(await openDualScopeDbAtPath('global', dbPath));
}

describe('T12512 registry probed/opened columns via openDualScopeDbAtPath(global)', () => {
  it('adds both nullable columns, the index and the journal row', async () => {
    const db = await openGlobal();
    const cols = db.prepare("PRAGMA table_info('nexus_project_registry')").all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    for (const name of ['last_probed_at', 'last_opened_at']) {
      expect(cols.find((c) => c.name === name)).toMatchObject({ notnull: 0, dflt_value: null });
    }
    expect(
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get('idx_nexus_project_registry_last_opened'),
    ).toBeDefined();
    expect(
      db.prepare('SELECT 1 FROM __drizzle_migrations WHERE name = ?').get(T12512),
    ).toBeDefined();
  });

  it('CHECKs the ISO-8601 shape and keeps rows across a reopen', async () => {
    const db = await openGlobal();
    const insert = (id: string, opened: string | null) =>
      db
        .prepare(
          'INSERT INTO nexus_project_registry (project_id, project_hash, project_path, name, last_opened_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(id, 'h', `/p/${id}`, id, opened);
    expect(() => insert('bad', 'yesterday')).toThrow(/CHECK/);
    insert('never', null);
    insert('ok', '2026-09-29T10:00:00.000Z');
    _resetDualScopeDbCache();
    const again = await openGlobal();
    expect(
      again
        .prepare(
          'SELECT project_id, last_opened_at, last_probed_at FROM nexus_project_registry ORDER BY project_id',
        )
        .all(),
    ).toEqual([
      { project_id: 'never', last_opened_at: null, last_probed_at: null },
      { project_id: 'ok', last_opened_at: '2026-09-29T10:00:00.000Z', last_probed_at: null },
    ]);
  });
});
