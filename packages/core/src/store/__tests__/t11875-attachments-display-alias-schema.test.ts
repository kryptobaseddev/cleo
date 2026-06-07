/**
 * T11875 — DB schema parity test: `attachments` gains a nullable
 * `display_alias` INTEGER column (+ one supporting index) so a doc can carry an
 * explicit display NUMBER decoupled from its slug (ADR reconcile T11676).
 *
 * Asserts:
 *   1. The migration SQL file exists at the canonical drizzle-tasks path and
 *      contains the ALTER + INDEX statements.
 *   2. After running every drizzle-tasks migration on a fresh tasks.db, the
 *      `attachments` table reports the `display_alias` column (nullable) and the
 *      `idx_attachments_display_alias` index via PRAGMA.
 *   3. Legacy rows pass through with NULL `display_alias` (no rewrite).
 *
 * @task T11875
 * @epic T11781 (E3-OBSIDIAN-INTEGRATION)
 * @saga T11778 (SG-DOCS-SSOT-VAULT)
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Resolve path to the drizzle-tasks migration folder. */
function migrationsDir(): string {
  return join(__dirname, '..', '..', '..', 'migrations', 'drizzle-tasks');
}

/** Resolve path to the T11875 migration directory. */
function t11875MigrationDir(): string {
  const all = readdirSync(migrationsDir(), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const match = all.find((name) => name.includes('t11875-attachments-display-alias'));
  if (!match) {
    throw new Error('T11875 migration directory not found under drizzle-tasks');
  }
  return join(migrationsDir(), match);
}

// ---------------------------------------------------------------------------
// Section 1: Migration SQL content checks
// ---------------------------------------------------------------------------

describe('T11875 attachments display-alias migration SQL', () => {
  it('migration.sql file is present at the canonical path', () => {
    const sql = readFileSync(join(t11875MigrationDir(), 'migration.sql'), 'utf-8');
    expect(sql.length).toBeGreaterThan(0);
  });

  it('adds a nullable `display_alias` integer column', () => {
    const sql = readFileSync(join(t11875MigrationDir(), 'migration.sql'), 'utf-8');
    expect(sql).toMatch(/ADD COLUMN `display_alias` integer/);
    // No NOT NULL on the new column (must stay nullable for pass-through).
    expect(sql).not.toMatch(/ADD COLUMN `display_alias` integer NOT NULL/);
  });

  it('creates the supporting index', () => {
    const sql = readFileSync(join(t11875MigrationDir(), 'migration.sql'), 'utf-8');
    expect(sql).toContain('idx_attachments_display_alias');
  });
});

// ---------------------------------------------------------------------------
// Section 2: End-to-end migration apply on a fresh tasks.db
// ---------------------------------------------------------------------------

describe('T11875 fresh migration apply — attachments gains display_alias', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-t11875-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('applies all drizzle-tasks migrations cleanly', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const nativeDb = openNativeDatabase(join(tempDir, 'tasks.db'));
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    expect(() => migrateSanitized(db, { migrationsFolder })).not.toThrow();

    nativeDb.close();
  });

  it('attachments table has a nullable display_alias column after migration', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const nativeDb = openNativeDatabase(join(tempDir, 'tasks-cols.db'));
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    const cols = nativeDb.prepare('PRAGMA table_info(attachments)').all() as Array<{
      name: string;
      notnull: number;
    }>;
    const colMap = new Map(cols.map((c) => [c.name, c]));

    expect(colMap.has('display_alias')).toBe(true);
    // Must be nullable so existing rows pass through with NULL.
    expect(colMap.get('display_alias')?.notnull).toBe(0);

    nativeDb.close();
  });

  it('attachments table has the display_alias index after migration', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const nativeDb = openNativeDatabase(join(tempDir, 'tasks-idx.db'));
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    const indexes = nativeDb.prepare('PRAGMA index_list(attachments)').all() as Array<{
      name: string;
    }>;
    expect(indexes.map((i) => i.name)).toContain('idx_attachments_display_alias');

    nativeDb.close();
  });

  it('legacy attachment rows survive the migration with NULL display_alias', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const nativeDb = openNativeDatabase(join(tempDir, 'tasks-passthrough.db'));
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    const now = new Date().toISOString();
    nativeDb
      .prepare(
        `INSERT INTO attachments (id, sha256, attachment_json, created_at, ref_count)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('att_legacy_alias', 'a'.repeat(64), '{"kind":"note","body":"legacy"}', now, 0);

    const row = nativeDb
      .prepare('SELECT id, display_alias FROM attachments WHERE id = ?')
      .get('att_legacy_alias') as { id: string; display_alias: number | null };

    expect(row.id).toBe('att_legacy_alias');
    expect(row.display_alias).toBeNull();

    nativeDb.close();
  });
});
