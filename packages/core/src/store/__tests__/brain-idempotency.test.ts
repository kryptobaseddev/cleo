/**
 * Brain DB idempotency contract test.
 *
 * Saga T10281 / Epic T10283 E2-DB-INTEGRITY / Task T10314.
 *
 * Asserts that opening the canonical brain.db chokepoint twice and
 * running the SAME write twice does not produce side-effects on the
 * second run. The contract under test:
 *
 *   1. {@link getBrainDb} (the writer-side canonical opener in
 *      `@cleocode/core/store/memory-sqlite.ts`) is the single chokepoint
 *      for creating and migrating `brain.db`. It is idempotent across
 *      calls inside the same process AND across process simulations
 *      (close + re-open).
 *   2. Identical INSERT statements with the same primary key + `INSERT
 *      OR IGNORE` semantics do not duplicate rows on second run.
 *   3. Migrations applied on the first open are NOT re-applied on the
 *      second open (the Drizzle migration journal advances exactly once).
 *   4. PRAGMA application is idempotent — the second open observes the
 *      same WAL journal mode, the same foreign_keys, and the same
 *      schema version sentinel.
 *
 * Sandboxing: every test runs inside an `mkdtempSync` directory and
 * scopes the brain.db location via `CLEO_DIR`. The real user's
 * `.cleo/` is never touched.
 *
 * Cross-link: ADR-013 §9 (Runtime Data Safety) — the brain DB is one
 * of the four files explicitly excluded from git tracking; this test
 * codifies the post-untrack invariant that re-opening the canonical
 * chokepoint is safe regardless of how many times the developer
 * switches branches or re-runs CLI verbs.
 *
 * @task T10314
 * @epic T10283
 * @saga T10281
 * @adr ADR-013
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('brain.db idempotency contract (T10314)', () => {
  let tempDir: string;
  let cleoDir: string;
  let originalCleoDir: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-brain-idempotency-'));
    cleoDir = join(tempDir, '.cleo');
    originalCleoDir = process.env['CLEO_DIR'];
    process.env['CLEO_DIR'] = cleoDir;
  });

  afterEach(async () => {
    const { closeBrainDb } = await import('../memory-sqlite.js');
    closeBrainDb();
    if (originalCleoDir === undefined) {
      delete process.env['CLEO_DIR'];
    } else {
      process.env['CLEO_DIR'] = originalCleoDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('opening getBrainDb twice does not re-run migrations or duplicate rows', async () => {
    const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import('../memory-sqlite.js');

    // --- First open + migration cycle ---
    await getBrainDb();
    const nativeAfterFirst = getBrainNativeDb();
    expect(nativeAfterFirst).not.toBeNull();

    const migrationsAfterFirst = nativeAfterFirst!
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'",
      )
      .get() as { n: number };
    expect(migrationsAfterFirst.n).toBe(1);

    const firstMigrationCount = nativeAfterFirst!
      .prepare('SELECT count(*) AS n FROM __drizzle_migrations')
      .get() as { n: number };

    // Insert a sticky-note (simple PK-driven idempotency target).
    const insertSql =
      "INSERT OR IGNORE INTO brain_sticky_notes (id, content, status) VALUES ('sticky-1', 'idempotency probe', 'active')";
    nativeAfterFirst!.exec(insertSql);

    const rowsAfterFirstInsert = nativeAfterFirst!
      .prepare('SELECT count(*) AS n FROM brain_sticky_notes')
      .get() as { n: number };
    expect(rowsAfterFirstInsert.n).toBe(1);

    // --- Simulate second process: close and re-open ---
    closeBrainDb();
    await getBrainDb();
    const nativeAfterSecond = getBrainNativeDb();
    expect(nativeAfterSecond).not.toBeNull();

    // The drizzle migration journal must NOT grow on a second open.
    const secondMigrationCount = nativeAfterSecond!
      .prepare('SELECT count(*) AS n FROM __drizzle_migrations')
      .get() as { n: number };
    expect(secondMigrationCount.n).toBe(firstMigrationCount.n);

    // Re-run the SAME insert — the second invocation must be a no-op
    // because the primary key already exists.
    nativeAfterSecond!.exec(insertSql);

    const rowsAfterSecondInsert = nativeAfterSecond!
      .prepare('SELECT count(*) AS n FROM brain_sticky_notes')
      .get() as { n: number };
    expect(rowsAfterSecondInsert.n).toBe(1);
  });

  it('schema version sentinel is stable across opens (no version churn)', async () => {
    const { getBrainDb, getBrainNativeDb, closeBrainDb, BRAIN_SCHEMA_VERSION } = await import(
      '../memory-sqlite.js'
    );

    await getBrainDb();
    const native = getBrainNativeDb();
    expect(native).not.toBeNull();

    const versionRow = native!
      .prepare("SELECT value FROM brain_schema_meta WHERE key = 'schemaVersion'")
      .get() as { value: string } | undefined;
    expect(versionRow?.value).toBe(BRAIN_SCHEMA_VERSION);

    // Capture meta-row count and re-open.
    const firstMetaCount = native!.prepare('SELECT count(*) AS n FROM brain_schema_meta').get() as {
      n: number;
    };

    closeBrainDb();
    await getBrainDb();
    const nativeReopened = getBrainNativeDb();
    expect(nativeReopened).not.toBeNull();

    const secondMetaCount = nativeReopened!
      .prepare('SELECT count(*) AS n FROM brain_schema_meta')
      .get() as { n: number };

    // Sentinel must not grow — schema_version is INSERT OR IGNORE so the
    // second open should observe an identical row count.
    expect(secondMetaCount.n).toBe(firstMetaCount.n);

    const versionRowAfter = nativeReopened!
      .prepare("SELECT value FROM brain_schema_meta WHERE key = 'schemaVersion'")
      .get() as { value: string } | undefined;
    expect(versionRowAfter?.value).toBe(BRAIN_SCHEMA_VERSION);
  });

  it('PRAGMA application is idempotent (WAL + foreign_keys stable)', async () => {
    const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import('../memory-sqlite.js');

    await getBrainDb();
    const nativeFirst = getBrainNativeDb();
    expect(nativeFirst).not.toBeNull();

    const journalFirst = nativeFirst!.prepare('PRAGMA journal_mode').get() as {
      journal_mode: string;
    };
    expect(journalFirst.journal_mode).toBe('wal');

    const fkFirst = nativeFirst!.prepare('PRAGMA foreign_keys').get() as {
      foreign_keys: number;
    };
    expect(fkFirst.foreign_keys).toBe(1);

    closeBrainDb();
    await getBrainDb();
    const nativeSecond = getBrainNativeDb();
    expect(nativeSecond).not.toBeNull();

    const journalSecond = nativeSecond!.prepare('PRAGMA journal_mode').get() as {
      journal_mode: string;
    };
    expect(journalSecond.journal_mode).toBe('wal');

    const fkSecond = nativeSecond!.prepare('PRAGMA foreign_keys').get() as {
      foreign_keys: number;
    };
    expect(fkSecond.foreign_keys).toBe(1);
  });
});
