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

/**
 * Narrow the opaque `CleoDbHandle.db` to the native node:sqlite surface.
 *
 * After E6-L6 (T11526) `openCleoDb('project'|'global')` returns the native
 * `DatabaseSync` handle (extracted from the Drizzle wrapper's `$client`), so
 * callers may issue raw `prepare`/`exec` SQL — the same contract the legacy
 * 8-role API exposed.
 */
function nativeOf(handle: { db: unknown }): DatabaseSync {
  return handle.db as DatabaseSync;
}

describe('openCleoDb', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('opens the project cleo.db and returns a DBHandle with correct role', async () => {
    const handle = await openCleoDb('project', tempDir);
    try {
      expect(handle.role).toBe('project');
      expect(handle.db).toBeDefined();
      // The handle exposes the native DatabaseSync — raw SQL works.
      expect(nativeOf(handle).prepare('SELECT 1').get()).toEqual({ '1': 1 });
    } finally {
      await handle.close();
    }
  });

  it('opens the global cleo.db and returns a DBHandle with correct role', async () => {
    const handle = await openCleoDb('global', tempDir);
    try {
      expect(handle.role).toBe('global');
      expect(handle.db).toBeDefined();
      expect(nativeOf(handle).prepare('SELECT 1').get()).toEqual({ '1': 1 });
    } finally {
      await handle.close();
    }
  });

  // T10397 regression (re-homed for E6-L6): the consolidated project cleo.db
  // carries the brain family's `brain_observations` table — the brain domain
  // (formerly the `brain` role) now lives inside the project-scope cleo.db.
  it('project cleo.db exposes the brain schema (brain_observations table) — T10397 regression', async () => {
    const handle = await openCleoDb('project', tempDir);
    try {
      const brainRow = nativeOf(handle)
        .prepare('SELECT name FROM sqlite_schema WHERE type = ? AND name = ?')
        .get('table', 'brain_observations') as { name?: string } | undefined;
      expect(brainRow?.name).toBe('brain_observations');
    } finally {
      await handle.close();
    }
  });

  it('applies canonical pragmas at open time', async () => {
    const handle = await openCleoDb('project', tempDir);
    try {
      const journalMode = nativeOf(handle).prepare('PRAGMA journal_mode').get() as {
        journal_mode: string;
      };
      expect(journalMode.journal_mode.toLowerCase()).toBe('wal');

      const busyTimeout = nativeOf(handle).prepare('PRAGMA busy_timeout').get() as {
        busy_timeout?: number;
        timeout?: number;
      };
      // SSoT busy_timeout (specs/sqlite-pragmas.json) — raised 5000 → 30000 (T11363).
      expect(busyTimeout.busy_timeout ?? busyTimeout.timeout).toBe(30000);
    } finally {
      await handle.close();
    }
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
      // SSoT busy_timeout (specs/sqlite-pragmas.json) — raised 5000 → 30000 (T11363).
      expect(busy.busy_timeout ?? busy.timeout).toBe(30000);
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
  // bits of the consolidated GLOBAL cleo.db `nexus_project_registry` schema the
  // gate cares about (T11578 · AC3 — prefixed registry table).
  function makeFakeNexusDb(rows: Array<{ id: string; path: string }>): DatabaseSync {
    const _require = createRequire(import.meta.url);
    const { DatabaseSync: DatabaseSyncCtor } = _require('node:sqlite') as {
      DatabaseSync: new (...args: ConstructorParameters<typeof DatabaseSync>) => DatabaseSync;
    };
    const db = new DatabaseSyncCtor(':memory:');
    db.exec(
      `CREATE TABLE nexus_project_registry (
        project_id   TEXT PRIMARY KEY,
        project_path TEXT NOT NULL UNIQUE
      );`,
    );
    const ins = db.prepare(
      'INSERT INTO nexus_project_registry (project_id, project_path) VALUES (?, ?)',
    );
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

  // E6-L6 (T11526): the project_registry drift check is now keyed on the
  // 'global' scope (which owns the project_registry table, formerly nexus.db).
  // The 'project' scope carries no project_id column → the gate no-ops.
  it("no-ops for the 'project' scope (no project_id column)", () => {
    seedProjectInfo(tempDir, 'pid-canonical');
    const db = makeFakeNexusDb([{ id: 'pid-drift', path: tempDir }]);
    try {
      // Even though the registry would drift, the project scope skips the gate.
      expect(() => validateProjectIdConsistency('project', db, tempDir)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('no-ops when project-info.json is missing (fresh clone, pre-init)', () => {
    // No project-info.json seeded.
    const db = makeFakeNexusDb([{ id: 'pid-anything', path: tempDir }]);
    try {
      expect(() => validateProjectIdConsistency('global', db, tempDir)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('no-ops when projectId is empty (pre-T5333 install)', () => {
    seedProjectInfo(tempDir, '');
    const db = makeFakeNexusDb([{ id: 'pid-anything', path: tempDir }]);
    try {
      expect(() => validateProjectIdConsistency('global', db, tempDir)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('no-ops when project_registry table does not exist (pre-bootstrap global cleo.db)', () => {
    seedProjectInfo(tempDir, 'pid-canonical');
    const _require = createRequire(import.meta.url);
    const { DatabaseSync: DatabaseSyncCtor } = _require('node:sqlite') as {
      DatabaseSync: new (...args: ConstructorParameters<typeof DatabaseSync>) => DatabaseSync;
    };
    const db = new DatabaseSyncCtor(':memory:');
    try {
      expect(() => validateProjectIdConsistency('global', db, tempDir)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('no-ops when project not yet registered (no registry row for this path)', () => {
    seedProjectInfo(tempDir, 'pid-canonical');
    const db = makeFakeNexusDb([{ id: 'pid-someone-else', path: '/some/other/project' }]);
    try {
      expect(() => validateProjectIdConsistency('global', db, tempDir)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('succeeds when projectId matches (the happy path)', () => {
    seedProjectInfo(tempDir, 'pid-canonical');
    const db = makeFakeNexusDb([{ id: 'pid-canonical', path: tempDir }]);
    try {
      expect(() => validateProjectIdConsistency('global', db, tempDir)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('throws E_PROJECT_ID_DRIFT when registry project_id mismatches project-info.json', () => {
    seedProjectInfo(tempDir, 'pid-canonical');
    const db = makeFakeNexusDb([{ id: 'pid-drift', path: tempDir }]);
    try {
      expect(() => validateProjectIdConsistency('global', db, tempDir)).toThrow(
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
        validateProjectIdConsistency('global', db, tempDir);
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
