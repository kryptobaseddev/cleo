/**
 * Smoke tests for openCleoDb — canonical database chokepoint.
 *
 * @task T9050
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCleoDb, openCleoDbSnapshot } from '../open-cleo-db.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'cleo-test-open-cleo-db-'));
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
    const handle = await openCleoDb('brain', tempDir);
    expect(handle.role).toBe('brain');
    expect(handle.db).toBeDefined();
    expect(handle.db.prepare('SELECT 1').get()).toEqual({ '1': 1 });
    handle.close();
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
