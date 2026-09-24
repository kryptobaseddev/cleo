/**
 * Legacy drizzle-tasks family that cannot be replayed (T12346).
 *
 * claude-todo's `cleo.db` began as a copy of its pre-consolidation `tasks.db`.
 * That journal was written by the created_at HIGH-WATER migrator, so it lists
 * the initial migration plus a late one and silently "skips" every migration in
 * between. Drizzle 1.x selects pending migrations BY NAME, replays the gaps
 * against a schema they were never written for, and every command died at
 * open. This suite reproduces that exact journal shape on a real consolidated
 * store and proves the open now rebuilds the bare family:
 *
 * - snapshots the whole database first (old bare rows are preserved);
 * - leaves the prefixed live tables untouched;
 * - ends with every drizzle-tasks migration journaled, like a fresh project.
 *
 * @task T12346
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const _require = createRequire(import.meta.url);
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => DatabaseSyncType;
};

vi.mock('../../logger.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

/** Read-only scalar query. */
function scalar(dbPath: string, sql: string): unknown {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
    return row === undefined ? undefined : Object.values(row)[0];
  } finally {
    db.close();
  }
}

describe('legacy drizzle-tasks family rebuild (T12346)', () => {
  let root: string;
  let cleoDir: string;
  let liveDb: string;
  const saved = { home: process.env.CLEO_HOME, dir: process.env.CLEO_DIR };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cleo-t12346-'));
    cleoDir = join(root, 'project', '.cleo');
    mkdirSync(cleoDir, { recursive: true });
    process.env.CLEO_HOME = join(root, 'cleo-home');
    process.env.CLEO_DIR = cleoDir;
    liveDb = join(cleoDir, 'cleo.db');

    // A consolidated store (prefixed schema) with one live task in it.
    const { openDualScopeDbAtPath } = await import('../dual-scope-db.js');
    (await openDualScopeDbAtPath('project', liveDb, undefined, { dedicated: true })).close();

    // Beside it, a bare family at the INITIAL schema holding one stale row, and
    // a high-water journal: initial + a late migration, every gap unrecorded.
    const { resolveMigrationsFolder } = await import('../sqlite.js');
    const migrations = readMigrationFiles({ migrationsFolder: resolveMigrationsFolder() });
    const initial = migrations[0];
    const late = migrations.find((m) => m.name?.includes('t10277-saga-tasktype'));
    if (initial === undefined || late === undefined) throw new Error('fixture migrations missing');
    const db = new DatabaseSync(liveDb);
    for (const stmt of initial.sql) if (stmt.trim()) db.exec(stmt);
    db.exec(
      "INSERT INTO tasks (id, title, status, priority, created_at) VALUES ('T1', 'stale bare row', 'pending', 'medium', '2026-03-01T00:00:00Z')",
    );
    // The reference that was already dangling in claude-todo (no ADR-001): the
    // t033 rebuild copies it into a table that DECLARES the self-FK and fails.
    db.exec(
      "INSERT INTO architecture_decisions (id, title, status, supersedes_id, content, created_at) VALUES ('ADR-006', 'stale', 'accepted', 'ADR-001', 'x', '2026-03-01T00:00:00Z')",
    );
    db.exec(
      "INSERT INTO tasks_tasks (id, title, status, priority, created_at) VALUES ('T9', 'live row', 'active', 'high', '2026-09-01T00:00:00Z')",
    );
    const journal = db.prepare(
      'INSERT INTO "__drizzle_migrations" ("hash", "created_at", "name") VALUES (?, ?, ?)',
    );
    journal.run(initial.hash, initial.folderMillis, initial.name ?? null);
    journal.run(late.hash, late.folderMillis, late.name ?? null);
    db.close();
  });

  afterEach(async () => {
    const { closeDb } = await import('../sqlite.js');
    closeDb();
    if (saved.home === undefined) delete process.env.CLEO_HOME;
    else process.env.CLEO_HOME = saved.home;
    if (saved.dir === undefined) delete process.env.CLEO_DIR;
    else process.env.CLEO_DIR = saved.dir;
    rmSync(root, { recursive: true, force: true });
  });

  it('opens by rebuilding the bare family, snapshotting first, prefixed tables untouched, rows carried forward', async () => {
    const { getDb, closeDb, resolveMigrationsFolder } = await import('../sqlite.js');
    await expect(getDb(join(root, 'project'))).resolves.toBeDefined();
    closeDb();

    // Live data survives, and the bare rows are CARRIED FORWARD into the
    // recreated tables — the runtime still reads bare lifecycle_*, audit_log,
    // attachments, … so dropping them would hide real history.
    expect(scalar(liveDb, "SELECT title FROM tasks_tasks WHERE id='T9'")).toBe('live row');
    expect(scalar(liveDb, "SELECT title FROM tasks WHERE id='T1'")).toBe('stale bare row');
    expect(
      scalar(liveDb, "SELECT supersedes_id FROM architecture_decisions WHERE id='ADR-006'"),
    ).toBe('ADR-001');
    // … but preserved byte-for-byte in the pre-repair snapshot.
    const snapshots = readdirSync(join(cleoDir, 'backups')).filter((n) =>
      n.startsWith('cleo-pre-t12346-lineage-rebuild-'),
    );
    expect(snapshots).toHaveLength(1);
    expect(
      scalar(join(cleoDir, 'backups', snapshots[0] ?? ''), "SELECT title FROM tasks WHERE id='T1'"),
    ).toBe('stale bare row');
    // Every lineage migration is journaled, as on a fresh project.
    const all = readMigrationFiles({ migrationsFolder: resolveMigrationsFolder() });
    const journaled = new Set(
      (
        new DatabaseSync(liveDb, { readOnly: true })
          .prepare('SELECT name FROM "__drizzle_migrations"')
          .all() as Array<{ name: string }>
      ).map((r) => r.name),
    );
    expect(all.every((m) => journaled.has(m.name ?? ''))).toBe(true);

    // A second open is an ordinary open — no second rebuild.
    await getDb(join(root, 'project'));
    expect(
      readdirSync(join(cleoDir, 'backups')).filter((n) => n.startsWith('cleo-pre-t12346-')),
    ).toHaveLength(1);
  });
});

describe('version-0 shared journal upgrade (T12346)', () => {
  it('names rows any lineage knows, leaves unknown ones unnamed, and is idempotent', async () => {
    const { upgradeSharedJournalFormat } = await import('../migration-manager.js');
    const { resolveCorePackageMigrationsFolder } = await import('../resolve-migrations-folder.js');
    const tasksFolder = resolveCorePackageMigrationsFolder('drizzle-tasks');
    const projectFolder = resolveCorePackageMigrationsFolder('drizzle-cleo-project');
    const known = readMigrationFiles({ migrationsFolder: tasksFolder })[0];
    if (known === undefined) throw new Error('fixture migrations missing');

    const dir = mkdtempSync(join(tmpdir(), 'cleo-t12346-journal-'));
    try {
      const db = new DatabaseSync(join(dir, 'cleo.db'));
      // The pre-baseline shape found in clawmsgr/execdash/screennest: NULL ids.
      db.exec(
        'CREATE TABLE "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
      );
      db.prepare('INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)').run(
        known.hash,
        known.folderMillis,
      );
      db.prepare('INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)').run(
        'pre-baseline-hash-no-lineage-knows',
        1771905619000,
      );

      expect(upgradeSharedJournalFormat(db, [projectFolder, tasksFolder])).toEqual({
        named: 1,
        unnamed: 1,
      });
      const names = (
        db.prepare('SELECT name FROM "__drizzle_migrations" ORDER BY rowid').all() as Array<{
          name: string | null;
        }>
      ).map((r) => r.name);
      expect(names).toEqual([known.name, null]);
      expect(upgradeSharedJournalFormat(db, [projectFolder, tasksFolder])).toBeNull();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
