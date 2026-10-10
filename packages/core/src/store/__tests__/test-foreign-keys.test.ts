/**
 * Store tests run with foreign keys ON, as production does (T13228). getDb
 * used to turn them OFF under vitest, which hid every cascade and SET NULL
 * from the suite; a test now opts out explicitly.
 *
 * @task T13228
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDualScopeDbCache, openDualScopeDb } from '../dual-scope-db.js';
import { getDb } from '../sqlite.js';
import { TEST_FOREIGN_KEYS_OFF_ENV, testForeignKeysOff } from '../sqlite-pragmas.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-test-fk-'));
  mkdirSync(join(dir, '.cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(dir, 'cleo-home'));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
});

afterEach(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

async function openedFk(): Promise<number> {
  const handle = await openDualScopeDb('project', dir);
  await getDb(dir);
  const db = handle.db.$client as DatabaseSync;
  return (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys;
}

describe('foreign keys under vitest (T13228)', () => {
  it('a getDb handle has foreign_keys = 1 by default', async () => {
    expect(process.env.VITEST).toBeTruthy();
    expect(testForeignKeysOff()).toBe(false);
    expect(await openedFk()).toBe(1);
  });

  it('a test that opts out gets foreign_keys = 0', async () => {
    vi.stubEnv(TEST_FOREIGN_KEYS_OFF_ENV, '1');
    expect(testForeignKeysOff()).toBe(true);
    expect(await openedFk()).toBe(0);
  });
});
