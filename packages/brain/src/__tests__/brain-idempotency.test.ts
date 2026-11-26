/**
 * Brain reader chokepoint idempotency contract test.
 *
 * Saga T10281 / Epic T10283 E2-DB-INTEGRITY / Task T10314.
 *
 * Asserts that the brain-package reader (`readProjectStore(ctx, read)` in
 * `db-connections.ts`, a read-only snapshot of the project `cleo.db` since
 * T14583) never mutates the store:
 *
 *   1. It returns `null` when the store does not exist (negative path) and
 *      the read's result when it does (positive path).
 *   2. A write attempted through the reader is refused and leaves the rows
 *      unchanged.
 *   3. Reading twice returns the same rows.
 *
 * The store file is bootstrapped by hand with `node:sqlite` and holds only
 * the minimal `brain_sticky_notes` table the test needs.
 *
 * Sandboxing: every test runs inside an `mkdtempSync` directory.
 * Cross-link: ADR-013 §9 — the store is excluded from git tracking;
 * this test pins the post-untrack invariant on the read side.
 *
 * @task T10314
 * @task T14583
 * @epic T10283
 * @saga T10281
 * @adr ADR-013
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readProjectStore } from '../db-connections.js';
import type { ProjectContext } from '../project-context.js';

const _require = createRequire(import.meta.url);
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof DatabaseSyncType>) => DatabaseSyncType;
};

/** Create a minimal store at `dbPath` holding one sticky note. */
function bootstrapMinimalStore(dbPath: string): void {
  mkdirSync(join(dbPath, '..'), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS brain_sticky_notes (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO brain_sticky_notes (id, content) VALUES ('idem-1', 'first');
    `);
  } finally {
    db.close();
  }
}

/** Count sticky notes through the reader. */
function countNotes(ctx: ProjectContext): number | null {
  return readProjectStore(ctx, (db) => {
    const row = db.prepare('SELECT count(*) AS n FROM brain_sticky_notes').get() as { n: number };
    return row.n;
  });
}

describe('brain reader idempotency contract (T10314)', () => {
  let tempDir: string;
  let storePath: string;
  let ctx: ProjectContext;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-brain-pkg-idempotency-'));
    storePath = join(tempDir, '.cleo', 'cleo.db');
    ctx = { projectPath: tempDir, brainDbPath: storePath, tasksDbPath: storePath };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns null when the store does not exist (negative path)', () => {
    expect(countNotes(ctx)).toBeNull();
  });

  it('refuses a write through the reader and leaves the rows unchanged', () => {
    bootstrapMinimalStore(storePath);

    expect(() =>
      readProjectStore(ctx, (db) =>
        db.exec("INSERT INTO brain_sticky_notes (id, content) VALUES ('idem-2', 'second')"),
      ),
    ).toThrow(/readonly/i);
    expect(countNotes(ctx)).toBe(1);
  });

  it('returns the same rows on every read', () => {
    bootstrapMinimalStore(storePath);

    expect(countNotes(ctx)).toBe(1);
    expect(countNotes(ctx)).toBe(1);
  });
});
