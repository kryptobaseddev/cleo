/**
 * The chokepoint handle's foreign-key invariant (journal spec §2.3a rule 2,
 * NEW-6 T12786; cleo-dev ruling 2026-09-30: asserted at open, never per
 * transaction).
 *
 * `applyPerfPragmas` skips `PRAGMA foreign_keys = ON` under vitest, which
 * looks like "tests run with foreign keys off". They do not: `node:sqlite`
 * opens with foreign keys enabled. These tests pin that, so a change to
 * either default cannot let vitest run on a mode production never uses: an
 * open yields `foreign_keys = 1` with and without the vitest pragma set, and
 * a handle with foreign keys off is refused.
 *
 * Every store is a temp file.
 *
 * @task T12786
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetDualScopeDbCache,
  assertHandleForeignKeys,
  openDualScopeDbAtPath,
} from '../dual-scope-db.js';
import { ForeignKeysNotRestoredError } from '../migration-runner.js';

let dir: string;

const fk = (db: DatabaseSync) =>
  (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-fk-invariant-'));
  mkdirSync(join(dir, 'cleo'), { recursive: true });
  mkdirSync(join(dir, 'p', '.cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(dir, 'cleo'));
});

afterEach(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('foreign keys on chokepoint handles', () => {
  it('production mode: an open hands out a handle with foreign_keys = 1', async () => {
    // Production pragmas: the vitest default off. The worktree-build guard
    // also keys on VITEST, so opt this temp store in explicitly.
    vi.stubEnv('VITEST', '');
    vi.stubEnv('CLEO_ALLOW_WORKTREE_BUILD_MIGRATIONS', '1');
    const handle = await openDualScopeDbAtPath('project', join(dir, 'p', '.cleo', 'cleo.db'));
    expect(fk(handle.db.$client as DatabaseSync)).toBe(1);
  });

  it('vitest mode (pragma skipped): node:sqlite still opens with foreign_keys = 1', async () => {
    const handle = await openDualScopeDbAtPath('project', join(dir, 'p', '.cleo', 'cleo.db'));
    const native = handle.db.$client as DatabaseSync;
    expect(fk(native)).toBe(1);
    expect(() => assertHandleForeignKeys(native)).not.toThrow();
  });

  it('a handle with foreign keys off is refused with E_STORE_FK_OFF', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = OFF');
    expect(() => assertHandleForeignKeys(db)).toThrow(ForeignKeysNotRestoredError);
    try {
      assertHandleForeignKeys(db);
    } catch (e) {
      expect((e as { code: string }).code).toBe('E_STORE_FK_OFF');
    }
    db.exec('PRAGMA foreign_keys = ON');
    expect(() => assertHandleForeignKeys(db)).not.toThrow();
    db.close();
  });
});
