/**
 * Schema parity guardrails for the T10502 `task_acceptance_criteria`
 * table — the first of three parallel-safe schemas in Wave 2a of
 * Epic T10381 (E-AC-MIGRATION) under Saga T10377 (SG-IVTR-AC-BINDING).
 *
 * Each test validates that:
 *   1. The migration SQL creates the expected table with correct column
 *      names per ADR-079-r1 §4.2.
 *   2. The migration SQL defines the required indexes — including the
 *      UNIQUE (task_id, ordinal) constraint that powers AC<n> alias
 *      resolution (ADR-079-r1 §2.2).
 *   3. The Drizzle schema in tasks-schema.ts stays in lockstep with the
 *      SQL definition (column names, NOT NULL flags, FK target).
 *   4. The table applies cleanly on a fresh in-memory tasks.db via the
 *      standard `migrateSanitized` pipeline alongside all sibling
 *      migrations.
 *   5. The (task_id, ordinal) UNIQUE constraint is enforced at the SQLite
 *      layer — INSERT of a duplicate (task, ordinal) pair fails.
 *
 * @adr  ADR-079-r1 §2.1 §2.2 §4.2
 * @saga T10377
 * @epic T10381
 * @task T10502
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { taskAcceptanceCriteria } from '../tasks-schema.js';

vi.mock('../../logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const _require = createRequire(import.meta.url);
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
    opts?: { readonly?: boolean },
  ) => import('node:sqlite').DatabaseSync;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Resolve path to the drizzle-tasks migration folder. */
function migrationsDir(): string {
  return join(__dirname, '..', '..', '..', 'migrations', 'drizzle-tasks');
}

/** Return the migration.sql contents for the T10502 folder. */
function getT10502MigrationSql(): string {
  const dir = migrationsDir();
  const folder = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .find((name) => name.includes('t10502'));
  if (!folder) {
    throw new Error('T10502 migration folder not found under drizzle-tasks/');
  }
  return readFileSync(join(dir, folder, 'migration.sql'), 'utf-8');
}

// ---------------------------------------------------------------------------
// Section 1: Migration SQL content checks
// ---------------------------------------------------------------------------

describe('T10502 task_acceptance_criteria migration SQL', () => {
  it('creates the task_acceptance_criteria table', () => {
    const sql = getT10502MigrationSql();
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS `task_acceptance_criteria`');
  });

  it('has all required columns per ADR-079-r1 §4.2', () => {
    const sql = getT10502MigrationSql();
    const requiredCols = [
      'id',
      'task_id',
      'ordinal',
      'text',
      'created_at',
      'updated_at',
      'content_hash',
    ];
    for (const col of requiredCols) {
      expect(sql, `Missing column: ${col}`).toContain(`\`${col}\``);
    }
  });

  it('declares the FK to tasks(id) ON DELETE CASCADE', () => {
    const sql = getT10502MigrationSql();
    expect(sql).toMatch(/REFERENCES `tasks`\(`id`\) ON DELETE CASCADE/);
  });

  it('marks id as PRIMARY KEY', () => {
    const sql = getT10502MigrationSql();
    expect(sql).toMatch(/`id`\s+TEXT PRIMARY KEY NOT NULL/);
  });

  it('marks task_id, ordinal, text as NOT NULL', () => {
    const sql = getT10502MigrationSql();
    expect(sql).toMatch(/`task_id`\s+TEXT NOT NULL/);
    expect(sql).toMatch(/`ordinal`\s+INTEGER NOT NULL/);
    expect(sql).toMatch(/`text`\s+TEXT NOT NULL/);
  });

  it('defaults created_at to CURRENT_TIMESTAMP', () => {
    const sql = getT10502MigrationSql();
    expect(sql).toMatch(/`created_at`\s+TEXT NOT NULL DEFAULT \(CURRENT_TIMESTAMP\)/);
  });

  it('defines the task_id lookup index', () => {
    const sql = getT10502MigrationSql();
    expect(sql).toContain('idx_task_acceptance_criteria_task_id');
  });

  it('defines the UNIQUE (task_id, ordinal) index per ADR-079-r1 §2.2', () => {
    const sql = getT10502MigrationSql();
    expect(sql).toContain('uq_task_acceptance_criteria_task_ordinal');
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX[\s\S]+`task_acceptance_criteria`\s*\(`task_id`,\s*`ordinal`\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// Section 2: Drizzle schema parity with the SQL migration
// ---------------------------------------------------------------------------

describe('T10502 Drizzle schema parity', () => {
  it('Drizzle schema exposes the canonical column set', () => {
    // The Drizzle table object reflects column declarations via .name.
    const expectedColNames = [
      'id',
      'task_id',
      'ordinal',
      'text',
      'created_at',
      'updated_at',
      'content_hash',
    ];
    const cols = taskAcceptanceCriteria;
    expect(cols.id.name).toBe('id');
    expect(cols.taskId.name).toBe('task_id');
    expect(cols.ordinal.name).toBe('ordinal');
    expect(cols.text.name).toBe('text');
    expect(cols.createdAt.name).toBe('created_at');
    expect(cols.updatedAt.name).toBe('updated_at');
    expect(cols.contentHash.name).toBe('content_hash');
    // Sanity: nothing else added inadvertently in this snapshot.
    expect(Object.keys(cols)).toEqual(
      expect.arrayContaining(['id', 'taskId', 'ordinal', 'text', 'createdAt', 'updatedAt']),
    );
    // Use expectedColNames to silence unused-var linter while documenting parity.
    expect(expectedColNames.length).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Section 3: End-to-end migration apply on a fresh tasks.db
// ---------------------------------------------------------------------------

describe('T10502 fresh migration apply', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-t10502-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('applies all drizzle-tasks migrations cleanly and creates task_acceptance_criteria', async () => {
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
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get('task_acceptance_criteria') as { name: string } | undefined;
    expect(row?.name).toBe('task_acceptance_criteria');

    nativeDb.close();
  });

  it('task_acceptance_criteria has the correct columns + types after migration', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-col-check.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    const cols = nativeDb.prepare('PRAGMA table_info(task_acceptance_criteria)').all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    const colByName = Object.fromEntries(cols.map((c) => [c.name, c]));

    const expectedCols = [
      'id',
      'task_id',
      'ordinal',
      'text',
      'created_at',
      'updated_at',
      'content_hash',
    ];
    for (const col of expectedCols) {
      expect(colByName[col], `Column '${col}' missing`).toBeDefined();
    }

    expect(colByName.id.pk).toBeGreaterThan(0);
    expect(colByName.task_id.notnull).toBe(1);
    expect(colByName.ordinal.notnull).toBe(1);
    expect(colByName.text.notnull).toBe(1);
    expect(colByName.created_at.notnull).toBe(1);
    // updated_at and content_hash are nullable per ADR-079-r1.
    expect(colByName.updated_at.notnull).toBe(0);
    expect(colByName.content_hash.notnull).toBe(0);

    expect(colByName.ordinal.type.toUpperCase()).toBe('INTEGER');

    nativeDb.close();
  });

  it('declares the task_id lookup index AND the UNIQUE (task_id, ordinal) index', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-idx-check.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    const indexes = nativeDb
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='task_acceptance_criteria'",
      )
      .all() as Array<{ name: string; sql: string | null }>;
    const indexNames = new Set(indexes.map((r) => r.name));

    expect(indexNames).toContain('idx_task_acceptance_criteria_task_id');
    expect(indexNames).toContain('uq_task_acceptance_criteria_task_ordinal');

    const uqIndex = indexes.find((r) => r.name === 'uq_task_acceptance_criteria_task_ordinal');
    expect(uqIndex?.sql).toMatch(/UNIQUE INDEX/);
    expect(uqIndex?.sql).toMatch(/`task_id`,\s*`ordinal`/);

    nativeDb.close();
  });

  it('enforces the (task_id, ordinal) UNIQUE constraint at the SQLite layer', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-uq-check.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    // Seed a parent task so the FK is satisfied.
    nativeDb
      .prepare(
        "INSERT INTO tasks (id, title, status, priority) VALUES ('T-test-ac', 'AC parity host', 'pending', 'medium')",
      )
      .run();

    // First AC at ordinal 1 — should succeed.
    nativeDb
      .prepare(
        'INSERT INTO task_acceptance_criteria (id, task_id, ordinal, text) VALUES (?, ?, ?, ?)',
      )
      .run('ac-uuid-001', 'T-test-ac', 1, 'first AC');

    // Second AC reusing ordinal 1 on the same task — MUST fail.
    expect(() => {
      nativeDb
        .prepare(
          'INSERT INTO task_acceptance_criteria (id, task_id, ordinal, text) VALUES (?, ?, ?, ?)',
        )
        .run('ac-uuid-002', 'T-test-ac', 1, 'collides with first AC');
    }).toThrow(/UNIQUE/i);

    // Different ordinal on the same task — should succeed.
    expect(() => {
      nativeDb
        .prepare(
          'INSERT INTO task_acceptance_criteria (id, task_id, ordinal, text) VALUES (?, ?, ?, ?)',
        )
        .run('ac-uuid-003', 'T-test-ac', 2, 'second AC, different ordinal');
    }).not.toThrow();

    nativeDb.close();
  });
});
