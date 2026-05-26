/**
 * Schema parity guardrails for T10571 task_relations hardening.
 *
 * PM-Core V2 keeps `tasks.parent_id` as the only containment edge. This locks
 * `task_relations` as the non-containment edge graph: row identity includes the
 * relation type, each edge may carry a reason, and source/target/type lookups
 * have explicit indexes.
 *
 * @saga T10538
 * @task T10571
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { taskRelations } from '../tasks-schema.js';

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

function migrationsDir(): string {
  return join(__dirname, '..', '..', '..', 'migrations', 'drizzle-tasks');
}

function getT10571MigrationSql(): string {
  const dir = migrationsDir();
  const folder = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .find((name) => name.includes('t10571'));
  if (!folder) {
    throw new Error('T10571 migration folder not found under drizzle-tasks/');
  }
  return readFileSync(join(dir, folder, 'migration.sql'), 'utf-8');
}

describe('T10571 task_relations migration SQL', () => {
  it('makes relation_type part of row identity', () => {
    const sql = getT10571MigrationSql();
    expect(sql).toContain(
      'CONSTRAINT `task_relations_pk` PRIMARY KEY(`task_id`, `related_to`, `relation_type`)',
    );
  });

  it('preserves reason and relation_type check semantics', () => {
    const sql = getT10571MigrationSql();
    expect(sql).toContain('`reason` text');
    expect(sql).toContain("'groups'");
    expect(sql).toContain('CHECK (`relation_type` IN');
  });

  it('adds source/type, target/type, and type lookup indexes', () => {
    const sql = getT10571MigrationSql();
    expect(sql).toContain('idx_task_relations_task_id_relation_type');
    expect(sql).toContain('idx_task_relations_related_to_relation_type');
    expect(sql).toContain('idx_task_relations_relation_type');
  });
});

describe('T10571 Drizzle schema parity', () => {
  it('exposes non-containment edge graph columns', () => {
    expect(taskRelations.taskId.name).toBe('task_id');
    expect(taskRelations.relatedTo.name).toBe('related_to');
    expect(taskRelations.relationType.name).toBe('relation_type');
    expect(taskRelations.reason.name).toBe('reason');
  });
});

describe('T10571 fresh migration apply', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-t10571-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('applies all tasks migrations with typed relation identity and indexes', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const folder = migrationsDir();

    reconcileJournal(nativeDb, folder, 'tasks', 'tasks');
    expect(() => migrateSanitized(db, { migrationsFolder: folder })).not.toThrow();

    const pkColumns = nativeDb.prepare('PRAGMA table_info(task_relations)').all() as Array<{
      name: string;
      pk: number;
    }>;
    expect(
      pkColumns
        .filter((row) => row.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((row) => row.name),
    ).toEqual(['task_id', 'related_to', 'relation_type']);

    const indexes = nativeDb.prepare('PRAGMA index_list(task_relations)').all() as Array<{
      name: string;
    }>;
    const indexNames = new Set(indexes.map((row) => row.name));
    expect(indexNames).toContain('idx_task_relations_task_id_relation_type');
    expect(indexNames).toContain('idx_task_relations_related_to_relation_type');
    expect(indexNames).toContain('idx_task_relations_relation_type');

    nativeDb
      .prepare(
        "INSERT INTO tasks (id, title, status, priority) VALUES ('T-src', 'Source', 'pending', 'medium')",
      )
      .run();
    nativeDb
      .prepare(
        "INSERT INTO tasks (id, title, status, priority) VALUES ('T-dst', 'Target', 'pending', 'medium')",
      )
      .run();

    nativeDb
      .prepare(
        'INSERT INTO task_relations (task_id, related_to, relation_type, reason) VALUES (?, ?, ?, ?)',
      )
      .run('T-src', 'T-dst', 'related', 'cross-reference');
    nativeDb
      .prepare(
        'INSERT INTO task_relations (task_id, related_to, relation_type, reason) VALUES (?, ?, ?, ?)',
      )
      .run('T-src', 'T-dst', 'supersedes', 'non-containment ordering edge');

    expect(() => {
      nativeDb
        .prepare(
          'INSERT INTO task_relations (task_id, related_to, relation_type, reason) VALUES (?, ?, ?, ?)',
        )
        .run('T-src', 'T-dst', 'related', 'duplicate relation type');
    }).toThrow(/UNIQUE/i);

    const reasons = nativeDb
      .prepare('SELECT relation_type, reason FROM task_relations ORDER BY relation_type')
      .all() as Array<{ relation_type: string; reason: string }>;
    expect(reasons).toEqual([
      { relation_type: 'related', reason: 'cross-reference' },
      { relation_type: 'supersedes', reason: 'non-containment ordering edge' },
    ]);

    nativeDb.close();
  });
});
