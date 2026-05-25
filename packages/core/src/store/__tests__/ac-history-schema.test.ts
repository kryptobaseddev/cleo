/**
 * Schema parity guardrails for the T10504 retention table:
 *   `task_acceptance_criteria_history`.
 *
 * Each test validates that:
 *   1. The Drizzle schema in `tasks-schema.ts` exposes the table with
 *      the expected column set.
 *   2. The hand-authored migration SQL creates the table with the
 *      correct columns (snake_case) and the dominant-access-pattern
 *      index `(ac_id, recorded_at DESC)`.
 *   3. The migration applies cleanly on a fresh in-memory tasks.db via
 *      the standard `migrateSanitized` pipeline.
 *   4. The intentional design choices documented in the research doc
 *      `ac-history-model-decision` are reflected in the schema:
 *        - INTEGER AUTOINCREMENT primary key (not UUID).
 *        - NO foreign key on `ac_id` (history survives AC deletion).
 *        - Index in DESC order on `recorded_at` for "latest-first" reads.
 *
 * @task T10504
 * @epic T10381
 * @saga T10377
 * @decision D013
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AC_HISTORY_REASONS, taskAcceptanceCriteriaHistory } from '../tasks-schema.js';

vi.mock('../../logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const _require = createRequire(import.meta.url);
const { DatabaseSync: _DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
    opts?: { readonly?: boolean },
  ) => import('node:sqlite').DatabaseSync;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIGRATION_FOLDER = '20260524000004_t10504-ac-history';

/** Absolute path to the canonical drizzle-tasks migration root. */
function migrationsDir(): string {
  return join(__dirname, '..', '..', '..', 'migrations', 'drizzle-tasks');
}

/** Read the T10504 migration SQL as a string. */
function readMigrationSql(): string {
  return readFileSync(join(migrationsDir(), MIGRATION_FOLDER, 'migration.sql'), 'utf-8');
}

// ---------------------------------------------------------------------------
// Section 1: Drizzle schema parity
// ---------------------------------------------------------------------------

describe('T10504 Drizzle schema — taskAcceptanceCriteriaHistory', () => {
  it('exports the table with the expected column set', () => {
    const cols = Object.keys(taskAcceptanceCriteriaHistory);
    expect(cols).toContain('id');
    expect(cols).toContain('acId');
    expect(cols).toContain('recordedAt');
    expect(cols).toContain('previousText');
    expect(cols).toContain('reason');
  });

  it('exports the canonical AC_HISTORY_REASONS enum', () => {
    expect(AC_HISTORY_REASONS).toContain('drift');
    expect(AC_HISTORY_REASONS).toContain('edit');
    expect(AC_HISTORY_REASONS).toContain('backfill');
    expect(AC_HISTORY_REASONS).toContain('cancel');
    expect(AC_HISTORY_REASONS).toContain('restore');
  });
});

// ---------------------------------------------------------------------------
// Section 2: Migration SQL content checks
// ---------------------------------------------------------------------------

describe('T10504 migration SQL', () => {
  it('creates the task_acceptance_criteria_history table', () => {
    const sql = readMigrationSql();
    expect(sql).toContain('CREATE TABLE `task_acceptance_criteria_history`');
  });

  it('has all five required columns (snake_case)', () => {
    const sql = readMigrationSql();
    const requiredCols = ['id', 'ac_id', 'recorded_at', 'previous_text', 'reason'];
    for (const col of requiredCols) {
      expect(sql, `Missing column: ${col}`).toContain(`\`${col}\``);
    }
  });

  it('declares INTEGER PRIMARY KEY AUTOINCREMENT on id (not UUID)', () => {
    const sql = readMigrationSql();
    expect(sql).toMatch(/`id`\s+integer\s+PRIMARY KEY\s+AUTOINCREMENT/i);
  });

  it('intentionally has NO foreign key on ac_id (per T10494 research)', () => {
    const sql = readMigrationSql();
    // The migration must NOT declare a REFERENCES clause on the ac_id column.
    // We assert by scanning the executable line that introduces `ac_id`
    // — skipping SQL comments which legitimately discuss why the FK was
    // omitted.
    const executableLines = sql.split('\n').filter((l) => !l.trimStart().startsWith('--'));
    const acIdLine = executableLines.find((l) => /`ac_id`/.test(l)) ?? '';
    expect(acIdLine).toMatch(/`ac_id`\s+text\s+NOT NULL/i);
    expect(acIdLine).not.toMatch(/REFERENCES/i);
  });

  it('declares recorded_at default of (datetime("now"))', () => {
    const sql = readMigrationSql();
    expect(sql).toMatch(/`recorded_at`\s+text\s+NOT NULL\s+DEFAULT\s*\(\s*datetime\('now'\)\s*\)/i);
  });

  it('creates the (ac_id, recorded_at DESC) covering index', () => {
    const sql = readMigrationSql();
    expect(sql).toContain('CREATE INDEX `idx_ac_history_ac_id_recorded_at`');
    expect(sql).toMatch(/\(`ac_id`,\s*`recorded_at`\s+DESC\)/i);
  });
});

// ---------------------------------------------------------------------------
// Section 3: End-to-end migration apply on a fresh tasks.db
// ---------------------------------------------------------------------------

describe('T10504 fresh migration apply', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-t10504-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('applies all drizzle-tasks migrations cleanly and creates task_acceptance_criteria_history', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    expect(() => migrateSanitized(db, { migrationsFolder })).not.toThrow();

    const row = nativeDb
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='task_acceptance_criteria_history'",
      )
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('task_acceptance_criteria_history');

    nativeDb.close();
  });

  it('table has the correct columns after migration', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-cols.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    const cols = nativeDb
      .prepare('PRAGMA table_info(task_acceptance_criteria_history)')
      .all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    const colNames = cols.map((c) => c.name);

    expect(colNames).toEqual(['id', 'ac_id', 'recorded_at', 'previous_text', 'reason']);

    // Verify column NOT NULL constraints.
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(byName.ac_id?.notnull).toBe(1);
    expect(byName.recorded_at?.notnull).toBe(1);
    expect(byName.previous_text?.notnull).toBe(1);
    expect(byName.reason?.notnull).toBe(1);

    // id is the sole primary key.
    expect(byName.id?.pk).toBe(1);
    expect(byName.ac_id?.pk).toBe(0);

    nativeDb.close();
  });

  it('intentionally has NO foreign key on ac_id (per T10494 / D013)', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-fk.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    const fks = nativeDb
      .prepare('PRAGMA foreign_key_list(task_acceptance_criteria_history)')
      .all() as Array<{ table: string; from: string }>;
    expect(fks).toHaveLength(0);

    nativeDb.close();
  });

  it('creates the (ac_id, recorded_at DESC) covering index', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-idx.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    const indexes = nativeDb
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=?")
      .all('task_acceptance_criteria_history') as Array<{ name: string; sql: string | null }>;

    const driftIndex = indexes.find((i) => i.name === 'idx_ac_history_ac_id_recorded_at');
    expect(driftIndex).toBeDefined();
    // The DESC ordering on recorded_at must round-trip into the
    // CREATE INDEX SQL stored on sqlite_master — it is load-bearing for
    // the "latest drift first" query optimisation.
    expect(driftIndex?.sql).toMatch(/`?recorded_at`?\s+DESC/i);

    nativeDb.close();
  });

  it('appends successfully via INSERT with autoincrement id and default recorded_at', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-insert.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    nativeDb
      .prepare(
        'INSERT INTO task_acceptance_criteria_history (ac_id, previous_text, reason) VALUES (?, ?, ?)',
      )
      .run('ac-uuid-001', 'old AC text', 'edit');
    nativeDb
      .prepare(
        'INSERT INTO task_acceptance_criteria_history (ac_id, previous_text, reason) VALUES (?, ?, ?)',
      )
      .run('ac-uuid-001', 'older AC text', 'drift');

    const rows = nativeDb
      .prepare(
        'SELECT id, ac_id, previous_text, reason, recorded_at FROM task_acceptance_criteria_history ORDER BY id',
      )
      .all() as Array<{
      id: number;
      ac_id: string;
      previous_text: string;
      reason: string;
      recorded_at: string;
    }>;

    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).toBe(1);
    expect(rows[1]?.id).toBe(2);
    expect(rows[0]?.recorded_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(rows[0]?.reason).toBe('edit');
    expect(rows[1]?.reason).toBe('drift');

    // Orphan AC reference is accepted — no FK constraint to reject it.
    nativeDb
      .prepare(
        'INSERT INTO task_acceptance_criteria_history (ac_id, previous_text, reason) VALUES (?, ?, ?)',
      )
      .run('ac-uuid-never-existed', 'orphan text', 'drift');
    const afterOrphan = nativeDb
      .prepare('SELECT COUNT(*) AS n FROM task_acceptance_criteria_history')
      .get() as { n: number };
    expect(afterOrphan.n).toBe(3);

    nativeDb.close();
  });
});
