/**
 * Tests for brain.db schema initialization and lifecycle.
 *
 * Verifies database creation, table setup, WAL/journal mode,
 * schema version tracking, and cleanup.
 *
 * @epic T5149
 * @task T5127
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;
let cleoDir: string;

describe('brain.db schema', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-memory-schema-'));
    cleoDir = join(tempDir, '.cleo');
    process.env['CLEO_DIR'] = cleoDir;
  });

  afterEach(async () => {
    const { closeBrainDb } = await import('../memory-sqlite.js');
    closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates brain.db file and .cleo directory on first getBrainDb call', async () => {
    const { getBrainDb, getBrainDbPath, closeBrainDb: close } = await import('../memory-sqlite.js');
    close();
    expect(existsSync(cleoDir)).toBe(false);

    const db = await getBrainDb();
    expect(db).toBeDefined();
    expect(existsSync(getBrainDbPath())).toBe(true);
  });

  it('creates all required tables', async () => {
    const {
      getBrainDb,
      getBrainNativeDb,
      closeBrainDb: close,
    } = await import('../memory-sqlite.js');
    close();
    await getBrainDb();
    const nativeDb = getBrainNativeDb();
    expect(nativeDb).toBeTruthy();

    const tables = nativeDb!
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;

    const tableNames = tables.map((t) => t.name).sort();

    expect(tableNames).toContain('brain_decisions');
    expect(tableNames).toContain('brain_patterns');
    expect(tableNames).toContain('brain_learnings');
    expect(tableNames).toContain('brain_memory_links');
    expect(tableNames).toContain('brain_schema_meta');
  });

  it('creates expected indexes', async () => {
    const {
      getBrainDb,
      getBrainNativeDb,
      closeBrainDb: close,
    } = await import('../memory-sqlite.js');
    close();
    await getBrainDb();
    const nativeDb = getBrainNativeDb();
    expect(nativeDb).toBeTruthy();

    const indexes = nativeDb!
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;

    const indexNames = indexes.map((i) => i.name).sort();

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
    const {
      getBrainDb,
      getBrainNativeDb,
      closeBrainDb: close,
    } = await import('../memory-sqlite.js');
    close();
    await getBrainDb();
    const nativeDb = getBrainNativeDb();
    expect(nativeDb).toBeTruthy();

    const result = nativeDb!
      .prepare("SELECT value FROM brain_schema_meta WHERE key = 'schemaVersion'")
      .get() as { value: string } | undefined;

    expect(result?.value).toBe('1.0.0');
  });

  it('uses WAL journal mode', async () => {
    const {
      getBrainDb,
      getBrainNativeDb,
      closeBrainDb: close,
    } = await import('../memory-sqlite.js');
    close();
    await getBrainDb();
    const nativeDb = getBrainNativeDb();
    expect(nativeDb).toBeTruthy();

    const result = nativeDb!.prepare('PRAGMA journal_mode').get() as { journal_mode?: string };
    expect(result.journal_mode?.toLowerCase()).toBe('wal');
  });

  it('getBrainDb returns same singleton on repeated calls', async () => {
    const { getBrainDb, closeBrainDb: close } = await import('../memory-sqlite.js');
    close();
    const db1 = await getBrainDb();
    const db2 = await getBrainDb();
    expect(db1).toBe(db2);
  });

  it('closeBrainDb releases resources', async () => {
    const { getBrainDb, closeBrainDb: close, getBrainDbPath } = await import('../memory-sqlite.js');
    close();
    await getBrainDb();
    const dbPath = getBrainDbPath();
    expect(existsSync(dbPath)).toBe(true);

    close();

    // File should still exist after close
    expect(existsSync(dbPath)).toBe(true);
  });

  it('resetBrainDbState clears the brain singleton and allows reinitialization', async () => {
    const {
      getBrainDb,
      getBrainNativeDb,
      resetBrainDbState,
      closeBrainDb: close,
    } = await import('../memory-sqlite.js');
    close();

    const db1 = await getBrainDb();
    expect(db1).toBeDefined();
    const nativeDb1 = getBrainNativeDb();
    expect(nativeDb1).not.toBeNull();

    // E6-L2 (T11522): resetBrainDbState drops the brain singleton refs but does
    // NOT close the shared dual-scope `cleo.db` handle (co-owned by the tasks
    // domain). After reset, getBrainDb re-derives a fresh brain drizzle wrapper
    // bound to the SAME live shared handle — proving the singleton was cleared
    // (re-init ran) while the shared connection stayed alive.
    resetBrainDbState();

    const db2 = await getBrainDb();
    expect(db2).toBeDefined();
    // A new drizzle wrapper instance was produced (the singleton was cleared).
    expect(Object.is(db2, db1)).toBe(false);
    const nativeDb2 = getBrainNativeDb();
    expect(nativeDb2).not.toBeNull();
    // The underlying shared dual-scope handle is the SAME and still open.
    expect(Object.is(nativeDb2, nativeDb1)).toBe(true);
    expect(nativeDb2?.isOpen).toBe(true);
  });

  it('resetBrainDbState is safe to call multiple times', async () => {
    const { resetBrainDbState, closeBrainDb: close } = await import('../memory-sqlite.js');
    close();

    expect(() => resetBrainDbState()).not.toThrow();
    expect(() => resetBrainDbState()).not.toThrow();
    expect(() => resetBrainDbState()).not.toThrow();
  });

  // T10405 (SG-PSYCHE-FOUNDATION · Tier 5): bitemporal + four-network columns.

  /** Return the set of column names for a table via PRAGMA table_info. */
  async function columnNames(table: string): Promise<Set<string>> {
    const {
      getBrainDb,
      getBrainNativeDb,
      closeBrainDb: close,
    } = await import('../memory-sqlite.js');
    close();
    await getBrainDb();
    const nativeDb = getBrainNativeDb();
    expect(nativeDb).toBeTruthy();
    const cols = nativeDb!.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
      name: string;
    }>;
    return new Set(cols.map((c) => c.name));
  }

  const BITEMPORAL_NETWORK_TABLES = [
    'brain_decisions',
    'brain_patterns',
    'brain_learnings',
    'brain_observations',
  ] as const;

  for (const table of BITEMPORAL_NETWORK_TABLES) {
    it(`adds expired_at + network columns to ${table}`, async () => {
      const cols = await columnNames(table);
      // The full 4-timestamp bitemporal set: a creation timestamp + valid_at +
      // invalid_at shipped earlier; expired_at is the T10405 4th timestamp.
      // brain_patterns names its creation timestamp `extracted_at`; the other
      // three use `created_at`.
      const creationCol = table === 'brain_patterns' ? 'extracted_at' : 'created_at';
      expect(cols.has(creationCol)).toBe(true);
      expect(cols.has('valid_at')).toBe(true);
      expect(cols.has('invalid_at')).toBe(true);
      expect(cols.has('expired_at')).toBe(true);
      // Four-network classification column.
      expect(cols.has('network')).toBe(true);
    });
  }

  it('adds next_attempt_at backoff column to deriver_queue', async () => {
    const cols = await columnNames('deriver_queue');
    expect(cols.has('next_attempt_at')).toBe(true);
  });

  it('creates the T10405 bitemporal + network indexes', async () => {
    const {
      getBrainDb,
      getBrainNativeDb,
      closeBrainDb: close,
    } = await import('../memory-sqlite.js');
    close();
    await getBrainDb();
    const nativeDb = getBrainNativeDb();
    expect(nativeDb).toBeTruthy();

    const indexNames = new Set(
      (
        nativeDb!
          .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'")
          .all() as Array<{ name: string }>
      ).map((i) => i.name),
    );

    for (const table of BITEMPORAL_NETWORK_TABLES) {
      expect(indexNames.has(`idx_${table}_expired_at`)).toBe(true);
      expect(indexNames.has(`idx_${table}_network`)).toBe(true);
    }
  });

  it('defaults network per cognitive role and accepts an explicit four-network value', async () => {
    const {
      getBrainDb,
      getBrainNativeDb,
      closeBrainDb: close,
    } = await import('../memory-sqlite.js');
    close();
    await getBrainDb();
    const nativeDb = getBrainNativeDb();
    expect(nativeDb).toBeTruthy();

    // Insert a decision row WITHOUT network → DEFAULT 'bank'; verify expired_at NULL.
    nativeDb!
      .prepare(
        `INSERT INTO brain_decisions (id, type, decision, rationale, confidence)
         VALUES (?, 'architecture', 'd', 'r', 'high')`,
      )
      .run('dec-t10405-default');
    const defaulted = nativeDb!
      .prepare('SELECT network, expired_at FROM brain_decisions WHERE id = ?')
      .get('dec-t10405-default') as { network: string | null; expired_at: string | null };
    expect(defaulted.network).toBe('bank');
    expect(defaulted.expired_at).toBeNull();

    // Insert an observation with an EXPLICIT four-network value + expired_at.
    const expiry = new Date().toISOString();
    nativeDb!
      .prepare(
        `INSERT INTO brain_observations (id, type, title, network, expired_at)
         VALUES (?, 'discovery', 't', 'world', ?)`,
      )
      .run('obs-t10405-explicit', expiry);
    const explicit = nativeDb!
      .prepare('SELECT network, expired_at FROM brain_observations WHERE id = ?')
      .get('obs-t10405-explicit') as { network: string | null; expired_at: string | null };
    expect(explicit.network).toBe('world');
    expect(explicit.expired_at).toBe(expiry);
  });
});
