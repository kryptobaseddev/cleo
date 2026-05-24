/**
 * Brain reader chokepoint idempotency contract test.
 *
 * Saga T10281 / Epic T10283 E2-DB-INTEGRITY / Task T10314.
 *
 * Asserts that the brain-package reader chokepoint
 * (`getBrainDb(ctx)` in `db-connections.ts`) is fully idempotent:
 *
 *   1. Opening twice against the same file does NOT mutate the DB
 *      (pragma application is the only write performed, and it is a
 *      no-op on a database that already has WAL / FK / cache pragmas
 *      applied).
 *   2. Running the SAME `INSERT OR IGNORE` twice against the brain
 *      reader handle does NOT duplicate rows.
 *   3. The reader returns `null` when the file does not exist
 *      (negative path) and a usable handle when it does exist (positive
 *      path).
 *
 * Because `@cleocode/brain` deliberately does NOT depend on
 * `@cleocode/core` (package boundary, AGENTS.md §"Package Boundary"),
 * this test pre-bootstraps the brain.db file by hand using
 * `node:sqlite` directly: it creates the minimal `brain_sticky_notes`
 * table, then exercises the brain reader against that file.
 *
 * Sandboxing: every test runs inside an `mkdtempSync` directory.
 * Cross-link: ADR-013 §9 — brain.db is excluded from git tracking;
 * this test pins the post-untrack invariant on the read side.
 *
 * @task T10314
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
import { getBrainDb } from '../db-connections.js';
import type { ProjectContext } from '../project-context.js';

const _require = createRequire(import.meta.url);
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof DatabaseSyncType>) => DatabaseSyncType;
};

/**
 * Create a minimal brain.db at the given path with just enough schema
 * to exercise an idempotent INSERT path. We deliberately do NOT depend
 * on `@cleocode/core` here — that would violate the brain-package
 * boundary.
 */
function bootstrapMinimalBrainDb(dbPath: string): void {
  mkdirSync(join(dbPath, '..'), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS brain_sticky_notes (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  } finally {
    db.close();
  }
}

describe('brain reader idempotency contract (T10314)', () => {
  let tempDir: string;
  let cleoDir: string;
  let brainDbPath: string;
  let ctx: ProjectContext;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-brain-pkg-idempotency-'));
    cleoDir = join(tempDir, '.cleo');
    brainDbPath = join(cleoDir, 'brain.db');
    ctx = {
      projectPath: tempDir,
      brainDbPath,
      tasksDbPath: join(cleoDir, 'tasks.db'),
    };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns null when brain.db does not exist (negative path)', () => {
    const db = getBrainDb(ctx);
    expect(db).toBeNull();
  });

  it('opens twice against the same file with stable PRAGMAs (no churn)', () => {
    bootstrapMinimalBrainDb(brainDbPath);

    const firstHandle = getBrainDb(ctx);
    expect(firstHandle).not.toBeNull();

    const firstJournal = firstHandle!.prepare('PRAGMA journal_mode').get() as {
      journal_mode: string;
    };
    expect(firstJournal.journal_mode).toBe('wal');

    const firstFk = firstHandle!.prepare('PRAGMA foreign_keys').get() as {
      foreign_keys: number;
    };
    expect(firstFk.foreign_keys).toBe(1);

    firstHandle!.close();

    const secondHandle = getBrainDb(ctx);
    expect(secondHandle).not.toBeNull();

    const secondJournal = secondHandle!.prepare('PRAGMA journal_mode').get() as {
      journal_mode: string;
    };
    expect(secondJournal.journal_mode).toBe('wal');

    const secondFk = secondHandle!.prepare('PRAGMA foreign_keys').get() as {
      foreign_keys: number;
    };
    expect(secondFk.foreign_keys).toBe(1);

    secondHandle!.close();
  });

  it('identical INSERT OR IGNORE writes do not duplicate rows across opens', () => {
    bootstrapMinimalBrainDb(brainDbPath);

    const insertSql =
      "INSERT OR IGNORE INTO brain_sticky_notes (id, content, status) VALUES ('idem-1', 'first', 'active')";

    // Open #1: run the insert, observe count = 1.
    const handle1 = getBrainDb(ctx);
    expect(handle1).not.toBeNull();
    handle1!.exec(insertSql);
    const count1 = handle1!.prepare('SELECT count(*) AS n FROM brain_sticky_notes').get() as {
      n: number;
    };
    expect(count1.n).toBe(1);
    handle1!.close();

    // Open #2: re-run the SAME insert, observe count is still 1.
    const handle2 = getBrainDb(ctx);
    expect(handle2).not.toBeNull();
    handle2!.exec(insertSql);
    const count2 = handle2!.prepare('SELECT count(*) AS n FROM brain_sticky_notes').get() as {
      n: number;
    };
    expect(count2.n).toBe(1);
    handle2!.close();
  });
});
