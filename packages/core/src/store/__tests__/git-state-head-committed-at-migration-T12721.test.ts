/**
 * T12721 migration — `nexus_project_git_state` gains `head_committed_at`
 * (ISO-8601 CHECKed, NULL by default) through the REAL global open path; a
 * reopen is a no-op and keeps the value.
 *
 * @task T12721
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
import { GLOBAL_TABLE_REGISTRY } from '../table-classification.js';

const T12721 = '20260929020000_t12721-git-state-head-committed-at';

let testDir: string;
let dbPath: string;

beforeEach(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-git-state-mig-T12721-')));
  dbPath = join(testDir, 'cleo-home', 'cleo.db');
});

afterEach(() => {
  _resetDualScopeDbCache();
  rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function openGlobal(): Promise<DatabaseSync> {
  return getDualScopeNativeDb(await openDualScopeDbAtPath('global', dbPath));
}

describe('T12721 head_committed_at via openDualScopeDbAtPath(global)', () => {
  it('adds the nullable column and the journal row', async () => {
    const db = await openGlobal();
    const cols = db.prepare("PRAGMA table_info('nexus_project_git_state')").all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    expect(cols.find((c) => c.name === 'head_committed_at')).toMatchObject({
      notnull: 0,
      dflt_value: null,
    });
    expect(
      db.prepare('SELECT 1 FROM __drizzle_migrations WHERE name = ?').get(T12721),
    ).toBeDefined();
  });

  it('CHECKs the ISO-8601 shape and keeps rows across a reopen', async () => {
    const db = await openGlobal();
    const insert = (path: string, at: string | null) =>
      db
        .prepare(
          'INSERT INTO nexus_project_git_state (project_id, device_id, path, probed_at, head_committed_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run('p', 'd', path, '2026-09-29T10:00:00.000Z', at);
    expect(() => insert('/bad', 'yesterday')).toThrow(/CHECK/);
    insert('/never', null);
    insert('/ok', '2026-09-29T09:00:00.000Z');
    _resetDualScopeDbCache();
    const again = await openGlobal();
    expect(
      again
        .prepare('SELECT path, head_committed_at FROM nexus_project_git_state ORDER BY path')
        .all(),
    ).toEqual([
      { path: '/never', head_committed_at: null },
      { path: '/ok', head_committed_at: '2026-09-29T09:00:00.000Z' },
    ]);
  });

  it('is classified local-only', () => {
    const entry = GLOBAL_TABLE_REGISTRY.tables.nexus_project_git_state;
    expect(entry?.columns?.find((c) => c.column === 'head_committed_at')?.class).toBe('local-only');
  });
});
