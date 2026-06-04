/**
 * Concurrency regression suite for {@link autoRecoverFromBackup} (T11662).
 *
 * ## The bug this locks in
 *
 * `autoRecoverFromBackup` (T5188) restores a `tasks-*.db` snapshot over the live
 * consolidated `cleo.db` when `tasks_tasks == 0` and a ≥10-row backup exists. It
 * does this destructively: `nativeDb.close()` → `unlinkSync(<db>-wal)` →
 * `copyFileSync(backup, <db>.recovery-tmp)` → `renameSync(tmp, <db>)`. Before
 * T11662 it ran with NO inter-process lock, so two processes opening the same
 * empty `cleo.db` simultaneously (or one auto-recovery racing the exodus
 * first-open migration, which fires on the identical condition) could each unlink
 * the WAL / overwrite the DB file at the same instant → a torn WAL frame and
 * `"database disk image is malformed"`. This actually corrupted a live
 * 4 687-task DB under 3 concurrent agents (T11662 RCA).
 *
 * ## What this proves
 *
 * Driving ≥4 concurrent `autoRecoverFromBackup` invocations — each on its OWN
 * native handle, simulating separate processes — against one empty `cleo.db` +
 * one seeded backup, under the real `proper-lockfile` lock:
 *
 *   1. EXACTLY ONE invocation performs the destructive restore (one
 *      `copyFileSync` to the `.recovery-tmp` path, one `renameSync` onto the DB).
 *   2. The other invocations early-exit AFTER the under-lock double-checked
 *      re-query observes `tasks_tasks > 0` (the winner already restored) — they
 *      never unlink the WAL or touch the DB file.
 *   3. The resulting `cleo.db` is intact: it carries the backup's rows and passes
 *      `PRAGMA integrity_check` (no torn WAL).
 *
 * @task T11662
 * @see packages/core/src/store/sqlite.ts — autoRecoverFromBackup (the fix)
 * @see packages/core/src/store/exodus/on-open.ts — the shared first-open lock
 */

import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// fs spy: wrap the three destructive fs calls so we can count restores across
// the concurrent invocations while still performing the real operation. We
// preserve every OTHER node:fs export (the sqlite module + its deps rely on
// existsSync, mkdirSync, statSync, readdirSync, …). The wrapped functions
// delegate to `actual.*`, which `importOriginal<typeof import('node:fs')>()`
// types precisely — so no casts are needed and overload signatures are kept.
// ---------------------------------------------------------------------------

const copyFileSyncCalls: Array<{ src: string; dest: string }> = [];
const renameSyncCalls: Array<{ from: string; to: string }> = [];
const unlinkSyncCalls: string[] = [];

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    copyFileSync: (src: Parameters<typeof actual.copyFileSync>[0], dest: string, mode?: number) => {
      copyFileSyncCalls.push({ src: String(src), dest });
      return actual.copyFileSync(src, dest, mode);
    },
    renameSync: (from: Parameters<typeof actual.renameSync>[0], to: string) => {
      renameSyncCalls.push({ from: String(from), to });
      return actual.renameSync(from, to);
    },
    unlinkSync: (p: Parameters<typeof actual.unlinkSync>[0]) => {
      unlinkSyncCalls.push(String(p));
      return actual.unlinkSync(p);
    },
  };
});

// ---------------------------------------------------------------------------
// Native SQLite handle for fixture seeding + integrity assertions only.
// ---------------------------------------------------------------------------

const _require = createRequire(import.meta.url);
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => DatabaseSyncType;
};

/** Count `tasks_tasks` rows in a DB opened read-only. */
function countTasks(dbPath: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare('SELECT COUNT(*) AS c FROM tasks_tasks').get() as { c: number }).c;
  } finally {
    db.close();
  }
}

/** Run `PRAGMA integrity_check` and return the single-row result string. */
function integrityCheck(dbPath: string): string {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare('PRAGMA integrity_check').get() as
      | { integrity_check: string }
      | undefined;
    return row?.integrity_check ?? 'unknown';
  } finally {
    db.close();
  }
}

describe('autoRecoverFromBackup — concurrency safety (T11662)', () => {
  let tempDir: string;
  let cleoDir: string;
  let dbPath: string;
  let backupDir: string;

  beforeEach(async () => {
    copyFileSyncCalls.length = 0;
    renameSyncCalls.length = 0;
    unlinkSyncCalls.length = 0;

    tempDir = mkdtempSync(join(tmpdir(), 'cleo-T11662-recover-'));
    cleoDir = join(tempDir, '.cleo');
    process.env['CLEO_DIR'] = cleoDir;

    // 1. Materialise a schema-valid, EMPTY consolidated cleo.db via the real
    //    chokepoint so the restored backup re-migrates as a no-op reconcile.
    const { getDb, getDbPath, closeDb } = await import('../sqlite.js');
    closeDb();
    await getDb();
    dbPath = getDbPath();
    closeDb(); // release the handle so we can copy the file cleanly

    // 2. Build a backup snapshot = a copy of the empty cleo.db with ≥10 task
    //    rows seeded into tasks_tasks (above MIN_BACKUP_TASK_COUNT = 10).
    backupDir = join(cleoDir, 'backups', 'sqlite');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(backupDir, { recursive: true });
    const backupPath = join(backupDir, 'tasks-20260101-000000.db');
    // Use the REAL copy (not the spied wrapper path under test) for fixture build.
    copyFileSync(dbPath, backupPath);

    const seedDb = new DatabaseSync(backupPath);
    try {
      seedDb.exec('PRAGMA foreign_keys=OFF');
      const cols = (
        seedDb.prepare('PRAGMA table_info(tasks_tasks)').all() as Array<{
          name: string;
          notnull: number;
          dflt_value: unknown;
          pk: number;
        }>
      ).filter((c) => c.notnull === 1 && c.dflt_value === null);
      // Seed 12 rows providing every NOT NULL / no-default column a value.
      const colNames = cols.map((c) => `"${c.name}"`).join(', ');
      const placeholders = cols.map(() => '?').join(', ');
      const insert = seedDb.prepare(
        `INSERT INTO tasks_tasks (${colNames}) VALUES (${placeholders})`,
      );
      for (let i = 0; i < 12; i++) {
        const values = cols.map((c) => (c.name === 'id' ? `T${1000 + i}` : `seed-${c.name}-${i}`));
        insert.run(...values);
      }
    } finally {
      seedDb.close();
    }

    expect(countTasks(backupPath)).toBe(12);
    expect(countTasks(dbPath)).toBe(0); // live DB still empty
  });

  afterEach(async () => {
    const { closeDb } = await import('../sqlite.js');
    closeDb();
    delete process.env['CLEO_DIR'];
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('serialises ≥4 racing invocations: exactly one restores, others early-exit, DB stays intact', async () => {
    const { autoRecoverFromBackup, closeDb } = await import('../sqlite.js');
    const { openNativeDatabase } = await import('../sqlite-native.js');

    const CONCURRENCY = 5;

    // Each invocation gets its OWN native handle, simulating CONCURRENCY
    // independent processes all opening the same empty cleo.db at once.
    const handles = Array.from({ length: CONCURRENCY }, () => openNativeDatabase(dbPath));

    // Fire all invocations concurrently. They contend on the shared first-open
    // lock; the winner restores, the losers re-query under the lock and bail.
    const results = await Promise.allSettled(
      handles.map((h) => autoRecoverFromBackup(h, dbPath, tempDir)),
    );

    // No invocation should reject — auto-recovery is non-fatal by contract.
    for (const r of results) {
      expect(r.status).toBe('fulfilled');
    }

    // (a) EXACTLY ONE restore: one copy to the recovery-tmp + one rename onto it.
    const recoveryCopies = copyFileSyncCalls.filter((c) => c.dest.endsWith('cleo.db.recovery-tmp'));
    const recoveryRenames = renameSyncCalls.filter(
      (c) => c.from.endsWith('cleo.db.recovery-tmp') && c.to.endsWith('cleo.db'),
    );
    expect(recoveryCopies, 'exactly one process may restore from backup').toHaveLength(1);
    expect(recoveryRenames, 'exactly one process may rename the restored file').toHaveLength(1);

    // (b) The WAL was unlinked at most once (only by the single restorer). The
    //     losers must NOT have reached the unlink (they early-exit on re-check).
    const walUnlinks = unlinkSyncCalls.filter((p) => p.endsWith('cleo.db-wal'));
    expect(walUnlinks.length, 'only the restorer may unlink the WAL').toBeLessThanOrEqual(1);

    // (c) Restored DB carries the backup's rows AND is structurally intact
    //     (no torn WAL frame). Close singletons first so the file is quiescent.
    closeDb();
    for (const h of handles) {
      try {
        if (h.isOpen) h.close();
      } catch {
        /* already closed by the restore path */
      }
    }

    expect(countTasks(dbPath), 'restored cleo.db should hold the 12 backup rows').toBe(12);
    expect(integrityCheck(dbPath), 'restored cleo.db must pass integrity_check').toBe('ok');
  });

  it('is a no-op when the DB is already populated (no lock, no restore)', async () => {
    // Pre-populate the live DB so the cheap unlocked fast-path short-circuits
    // BEFORE any lock acquisition — the happy single-process path stays cheap.
    const seed = new DatabaseSync(dbPath);
    try {
      seed.exec('PRAGMA foreign_keys=OFF');
      const cols = (
        seed.prepare('PRAGMA table_info(tasks_tasks)').all() as Array<{
          name: string;
          notnull: number;
          dflt_value: unknown;
        }>
      ).filter((c) => c.notnull === 1 && c.dflt_value === null);
      const colNames = cols.map((c) => `"${c.name}"`).join(', ');
      const placeholders = cols.map(() => '?').join(', ');
      const insert = seed.prepare(`INSERT INTO tasks_tasks (${colNames}) VALUES (${placeholders})`);
      insert.run(...cols.map((c) => (c.name === 'id' ? 'T9999' : `live-${c.name}`)));
    } finally {
      seed.close();
    }

    copyFileSyncCalls.length = 0;
    renameSyncCalls.length = 0;
    unlinkSyncCalls.length = 0;

    const { autoRecoverFromBackup } = await import('../sqlite.js');
    const { openNativeDatabase } = await import('../sqlite-native.js');
    const handle = openNativeDatabase(dbPath);
    try {
      await autoRecoverFromBackup(handle, dbPath, tempDir);
    } finally {
      try {
        if (handle.isOpen) handle.close();
      } catch {
        /* ignore */
      }
    }

    // No restore: the populated DB short-circuits the trigger entirely.
    expect(copyFileSyncCalls.filter((c) => c.dest.endsWith('.recovery-tmp'))).toHaveLength(0);
    expect(renameSyncCalls.filter((c) => c.to.endsWith('cleo.db'))).toHaveLength(0);
  });
});
