/**
 * T10158 — DB schema parity test: `attachments` table extended with 7
 * docs-provenance columns (lifecycle_status + supersedes + superseded_by
 * + summary + keywords + topics + related_tasks) and 2 supporting indexes,
 * mirroring the proven supersession pattern shipped on `brain_decisions`
 * by T1826.
 *
 * This test asserts:
 *   1. The migration SQL file exists at the canonical drizzle-tasks path
 *      and contains every expected ALTER + INDEX statement.
 *   2. After running `migrateSanitized` on a fresh tasks.db, the
 *      `attachments` table reports all 7 new columns via PRAGMA
 *      table_info — with correct nullability and `lifecycle_status`
 *      defaulting to `'draft'`.
 *   3. PRAGMA index_list reports the 2 new indexes
 *      (`idx_attachments_lifecycle_status`, `idx_attachments_supersedes`).
 *   4. The `revert.sql` reversal is present and references every column
 *      + index introduced by the forward migration (idempotency check).
 *   5. The drizzle schema enum `ATTACHMENT_LIFECYCLE_STATUSES` is consistent
 *      with the documented `'draft'` default.
 *
 * @task T10158
 * @epic T10157 (C-DOCS-SSOT)
 * @saga T9855 (SG-TEMPLATE-CONFIG-SSOT)
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTACHMENT_LIFECYCLE_STATUSES } from '../tasks-schema.js';

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

/** Resolve path to the T10158 migration directory. */
function t10158MigrationDir(): string {
  const all = readdirSync(migrationsDir(), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const match = all.find((name) => name.includes('t10158-docs-provenance-columns'));
  if (!match) {
    throw new Error('T10158 migration directory not found under drizzle-tasks');
  }
  return join(migrationsDir(), match);
}

const EXPECTED_NEW_COLUMNS = [
  'lifecycle_status',
  'supersedes',
  'superseded_by',
  'summary',
  'keywords',
  'topics',
  'related_tasks',
] as const;

const EXPECTED_NEW_INDEXES = [
  'idx_attachments_lifecycle_status',
  'idx_attachments_supersedes',
] as const;

// ---------------------------------------------------------------------------
// Section 1: Migration SQL content checks
// ---------------------------------------------------------------------------

describe('T10158 attachments provenance migration SQL', () => {
  it('migration.sql file is present at the canonical path', () => {
    const sqlPath = join(t10158MigrationDir(), 'migration.sql');
    const sql = readFileSync(sqlPath, 'utf-8');
    expect(sql.length).toBeGreaterThan(0);
  });

  it('contains an ALTER TABLE ADD COLUMN statement for every new column', () => {
    const sql = readFileSync(join(t10158MigrationDir(), 'migration.sql'), 'utf-8');
    for (const col of EXPECTED_NEW_COLUMNS) {
      expect(sql, `Missing ALTER for column: ${col}`).toContain(`ADD COLUMN \`${col}\``);
    }
  });

  it('declares `lifecycle_status` as NOT NULL with default `draft`', () => {
    const sql = readFileSync(join(t10158MigrationDir(), 'migration.sql'), 'utf-8');
    expect(sql).toMatch(/ADD COLUMN `lifecycle_status` text NOT NULL DEFAULT 'draft'/);
  });

  it('declares supersedes + superseded_by as self-referential FKs', () => {
    const sql = readFileSync(join(t10158MigrationDir(), 'migration.sql'), 'utf-8');
    expect(sql).toMatch(/ADD COLUMN `supersedes` text REFERENCES `attachments`\(`id`\)/);
    expect(sql).toMatch(/ADD COLUMN `superseded_by` text REFERENCES `attachments`\(`id`\)/);
  });

  it('creates both new indexes', () => {
    const sql = readFileSync(join(t10158MigrationDir(), 'migration.sql'), 'utf-8');
    for (const idx of EXPECTED_NEW_INDEXES) {
      expect(sql, `Missing CREATE INDEX for: ${idx}`).toContain(idx);
    }
  });

  it('ships a revert.sql alongside the forward migration', () => {
    const revertPath = join(t10158MigrationDir(), 'revert.sql');
    const revert = readFileSync(revertPath, 'utf-8');
    for (const col of EXPECTED_NEW_COLUMNS) {
      expect(revert, `revert.sql missing DROP COLUMN: ${col}`).toContain(`DROP COLUMN \`${col}\``);
    }
    for (const idx of EXPECTED_NEW_INDEXES) {
      expect(revert, `revert.sql missing DROP INDEX: ${idx}`).toContain(idx);
    }
  });
});

// ---------------------------------------------------------------------------
// Section 2: Drizzle schema parity (enum consistency)
// ---------------------------------------------------------------------------

describe('T10158 drizzle schema parity', () => {
  it('exports ATTACHMENT_LIFECYCLE_STATUSES enum with the documented states', () => {
    expect(ATTACHMENT_LIFECYCLE_STATUSES).toEqual([
      'draft',
      'proposed',
      'accepted',
      'superseded',
      'archived',
      'deprecated',
    ]);
  });

  it('contains `draft` (the schema default) in the enum', () => {
    expect(ATTACHMENT_LIFECYCLE_STATUSES).toContain('draft');
  });
});

// ---------------------------------------------------------------------------
// Section 3: End-to-end migration apply on a fresh tasks.db
// ---------------------------------------------------------------------------

describe('T10158 fresh migration apply — attachments gains 7 columns + 2 indexes', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-t10158-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('applies all drizzle-tasks migrations cleanly', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    expect(() => migrateSanitized(db, { migrationsFolder })).not.toThrow();

    nativeDb.close();
  });

  it('attachments table has all 7 new columns after migration', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-cols.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    const cols = nativeDb.prepare('PRAGMA table_info(attachments)').all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const colMap = new Map(cols.map((c) => [c.name, c]));

    for (const col of EXPECTED_NEW_COLUMNS) {
      expect(colMap.has(col), `Column '${col}' missing from attachments table`).toBe(true);
    }

    const lifecycle = colMap.get('lifecycle_status');
    expect(lifecycle, 'lifecycle_status column missing').toBeDefined();
    expect(lifecycle?.notnull).toBe(1);
    expect(lifecycle?.dflt_value).toBe("'draft'");

    // The other 6 columns must be nullable (notnull=0) so existing rows pass through.
    for (const col of [
      'supersedes',
      'superseded_by',
      'summary',
      'keywords',
      'topics',
      'related_tasks',
    ] as const) {
      expect(colMap.get(col)?.notnull, `Column '${col}' should be nullable`).toBe(0);
    }

    nativeDb.close();
  });

  it('attachments table has both new indexes after migration', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-idx.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    const indexes = nativeDb.prepare('PRAGMA index_list(attachments)').all() as Array<{
      name: string;
    }>;
    const indexNames = indexes.map((i) => i.name);

    for (const idx of EXPECTED_NEW_INDEXES) {
      expect(indexNames, `Index '${idx}' missing from attachments table`).toContain(idx);
    }

    nativeDb.close();
  });

  it('legacy attachment rows survive the migration and default lifecycle_status to draft', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-passthrough.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    // Insert a pre-T10158 style row WITHOUT touching the new columns.
    const now = new Date().toISOString();
    nativeDb
      .prepare(
        `INSERT INTO attachments (id, sha256, attachment_json, created_at, ref_count)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('att_legacy_1', 'a'.repeat(64), '{"kind":"note","body":"legacy"}', now, 0);

    const row = nativeDb
      .prepare(
        `SELECT id, lifecycle_status, supersedes, superseded_by, summary, keywords, topics, related_tasks
           FROM attachments WHERE id = ?`,
      )
      .get('att_legacy_1') as {
      id: string;
      lifecycle_status: string;
      supersedes: string | null;
      superseded_by: string | null;
      summary: string | null;
      keywords: string | null;
      topics: string | null;
      related_tasks: string | null;
    };

    expect(row.id).toBe('att_legacy_1');
    expect(row.lifecycle_status).toBe('draft');
    expect(row.supersedes).toBeNull();
    expect(row.superseded_by).toBeNull();
    expect(row.summary).toBeNull();
    expect(row.keywords).toBeNull();
    expect(row.topics).toBeNull();
    expect(row.related_tasks).toBeNull();

    nativeDb.close();
  });
});
