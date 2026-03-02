/**
 * Tests for brain.db schema initialization and lifecycle.
 *
 * Verifies database creation, table setup, WAL/journal mode,
 * schema version tracking, and cleanup.
 *
 * @epic T5149
 * @task T5127
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;
let cleoDir: string;

describe('brain.db schema', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-brain-schema-'));
    cleoDir = join(tempDir, '.cleo');
    process.env['CLEO_DIR'] = cleoDir;
  });

  afterEach(async () => {
    const { closeBrainDb } = await import('../brain-sqlite.js');
    closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates brain.db file and .cleo directory on first getBrainDb call', async () => {
    const { getBrainDb, getBrainDbPath, closeBrainDb: close } = await import('../brain-sqlite.js');
    close();
    expect(existsSync(cleoDir)).toBe(false);

    const db = await getBrainDb();
    expect(db).toBeDefined();
    expect(existsSync(getBrainDbPath())).toBe(true);
  });

  it('creates all required tables', async () => {
    const { getBrainDb, getBrainNativeDb, closeBrainDb: close } = await import('../brain-sqlite.js');
    close();
    await getBrainDb();
    const nativeDb = getBrainNativeDb();
    expect(nativeDb).toBeTruthy();

    const tables = nativeDb!.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all() as Array<{ name: string }>;

    const tableNames = tables.map(t => t.name).sort();

    expect(tableNames).toContain('brain_decisions');
    expect(tableNames).toContain('brain_patterns');
    expect(tableNames).toContain('brain_learnings');
    expect(tableNames).toContain('brain_memory_links');
    expect(tableNames).toContain('brain_schema_meta');
  });

  it('creates expected indexes', async () => {
    const { getBrainDb, getBrainNativeDb, closeBrainDb: close } = await import('../brain-sqlite.js');
    close();
    await getBrainDb();
    const nativeDb = getBrainNativeDb();
    expect(nativeDb).toBeTruthy();

    const indexes = nativeDb!.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Array<{ name: string }>;

    const indexNames = indexes.map(i => i.name).sort();

    expect(indexNames).toContain('idx_brain_decisions_type');
    expect(indexNames).toContain('idx_brain_decisions_confidence');
    expect(indexNames).toContain('idx_brain_decisions_outcome');
    expect(indexNames).toContain('idx_brain_decisions_context_epic');
    expect(indexNames).toContain('idx_brain_decisions_context_task');
    expect(indexNames).toContain('idx_brain_patterns_type');
    expect(indexNames).toContain('idx_brain_patterns_impact');
    expect(indexNames).toContain('idx_brain_patterns_frequency');
    expect(indexNames).toContain('idx_brain_learnings_confidence');
    expect(indexNames).toContain('idx_brain_learnings_actionable');
    expect(indexNames).toContain('idx_brain_links_task');
    expect(indexNames).toContain('idx_brain_links_memory');
  });

  it('sets schema version to 1.0.0', async () => {
    const { getBrainDb, getBrainNativeDb, closeBrainDb: close } = await import('../brain-sqlite.js');
    close();
    await getBrainDb();
    const nativeDb = getBrainNativeDb();
    expect(nativeDb).toBeTruthy();

    const result = nativeDb!.prepare(
      "SELECT value FROM brain_schema_meta WHERE key = 'schemaVersion'",
    ).get() as { value: string } | undefined;

    expect(result?.value).toBe('1.0.0');
  });

  it('uses WAL journal mode', async () => {
    const { getBrainDb, getBrainNativeDb, closeBrainDb: close } = await import('../brain-sqlite.js');
    close();
    await getBrainDb();
    const nativeDb = getBrainNativeDb();
    expect(nativeDb).toBeTruthy();

    const result = nativeDb!.prepare('PRAGMA journal_mode').get() as { journal_mode?: string };
    expect(result.journal_mode?.toLowerCase()).toBe('wal');
  });

  it('getBrainDb returns same singleton on repeated calls', async () => {
    const { getBrainDb, closeBrainDb: close } = await import('../brain-sqlite.js');
    close();
    const db1 = await getBrainDb();
    const db2 = await getBrainDb();
    expect(db1).toBe(db2);
  });

  it('closeBrainDb releases resources', async () => {
    const { getBrainDb, closeBrainDb: close, getBrainDbPath } = await import('../brain-sqlite.js');
    close();
    await getBrainDb();
    const dbPath = getBrainDbPath();
    expect(existsSync(dbPath)).toBe(true);

    close();

    // File should still exist after close
    expect(existsSync(dbPath)).toBe(true);
  });

  it('resetBrainDbState clears singleton and allows reinitialization', async () => {
    const { getBrainDb, resetBrainDbState, closeBrainDb: close } = await import('../brain-sqlite.js');
    close();

    const db1 = await getBrainDb();
    expect(db1).toBeDefined();

    resetBrainDbState();

    const db2 = await getBrainDb();
    expect(db2).toBeDefined();
    expect(db2).not.toBe(db1);
  });

  it('resetBrainDbState is safe to call multiple times', async () => {
    const { resetBrainDbState, closeBrainDb: close } = await import('../brain-sqlite.js');
    close();

    expect(() => resetBrainDbState()).not.toThrow();
    expect(() => resetBrainDbState()).not.toThrow();
    expect(() => resetBrainDbState()).not.toThrow();
  });
});
