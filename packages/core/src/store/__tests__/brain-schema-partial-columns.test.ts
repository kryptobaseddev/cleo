/**
 * A partly applied brain ADD COLUMN set never bricks the brain schema step
 * (T13719). `prune_candidate` used to come from an ad-hoc runtime ALTER that
 * swallowed per-table errors, and the forward migration's ALTERs run outside a
 * transaction, so a store can hold the column on some brain tables only. The
 * consolidated reconciler must add the missing columns and skip the present
 * ones, never throw "duplicate column name" (which would break the brain bind,
 * every sync pull and every genesis cut).
 *
 * @task T13719
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetDualScopeDbCache,
  getDualScopeNativeDb,
  openDualScopeDbAtPath,
} from '../dual-scope-db.js';
import { establishBrainSchema } from '../memory-sqlite.js';

const TABLES = ['brain_decisions', 'brain_patterns', 'brain_learnings', 'brain_observations'];
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-brain-partial-'));
  mkdirSync(join(dir, 'cleo'), { recursive: true });
  mkdirSync(join(dir, 'p', '.cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(dir, 'cleo'));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
});

afterEach(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const hasColumn = (db: DatabaseSync, table: string, column: string): boolean =>
  (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).some(
    (c) => c.name === column,
  );

describe('brain schema with a partly applied column set (T13719)', () => {
  it('adds prune_candidate where missing and skips the table that already has it', async () => {
    const path = join(dir, 'p', '.cleo', 'cleo.db');
    const db = getDualScopeNativeDb(await openDualScopeDbAtPath('project', path));
    for (const t of TABLES) expect(hasColumn(db, t, 'prune_candidate'), t).toBe(false);
    db.exec('ALTER TABLE brain_observations ADD COLUMN prune_candidate INTEGER DEFAULT 0');

    expect(() => establishBrainSchema(db, path)).not.toThrow();
    for (const t of TABLES) expect(hasColumn(db, t, 'prune_candidate'), t).toBe(true);
    expect(
      db
        .prepare(`SELECT count(*) AS n FROM "__drizzle_migrations" WHERE name LIKE '%t13719%'`)
        .get(),
    ).toEqual({ n: 1 });
    // Idempotent: a second run journals nothing new and throws nothing.
    expect(() => establishBrainSchema(db, path)).not.toThrow();
  });
});
