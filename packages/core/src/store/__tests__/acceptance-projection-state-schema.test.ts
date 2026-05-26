/**
 * Schema parity guardrails for T10570 acceptance projection state.
 *
 * PM-Core V2 keeps typed task_acceptance_criteria rows as a projection. This
 * test locks the migration + Drizzle table shape for projection freshness,
 * dirty queueing, and projection schema-version storage.
 *
 * @saga T10538
 * @task T10570
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acceptanceProjectionDirty, acceptanceProjectionState } from '../tasks-schema.js';

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

function migrationsDir(): string {
  return join(__dirname, '..', '..', '..', 'migrations', 'drizzle-tasks');
}

function getT10570MigrationSql(): string {
  const dir = migrationsDir();
  const folder = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .find((name) => name.includes('t10570'));
  if (!folder) {
    throw new Error('T10570 migration folder not found under drizzle-tasks/');
  }
  return readFileSync(join(dir, folder, 'migration.sql'), 'utf-8');
}

describe('T10570 acceptance projection migration SQL', () => {
  it('creates projection state and dirty queue tables', () => {
    const sql = getT10570MigrationSql();
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS `acceptance_projection_state`');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS `acceptance_projection_dirty`');
  });

  it('stores schema version and freshness fields on projection_state', () => {
    const sql = getT10570MigrationSql();
    for (const col of [
      'projection_key',
      'schema_version',
      'status',
      'last_projected_at',
      'last_source_updated_at',
      'source_fingerprint',
      'created_at',
      'updated_at',
    ]) {
      expect(sql, `Missing column: ${col}`).toContain(`\`${col}\``);
    }
    expect(sql).toMatch(/`schema_version`\s+INTEGER NOT NULL/);
  });

  it('indexes freshness fields and dirty queue lookup paths', () => {
    const sql = getT10570MigrationSql();
    expect(sql).toContain('idx_acceptance_projection_state_status_freshness');
    expect(sql).toMatch(/`status`,\s*`last_source_updated_at`,\s*`last_projected_at`/);
    expect(sql).toContain('idx_acceptance_projection_dirty_task_id');
    expect(sql).toContain('idx_acceptance_projection_dirty_queued_at');
  });

  it('seeds the task_acceptance projection schema version row', () => {
    const sql = getT10570MigrationSql();
    expect(sql).toContain('INSERT OR IGNORE INTO `acceptance_projection_state`');
    expect(sql).toContain("'task_acceptance'");
  });
});

describe('T10570 Drizzle schema parity', () => {
  it('exposes projection state columns', () => {
    expect(acceptanceProjectionState.projectionKey.name).toBe('projection_key');
    expect(acceptanceProjectionState.schemaVersion.name).toBe('schema_version');
    expect(acceptanceProjectionState.status.name).toBe('status');
    expect(acceptanceProjectionState.lastProjectedAt.name).toBe('last_projected_at');
    expect(acceptanceProjectionState.lastSourceUpdatedAt.name).toBe('last_source_updated_at');
    expect(acceptanceProjectionState.sourceFingerprint.name).toBe('source_fingerprint');
    expect(acceptanceProjectionState.createdAt.name).toBe('created_at');
    expect(acceptanceProjectionState.updatedAt.name).toBe('updated_at');
  });

  it('exposes dirty queue columns', () => {
    expect(acceptanceProjectionDirty.projectionKey.name).toBe('projection_key');
    expect(acceptanceProjectionDirty.taskId.name).toBe('task_id');
    expect(acceptanceProjectionDirty.reason.name).toBe('reason');
    expect(acceptanceProjectionDirty.sourceUpdatedAt.name).toBe('source_updated_at');
    expect(acceptanceProjectionDirty.queuedAt.name).toBe('queued_at');
    expect(acceptanceProjectionDirty.payloadJson.name).toBe('payload_json');
  });
});

describe('T10570 fresh migration apply', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-t10570-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('applies all tasks migrations and creates projection tables with indexes', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const folder = migrationsDir();

    reconcileJournal(nativeDb, folder, 'tasks', 'tasks');
    expect(() => migrateSanitized(db, { migrationsFolder: folder })).not.toThrow();

    const tables = nativeDb
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'acceptance_projection_%'",
      )
      .all() as Array<{ name: string }>;
    const tableNames = new Set(tables.map((row) => row.name));
    expect(tableNames).toContain('acceptance_projection_state');
    expect(tableNames).toContain('acceptance_projection_dirty');

    const indexes = nativeDb
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_acceptance_projection_%'",
      )
      .all() as Array<{ name: string }>;
    const indexNames = new Set(indexes.map((row) => row.name));
    expect(indexNames).toContain('idx_acceptance_projection_state_status_freshness');
    expect(indexNames).toContain('idx_acceptance_projection_dirty_task_id');
    expect(indexNames).toContain('idx_acceptance_projection_dirty_queued_at');

    const state = nativeDb
      .prepare(
        'SELECT projection_key, schema_version, status FROM acceptance_projection_state WHERE projection_key = ?',
      )
      .get('task_acceptance') as
      | { projection_key: string; schema_version: number; status: string }
      | undefined;
    expect(state).toEqual({
      projection_key: 'task_acceptance',
      schema_version: 1,
      status: 'fresh',
    });

    nativeDb.close();
  });

  it('enforces one dirty row per projection/task pair', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'dirty.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const folder = migrationsDir();

    reconcileJournal(nativeDb, folder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder: folder });
    nativeDb
      .prepare(
        "INSERT INTO tasks (id, title, status, priority) VALUES ('T-proj-host', 'Projection host', 'pending', 'medium')",
      )
      .run();

    nativeDb
      .prepare(
        'INSERT INTO acceptance_projection_dirty (projection_key, task_id, reason, source_updated_at) VALUES (?, ?, ?, ?)',
      )
      .run('task_acceptance', 'T-proj-host', 'task_acceptance_changed', '2026-05-26T00:00:00.000Z');

    expect(() => {
      nativeDb
        .prepare(
          'INSERT INTO acceptance_projection_dirty (projection_key, task_id, reason, source_updated_at) VALUES (?, ?, ?, ?)',
        )
        .run('task_acceptance', 'T-proj-host', 'manual_rebuild', '2026-05-26T00:00:01.000Z');
    }).toThrow(/UNIQUE/i);

    nativeDb.close();
  });
});
