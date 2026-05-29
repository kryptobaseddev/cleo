/**
 * Smoke tests for openCleoDb — canonical database chokepoint.
 *
 * @task T9050
 * @task T10322 (project_id consistency gate + brain misroute regression)
 * @task T10397 (brain role MUST resolve to brain.db, not tasks.db)
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCleoDb, openCleoDbSnapshot, validateProjectIdConsistency } from '../open-cleo-db.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cleo-test-open-cleo-db-'));
  // Pre-create `.cleo/` so the canonical resolveCleoDir SSoT resolves this
  // temp dir as a project root (no orphan synthesis — T11262/T9803).
  mkdirSync(join(dir, '.cleo'), { recursive: true });
  return dir;
}

function cleanupTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('openCleoDb', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('opens tasks.db and returns a DBHandle with correct role', async () => {
    const handle = await openCleoDb('tasks', tempDir);
    expect(handle.role).toBe('tasks');
    expect(handle.db).toBeDefined();
    // Verify the database file was created
    expect(handle.db.prepare('SELECT 1').get()).toEqual({ '1': 1 });
    handle.close();
  });

  it('opens brain.db and returns a DBHandle with correct role', async () => {
    // Reset the brain singleton — earlier tests in the same vitest worker
    // may have opened brain.db against a different cwd.
    const { resetBrainDbState } = await import('../memory-sqlite.js');
    resetBrainDbState();

    const handle = await openCleoDb('brain', tempDir);
    try {
      expect(handle.role).toBe('brain');
      expect(handle.db).toBeDefined();
      expect(handle.db.prepare('SELECT 1').get()).toEqual({ '1': 1 });
    } finally {
      handle.close();
      resetBrainDbState();
    }
  });

  // T10397 regression: prior to this fix, ROLE_OPENERS.brain pointed at
  // getTasksDb, so callers got tasks.db schema and every brain-table
  // write silently corrupted data. This test asserts the handle exposes
  // brain.db's canonical schema (brain_observations) and NOT tasks.db's
  // canonical schema (tasks).
  it('openCleoDb(brain) exposes brain.db schema (brain_observations table) — T10397 regression', async () => {
    const { resetBrainDbState } = await import('../memory-sqlite.js');
    resetBrainDbState();

    const handle = await openCleoDb('brain', tempDir);
    try {
      // Brain schema MUST contain brain_observations after migrations run.
      const brainRow = handle.db
        .prepare('SELECT name FROM sqlite_schema WHERE type = ? AND name = ?')
        .get('table', 'brain_observations') as { name?: string } | undefined;
      expect(brainRow?.name).toBe('brain_observations');

      // Tasks schema MUST NOT be present on brain.db — if this passes,
      // it means the handle is still pointed at tasks.db (the T10397 bug).
      const tasksRow = handle.db
        .prepare('SELECT name FROM sqlite_schema WHERE type = ? AND name = ?')
        .get('table', 'tasks') as { name?: string } | undefined;
      expect(tasksRow?.name).toBeUndefined();
    } finally {
      handle.close();
      resetBrainDbState();
    }
  });

  it('opens sessions.db (alias to tasks.db) and returns a DBHandle with correct role', async () => {
    const handle = await openCleoDb('sessions', tempDir);
    expect(handle.role).toBe('sessions');
    expect(handle.db).toBeDefined();
    expect(handle.db.prepare('SELECT 1').get()).toEqual({ '1': 1 });
    handle.close();
  });

  it('opens conduit.db and returns a DBHandle with correct role', async () => {
    const handle = await openCleoDb('conduit', tempDir);
    expect(handle.role).toBe('conduit');
    expect(handle.db).toBeDefined();
    expect(handle.db.prepare('SELECT 1').get()).toEqual({ '1': 1 });
    handle.close();
  });

  it('throws for unimplemented llmtxt role', async () => {
    await expect(openCleoDb('llmtxt', tempDir)).rejects.toThrow('not yet implemented');
  });

  it('applies canonical pragmas at open time', async () => {
    const handle = await openCleoDb('tasks', tempDir);
    const journalMode = handle.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(journalMode.journal_mode.toLowerCase()).toBe('wal');

    const busyTimeout = handle.db.prepare('PRAGMA busy_timeout').get() as {
      busy_timeout?: number;
      timeout?: number;
    };
    expect(busyTimeout.busy_timeout ?? busyTimeout.timeout).toBe(5000);

    handle.close();
  });
});

describe('openCleoDbSnapshot', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  /** Seed a tiny DB with one table so the snapshot opener has something to read. */
  function seedDb(path: string): void {
    const _require = createRequire(import.meta.url);
    const { DatabaseSync: DatabaseSyncCtor } = _require('node:sqlite') as {
      DatabaseSync: new (...args: ConstructorParameters<typeof DatabaseSync>) => DatabaseSync;
    };
    const writer = new DatabaseSyncCtor(path);
    writer.exec(`
      CREATE TABLE rows (id INTEGER PRIMARY KEY, label TEXT NOT NULL);
      INSERT INTO rows (label) VALUES ('alpha'), ('beta');
    `);
    writer.close();
  }

  it('opens an existing DB read-only and lets the caller query it', () => {
    const dbPath = join(tempDir, 'snap.db');
    seedDb(dbPath);

    const snap = openCleoDbSnapshot(dbPath);
    try {
      expect(snap.path).toBe(dbPath);
      const rows = snap.db.prepare('SELECT label FROM rows ORDER BY id').all() as Array<{
        label: string;
      }>;
      expect(rows.map((r) => r.label)).toEqual(['alpha', 'beta']);
    } finally {
      snap.close();
    }
  });

  it('applies pragma SSoT (busy_timeout, cache_size) on snapshot handles', () => {
    const dbPath = join(tempDir, 'snap-pragma.db');
    seedDb(dbPath);

    const snap = openCleoDbSnapshot(dbPath);
    try {
      const busy = snap.db.prepare('PRAGMA busy_timeout').get() as {
        busy_timeout?: number;
        timeout?: number;
      };
      expect(busy.busy_timeout ?? busy.timeout).toBe(5000);
    } finally {
      snap.close();
    }
  });

  it('close() is idempotent', () => {
    const dbPath = join(tempDir, 'snap-close.db');
    seedDb(dbPath);

    const snap = openCleoDbSnapshot(dbPath);
    snap.close();
    // Second close MUST NOT throw.
    expect(() => snap.close()).not.toThrow();
  });

  it('rejects writes when opened in default (readOnly) mode', () => {
    const dbPath = join(tempDir, 'snap-readonly.db');
    seedDb(dbPath);

    const snap = openCleoDbSnapshot(dbPath);
    try {
      expect(() => {
        snap.db.exec("INSERT INTO rows (label) VALUES ('gamma')");
      }).toThrow();
    } finally {
      snap.close();
    }
  });
});

// ============================================================================
// T10322 — project_id consistency gate
// ============================================================================

describe('validateProjectIdConsistency (T10322)', () => {
  let tempDir: string;

  // Use createRequire to materialise an in-process DatabaseSync with the
  // bits of nexus.db's project_registry schema the gate cares about.
  function makeFakeNexusDb(rows: Array<{ id: string; path: string }>): DatabaseSync {
    const _require = createRequire(import.meta.url);
    const { DatabaseSync: DatabaseSyncCtor } = _require('node:sqlite') as {
      DatabaseSync: new (...args: ConstructorParameters<typeof DatabaseSync>) => DatabaseSync;
    };
    const db = new DatabaseSyncCtor(':memory:');
    db.exec(
      `CREATE TABLE project_registry (
        project_id   TEXT PRIMARY KEY,
        project_path TEXT NOT NULL UNIQUE
      );`,
    );
    const ins = db.prepare('INSERT INTO project_registry (project_id, project_path) VALUES (?, ?)');
    for (const row of rows) {
      ins.run(row.id, row.path);
    }
    return db;
  }

  function seedProjectInfo(projectRoot: string, projectId: string): void {
    const cleoDir = join(projectRoot, '.cleo');
    mkdirSync(cleoDir, { recursive: true });
    writeFileSync(
      join(cleoDir, 'project-info.json'),
      JSON.stringify({
        projectHash: 'abcdef012345',
        projectId,
        projectRoot,
        lastUpdated: new Date().toISOString(),
      }),
    );
  }

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('no-ops when role does not track project_id (tasks, brain, conduit, sessions)', () => {
    seedProjectInfo(tempDir, 'pid-canonical');
    const db = makeFakeNexusDb([{ id: 'pid-drift', path: tempDir }]);
    try {
      // Even though the registry would drift, non-tracking roles skip the gate.
      expect(() => validateProjectIdConsistency('tasks', db, tempDir)).not.toThrow();
      expect(() => validateProjectIdConsistency('brain', db, tempDir)).not.toThrow();
      expect(() => validateProjectIdConsistency('conduit', db, tempDir)).not.toThrow();
      expect(() => validateProjectIdConsistency('sessions', db, tempDir)).not.toThrow();
      expect(() => validateProjectIdConsistency('signaldock', db, tempDir)).not.toThrow();
      expect(() => validateProjectIdConsistency('skills', db, tempDir)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('no-ops when project-info.json is missing (fresh clone, pre-init)', () => {
    // No project-info.json seeded.
    const db = makeFakeNexusDb([{ id: 'pid-anything', path: tempDir }]);
    try {
      expect(() => validateProjectIdConsistency('nexus', db, tempDir)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('no-ops when projectId is empty (pre-T5333 install)', () => {
    seedProjectInfo(tempDir, '');
    const db = makeFakeNexusDb([{ id: 'pid-anything', path: tempDir }]);
    try {
      expect(() => validateProjectIdConsistency('nexus', db, tempDir)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('no-ops when project_registry table does not exist (pre-bootstrap nexus.db)', () => {
    seedProjectInfo(tempDir, 'pid-canonical');
    const _require = createRequire(import.meta.url);
    const { DatabaseSync: DatabaseSyncCtor } = _require('node:sqlite') as {
      DatabaseSync: new (...args: ConstructorParameters<typeof DatabaseSync>) => DatabaseSync;
    };
    const db = new DatabaseSyncCtor(':memory:');
    try {
      expect(() => validateProjectIdConsistency('nexus', db, tempDir)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('no-ops when project not yet registered with nexus (no row for this path)', () => {
    seedProjectInfo(tempDir, 'pid-canonical');
    const db = makeFakeNexusDb([{ id: 'pid-someone-else', path: '/some/other/project' }]);
    try {
      expect(() => validateProjectIdConsistency('nexus', db, tempDir)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('succeeds when projectId matches (the happy path)', () => {
    seedProjectInfo(tempDir, 'pid-canonical');
    const db = makeFakeNexusDb([{ id: 'pid-canonical', path: tempDir }]);
    try {
      expect(() => validateProjectIdConsistency('nexus', db, tempDir)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('throws E_PROJECT_ID_DRIFT when registry project_id mismatches project-info.json', () => {
    seedProjectInfo(tempDir, 'pid-canonical');
    const db = makeFakeNexusDb([{ id: 'pid-drift', path: tempDir }]);
    try {
      expect(() => validateProjectIdConsistency('nexus', db, tempDir)).toThrow(
        /E_PROJECT_ID_DRIFT/,
      );
    } finally {
      db.close();
    }
  });

  it('drift error message names both sides of the mismatch', () => {
    seedProjectInfo(tempDir, 'canonical-12');
    const db = makeFakeNexusDb([{ id: 'drift-99', path: tempDir }]);
    try {
      let caught: Error | null = null;
      try {
        validateProjectIdConsistency('nexus', db, tempDir);
      } catch (err: unknown) {
        caught = err instanceof Error ? err : new Error(String(err));
      }
      expect(caught).not.toBeNull();
      expect(caught?.message).toContain('canonical-12');
      expect(caught?.message).toContain('drift-99');
    } finally {
      db.close();
    }
  });
});
