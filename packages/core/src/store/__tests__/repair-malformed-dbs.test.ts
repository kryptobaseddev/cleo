/**
 * `cleo doctor repair` orchestrator suite (T11829 · DHQ-060).
 *
 * Proves {@link repairMalformedDbs} — the entry point behind `cleo doctor repair`
 * — DETECTS malformed live DBs via `PRAGMA quick_check` and REPAIRS them through
 * the existing {@link recoverMalformedDb} / {@link runBackupRecover} pipeline,
 * while leaving healthy/absent DBs untouched. No recovery logic is re-implemented;
 * the orchestrator only probes + delegates.
 *
 * @task T11829 (DHQ-060)
 * @epic T11833
 * @saga T11242
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repairMalformedDbs } from '../repair-malformed-dbs.js';

const _require = createRequire(import.meta.url);
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSyncType;
};

const logger = { warn: vi.fn(), error: vi.fn() };

/** Write a minimal, integrity-clean SQLite DB carrying the `tasks` table. */
function writeHealthyTasksDb(path: string, rows: number): void {
  const db = new DatabaseSync(path);
  try {
    db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT)');
    for (let i = 0; i < rows; i++) {
      db.prepare('INSERT INTO tasks (id, title) VALUES (?, ?)').run(`T${i}`, `task ${i}`);
    }
    // Checkpoint so the snapshot file is self-contained (no WAL dependency).
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

describe('repairMalformedDbs (T11829)', () => {
  let projectRoot: string;
  let cleoDir: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'cleo-repair-test-'));
    cleoDir = join(projectRoot, '.cleo');
    mkdirSync(cleoDir, { recursive: true });
    logger.warn.mockClear();
    logger.error.mockClear();
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('skips a healthy DB (quick_check passes) without quarantining', () => {
    writeHealthyTasksDb(join(cleoDir, 'tasks.db'), 3);

    const result = repairMalformedDbs({ projectRoot, roles: ['tasks'], logger });

    expect(result.malformedCount).toBe(0);
    expect(result.repairedCount).toBe(0);
    const tasks = result.roles.find((r) => r.role === 'tasks');
    expect(tasks?.healthy).toBe(true);
    expect(tasks?.action).toBe('skipped');
  });

  it('reports an absent DB as skipped/healthy (nothing to repair)', () => {
    const result = repairMalformedDbs({ projectRoot, roles: ['tasks'], logger });
    const tasks = result.roles.find((r) => r.role === 'tasks');
    expect(tasks?.present).toBe(false);
    expect(tasks?.action).toBe('skipped');
    expect(result.malformedCount).toBe(0);
  });

  it('detects a malformed DB and restores it from the freshest valid snapshot', () => {
    // Live DB = garbage bytes → PRAGMA quick_check fails ("disk image malformed").
    writeFileSync(join(cleoDir, 'tasks.db'), Buffer.from('not a sqlite file at all, corrupt'));

    // A valid VACUUM-INTO snapshot the pipeline can restore from:
    // <cleoDir>/backups/sqlite/tasks-YYYYMMDD-HHmmss.db.
    const vacuumDir = join(cleoDir, 'backups', 'sqlite');
    mkdirSync(vacuumDir, { recursive: true });
    writeHealthyTasksDb(join(vacuumDir, 'tasks-20260101-120000.db'), 5);

    const result = repairMalformedDbs({ projectRoot, roles: ['tasks'], logger });

    expect(result.malformedCount).toBe(1);
    expect(result.repairedCount).toBe(1);
    expect(result.failedCount).toBe(0);
    const tasks = result.roles.find((r) => r.role === 'tasks');
    expect(tasks?.healthy).toBe(false);
    expect(tasks?.action).toBe('repaired');
    expect(tasks?.restoredFrom).toContain('tasks-20260101-120000.db');
    expect(tasks?.quarantinedTo).toBeTruthy();

    // Post-repair the live DB is readable again with the snapshot's rows.
    const restored = new DatabaseSync(join(cleoDir, 'tasks.db'));
    try {
      const row = restored.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number };
      expect(row.n).toBe(5);
    } finally {
      restored.close();
    }
  });

  it('--dry-run detects corruption but performs no quarantine/restore', () => {
    writeFileSync(join(cleoDir, 'tasks.db'), Buffer.from('corrupt bytes here'));
    const vacuumDir = join(cleoDir, 'backups', 'sqlite');
    mkdirSync(vacuumDir, { recursive: true });
    writeHealthyTasksDb(join(vacuumDir, 'tasks-20260101-120000.db'), 7);

    const result = repairMalformedDbs({ projectRoot, roles: ['tasks'], dryRun: true, logger });

    expect(result.dryRun).toBe(true);
    expect(result.malformedCount).toBe(1);
    expect(result.repairedCount).toBe(0);
    const tasks = result.roles.find((r) => r.role === 'tasks');
    expect(tasks?.action).toBe('would-repair');
    expect(tasks?.quarantinedTo).toBeNull();

    // Live DB is STILL the corrupt file — dry-run mutated nothing.
    const live = new DatabaseSync(join(cleoDir, 'tasks.db'));
    let threw = false;
    try {
      live.prepare('SELECT 1').get();
    } catch {
      threw = true;
    } finally {
      live.close();
    }
    expect(threw).toBe(true);
  });

  it('reports failed when a malformed DB has no valid snapshot to restore from', () => {
    writeFileSync(join(cleoDir, 'tasks.db'), Buffer.from('corrupt, no snapshots exist'));

    const result = repairMalformedDbs({ projectRoot, roles: ['tasks'], logger });

    expect(result.malformedCount).toBe(1);
    expect(result.repairedCount).toBe(0);
    expect(result.failedCount).toBe(1);
    expect(result.roles.find((r) => r.role === 'tasks')?.action).toBe('failed');
  });
});
