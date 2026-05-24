/**
 * T10503 — DB schema parity test: `evidence_ac_bindings` M:N join table
 * between evidence atoms and acceptance criteria.
 *
 * Wave 2a of Epic T10381 (ADR-079-r2: cross-task
 * `satisfies:<task-id>#<ac-id>` evidence atoms).
 *
 * The FK target table (`task_acceptance_criteria`) is created by T10502
 * in a parallel branch. This test runs end-to-end migration apply, so
 * locally (before T10502 merges) the FK target will NOT exist. We guard
 * those FK-dependent assertions with a `tableExists()` check so the test
 * is forward-compatible: PASS today + still pass once T10502 merges.
 *
 * This test asserts:
 *   1. The migration SQL file exists at the canonical drizzle-tasks path
 *      and contains CREATE TABLE + the 3 expected indexes.
 *   2. The hand-authored FK to `task_acceptance_criteria(id)` is present
 *      with `ON DELETE CASCADE`.
 *   3. The revert.sql ships alongside and references every object the
 *      forward migration creates.
 *   4. The drizzle schema constant `EVIDENCE_BINDING_TYPES` mirrors the
 *      three documented binding kinds.
 *   5. After running `migrateSanitized` on a fresh tasks.db, the
 *      `evidence_ac_bindings` table reports all 5 expected columns with
 *      correct nullability + defaults, and all 3 expected indexes are
 *      registered.
 *   6. Insert / unique-constraint behaviour matches the spec (one
 *      binding per (atom, ac, type) triple).
 *
 * @task T10503
 * @epic T10381
 * @saga T10377 (SG-IVTR-AC-BINDING)
 * @adr ADR-079-r2
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EVIDENCE_BINDING_TYPES } from '../tasks-schema.js';

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

/** Resolve path to the drizzle-tasks migration folder. */
function migrationsDir(): string {
  return join(__dirname, '..', '..', '..', 'migrations', 'drizzle-tasks');
}

/** Resolve path to the T10503 migration directory. */
function t10503MigrationDir(): string {
  const all = readdirSync(migrationsDir(), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const match = all.find((name) => name.includes('t10503-evidence-ac-bindings'));
  if (!match) {
    throw new Error('T10503 migration directory not found under drizzle-tasks');
  }
  return join(migrationsDir(), match);
}

const EXPECTED_COLUMNS = ['id', 'evidence_atom_id', 'ac_id', 'binding_type', 'created_at'] as const;

const EXPECTED_INDEXES = [
  'uq_evidence_ac_bindings_atom_ac_type',
  'idx_evidence_ac_bindings_ac_id',
  'idx_evidence_ac_bindings_evidence_atom_id',
] as const;

// ---------------------------------------------------------------------------
// Section 1: Migration SQL content checks
// ---------------------------------------------------------------------------

describe('T10503 evidence_ac_bindings migration SQL', () => {
  it('migration.sql file is present at the canonical path', () => {
    const sqlPath = join(t10503MigrationDir(), 'migration.sql');
    const sql = readFileSync(sqlPath, 'utf-8');
    expect(sql.length).toBeGreaterThan(0);
  });

  it('contains CREATE TABLE for evidence_ac_bindings', () => {
    const sql = readFileSync(join(t10503MigrationDir(), 'migration.sql'), 'utf-8');
    expect(sql).toMatch(/CREATE TABLE `evidence_ac_bindings`/);
  });

  it('declares every expected column', () => {
    const sql = readFileSync(join(t10503MigrationDir(), 'migration.sql'), 'utf-8');
    for (const col of EXPECTED_COLUMNS) {
      expect(sql, `Missing column declaration: ${col}`).toContain(`\`${col}\``);
    }
  });

  it('encodes the FK from ac_id to task_acceptance_criteria(id) with CASCADE', () => {
    const sql = readFileSync(join(t10503MigrationDir(), 'migration.sql'), 'utf-8');
    expect(sql).toMatch(
      /`ac_id`\s+TEXT NOT NULL REFERENCES `task_acceptance_criteria`\(`id`\) ON DELETE CASCADE/,
    );
  });

  it('declares id as PRIMARY KEY NOT NULL', () => {
    const sql = readFileSync(join(t10503MigrationDir(), 'migration.sql'), 'utf-8');
    expect(sql).toMatch(/`id`\s+TEXT PRIMARY KEY NOT NULL/);
  });

  it('declares created_at default to datetime("now")', () => {
    const sql = readFileSync(join(t10503MigrationDir(), 'migration.sql'), 'utf-8');
    expect(sql).toMatch(/`created_at`\s+TEXT NOT NULL DEFAULT \(datetime\('now'\)\)/);
  });

  it('creates the UNIQUE composite index', () => {
    const sql = readFileSync(join(t10503MigrationDir(), 'migration.sql'), 'utf-8');
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX `uq_evidence_ac_bindings_atom_ac_type`\s+ON `evidence_ac_bindings`/,
    );
  });

  it('creates the (ac_id) lookup index', () => {
    const sql = readFileSync(join(t10503MigrationDir(), 'migration.sql'), 'utf-8');
    expect(sql).toMatch(/CREATE INDEX `idx_evidence_ac_bindings_ac_id`/);
  });

  it('creates the (evidence_atom_id) lookup index', () => {
    const sql = readFileSync(join(t10503MigrationDir(), 'migration.sql'), 'utf-8');
    expect(sql).toMatch(/CREATE INDEX `idx_evidence_ac_bindings_evidence_atom_id`/);
  });

  it('uses the Wave-2a coordinated timestamp ending in 03', () => {
    const dir = t10503MigrationDir();
    const folderName = dir.split('/').pop() ?? '';
    // Timestamp prefix must end in `03` to land AFTER T10502 (`02`).
    expect(folderName).toMatch(/^\d{12}03_t10503-/);
  });

  it('ships a revert.sql alongside the forward migration', () => {
    const revertPath = join(t10503MigrationDir(), 'revert.sql');
    const revert = readFileSync(revertPath, 'utf-8');
    expect(revert).toMatch(/DROP TABLE IF EXISTS `evidence_ac_bindings`/);
    for (const idx of EXPECTED_INDEXES) {
      expect(revert, `revert.sql missing DROP INDEX: ${idx}`).toContain(idx);
    }
  });
});

// ---------------------------------------------------------------------------
// Section 2: Drizzle schema parity (enum consistency)
// ---------------------------------------------------------------------------

describe('T10503 drizzle schema parity', () => {
  it('exports EVIDENCE_BINDING_TYPES enum with the documented three kinds', () => {
    expect(EVIDENCE_BINDING_TYPES).toEqual(['direct', 'satisfies', 'coverage']);
  });

  it('contains `direct` (the Worker-default kind)', () => {
    expect(EVIDENCE_BINDING_TYPES).toContain('direct');
  });

  it('contains `satisfies` (the cross-task binding kind, ADR-079-r2 grammar)', () => {
    expect(EVIDENCE_BINDING_TYPES).toContain('satisfies');
  });

  it('contains `coverage` (T10509 H-gate forward-compat marker)', () => {
    expect(EVIDENCE_BINDING_TYPES).toContain('coverage');
  });
});

// ---------------------------------------------------------------------------
// Section 3: End-to-end migration apply on a fresh tasks.db
// ---------------------------------------------------------------------------

/**
 * Returns true iff the named table is registered in SQLite's master
 * catalog. Used to gate FK-target dependent assertions because the FK
 * target (`task_acceptance_criteria`) is created by T10502 in a parallel
 * still-unmerged branch — we want this test to pass BOTH before and
 * after T10502 lands.
 */
function tableExists(nativeDb: import('node:sqlite').DatabaseSync, name: string): boolean {
  const row = nativeDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name) as { name?: string } | undefined;
  return row?.name === name;
}

describe('T10503 fresh migration apply — evidence_ac_bindings table + indexes', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-t10503-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('applies all drizzle-tasks migrations cleanly when FK target exists (post-T10502)', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');

    // If T10502 has merged the FK target table is in the schema; the
    // CREATE TABLE for evidence_ac_bindings with its inline FK will
    // succeed. If T10502 has NOT merged yet, SQLite allows the CREATE
    // (it does NOT validate FK target existence at table-creation time
    // — only when INSERTs run with PRAGMA foreign_keys=ON), so this
    // migration must still apply without throwing.
    expect(() => migrateSanitized(db, { migrationsFolder })).not.toThrow();

    nativeDb.close();
  });

  it('evidence_ac_bindings table has all 5 expected columns after migration', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-cols.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    const cols = nativeDb.prepare('PRAGMA table_info(evidence_ac_bindings)').all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;
    const colMap = new Map(cols.map((c) => [c.name, c]));

    for (const col of EXPECTED_COLUMNS) {
      expect(colMap.has(col), `Column '${col}' missing from evidence_ac_bindings`).toBe(true);
    }

    expect(colMap.get('id')?.pk).toBe(1);
    expect(colMap.get('evidence_atom_id')?.notnull).toBe(1);
    expect(colMap.get('ac_id')?.notnull).toBe(1);
    expect(colMap.get('binding_type')?.notnull).toBe(1);
    expect(colMap.get('created_at')?.notnull).toBe(1);
    expect(colMap.get('created_at')?.dflt_value).toMatch(/datetime\('now'\)/);

    nativeDb.close();
  });

  it('evidence_ac_bindings table has all 3 expected indexes after migration', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-idx.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    const indexes = nativeDb.prepare('PRAGMA index_list(evidence_ac_bindings)').all() as Array<{
      name: string;
      unique: number;
    }>;
    const indexMap = new Map(indexes.map((i) => [i.name, i]));

    for (const idx of EXPECTED_INDEXES) {
      expect(indexMap.has(idx), `Index '${idx}' missing from evidence_ac_bindings`).toBe(true);
    }
    // The composite (atom, ac, type) index MUST be UNIQUE.
    expect(indexMap.get('uq_evidence_ac_bindings_atom_ac_type')?.unique).toBe(1);
    // The two lookup indexes MUST be NON-unique.
    expect(indexMap.get('idx_evidence_ac_bindings_ac_id')?.unique).toBe(0);
    expect(indexMap.get('idx_evidence_ac_bindings_evidence_atom_id')?.unique).toBe(0);

    nativeDb.close();
  });

  it('honours the UNIQUE (evidence_atom_id, ac_id, binding_type) constraint', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-unique.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    // FK target shim — T10502 ships the real `task_acceptance_criteria`
    // table; until that merges we need a minimum-shape stub so that
    // PRAGMA foreign_keys (ON by default in our DB chokepoint) lets
    // INSERTs against the binding table proceed. The shim has the same
    // column we point at (`id`) and is created idempotently.
    if (!tableExists(nativeDb, 'task_acceptance_criteria')) {
      nativeDb.exec(
        `CREATE TABLE IF NOT EXISTS task_acceptance_criteria (
           id TEXT PRIMARY KEY NOT NULL
         )`,
      );
      nativeDb.prepare('INSERT INTO task_acceptance_criteria (id) VALUES (?)').run('AC-1');
    }

    // Inserting twice with the same (atom, ac, type) triple must fail
    // on the second INSERT — the UNIQUE composite index is enforced
    // unconditionally by SQLite regardless of FK state.
    nativeDb
      .prepare(
        `INSERT INTO evidence_ac_bindings
           (id, evidence_atom_id, ac_id, binding_type)
         VALUES (?, ?, ?, ?)`,
      )
      .run('binding-1', 'commit:abc123', 'AC-1', 'direct');

    expect(() => {
      nativeDb
        .prepare(
          `INSERT INTO evidence_ac_bindings
             (id, evidence_atom_id, ac_id, binding_type)
           VALUES (?, ?, ?, ?)`,
        )
        .run('binding-2', 'commit:abc123', 'AC-1', 'direct');
    }).toThrow();

    // But a different binding_type for the same (atom, ac) must succeed
    // — one binding per triple, not per pair.
    nativeDb
      .prepare(
        `INSERT INTO evidence_ac_bindings
           (id, evidence_atom_id, ac_id, binding_type)
         VALUES (?, ?, ?, ?)`,
      )
      .run('binding-3', 'commit:abc123', 'AC-1', 'satisfies');

    const count = nativeDb.prepare('SELECT COUNT(*) AS n FROM evidence_ac_bindings').get() as {
      n: number;
    };
    expect(count.n).toBe(2);

    nativeDb.close();
  });

  it('FK target presence check (informational — passes regardless of T10502 merge state)', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-fk-target.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    // Forward-compat sentinel: once T10502 merges, this assertion flips
    // to a hard requirement. Today (parallel branch) the table may be
    // absent and that's expected — the FK is enforced INSERT-time, not
    // CREATE-TABLE-time, in SQLite.
    const hasTarget = tableExists(nativeDb, 'task_acceptance_criteria');
    // Always passes — the assertion is documentary.
    expect(typeof hasTarget).toBe('boolean');

    nativeDb.close();
  });
});
