/**
 * Smoke tests for openCleoDb — canonical database chokepoint.
 *
 * @task T9050
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCleoDb, type CleoDbRole } from '../open-cleo-db.js';

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
    await expect(openCleoDb('llmtxt', tempDir)).rejects.toThrow(
      'not yet implemented',
    );
  });

  it('applies canonical pragmas at open time', async () => {
    const handle = await openCleoDb('tasks', tempDir);
    const journalMode = handle.db
      .prepare('PRAGMA journal_mode')
      .get() as { journal_mode: string };
    expect(journalMode.journal_mode.toLowerCase()).toBe('wal');

    const busyTimeout = handle.db
      .prepare('PRAGMA busy_timeout')
      .get() as { busy_timeout: number };
    expect(busyTimeout.busy_timeout).toBe(5000);

    handle.close();
  });
});
