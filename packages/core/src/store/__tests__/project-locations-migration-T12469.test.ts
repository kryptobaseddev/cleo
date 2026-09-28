/**
 * T12469 migration — the registry is rebuilt without UNIQUE on any path or
 * path hash, and `nexus_project_locations` is created and backfilled.
 *
 * Builds an in-memory global store from every cleo-global migration BEFORE
 * T12469, seeds registry, alias and path-map rows (including values the new
 * CHECKs would reject), applies the T12469 migration, and proves every
 * existing registry row and alias survives byte-for-byte.
 *
 * @task T12469
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDbSyncConstructor } from '../sqlite-native.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GLOBAL_DIR = join(__dirname, '..', '..', '..', 'migrations', 'drizzle-cleo-global');
const T12469 = '20260927000000_t12469-project-locations';

/** Execute one migration body the way `migrateSanitized` does. */
function applyMigration(db: DatabaseSync, folder: string): void {
  const body = readFileSync(join(GLOBAL_DIR, folder, 'migration.sql'), 'utf8');
  for (const chunk of body.split('--> statement-breakpoint')) {
    const executable = chunk
      .replace(/--[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim();
    if (executable !== '') db.exec(chunk);
  }
}

/** Every migration folder, in the order the runtime applies them. */
function folders(): string[] {
  return readdirSync(GLOBAL_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

type Row = Record<string, unknown>;

let db: DatabaseSync;

beforeEach(() => {
  const Ctor = getDbSyncConstructor();
  db = new Ctor(':memory:');
  const all = folders();
  expect(all).toContain(T12469);
  for (const folder of all) {
    if (folder === T12469) break;
    applyMigration(db, folder);
  }
});

afterEach(() => {
  db.close();
});

/** Seed the pre-T12469 shape with rows the migration must carry over. */
function seed(): void {
  const insert = db.prepare(
    `INSERT INTO nexus_project_registry
       (project_id, project_hash, project_path, name, registered_at, last_seen,
        health_status, health_last_check, permissions, last_sync, task_count,
        labels_json, brain_db_path, tasks_db_path, last_indexed, stats_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(
    'proj-a',
    'hash-a',
    '/work/a',
    'a',
    '2026-01-01T00:00:00.000Z',
    '2026-02-01T00:00:00.000Z',
    'healthy',
    '2026-02-01T00:00:00.000Z',
    'write',
    '2026-02-01T00:00:00.000Z',
    7,
    '["x"]',
    '/work/a/.cleo/brain.db',
    '/work/a/.cleo/tasks.db',
    '2026-02-02T00:00:00.000Z',
    '{"nodeCount":3}',
  );
  // A last_seen the locations CHECK rejects: the location must still be kept.
  insert.run(
    'proj-b',
    'hash-b',
    '/work/b',
    'b',
    '2026-01-03T00:00:00.000Z',
    'not-a-date',
    'unknown',
    null,
    'read',
    '2026-01-03T00:00:00.000Z',
    0,
    '[]',
    null,
    null,
    null,
    '{}',
  );
  const alias = db.prepare(
    'INSERT INTO nexus_project_id_aliases (legacy_id, canonical_id, created_at) VALUES (?, ?, ?)',
  );
  alias.run('L3dvcmsvYQ', 'proj-a', '2026-01-01T00:00:00.000Z');
  alias.run('legacy-b', 'proj-b', '2026-01-03T00:00:00.000Z');
  // The T12354 backfill already mirrored the registry; add a second checkout.
  db.prepare(
    `INSERT INTO nexus_project_paths (project_path, project_id, project_hash, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    '/work/a-copy',
    'proj-a',
    'hash-a2',
    '2026-01-05T00:00:00.000Z',
    '2026-01-06T00:00:00.000Z',
  );
}

const all = (sql: string): Row[] => db.prepare(sql).all() as Row[];

describe('T12469 migration', () => {
  it('preserves every registry row and alias exactly', () => {
    seed();
    const registryBefore = all('SELECT * FROM nexus_project_registry ORDER BY project_id');
    const aliasesBefore = all('SELECT * FROM nexus_project_id_aliases ORDER BY legacy_id');
    const pathsBefore = all('SELECT * FROM nexus_project_paths ORDER BY project_path');
    expect(registryBefore).toHaveLength(2);

    applyMigration(db, T12469);

    expect(all('SELECT * FROM nexus_project_registry ORDER BY project_id')).toEqual(registryBefore);
    expect(all('SELECT * FROM nexus_project_id_aliases ORDER BY legacy_id')).toEqual(aliasesBefore);
    expect(all('SELECT * FROM nexus_project_paths ORDER BY project_path')).toEqual(pathsBefore);
  });

  it('backfills one live location per known checkout, none dropped', () => {
    seed();
    applyMigration(db, T12469);
    const locations = all(
      'SELECT project_id, device_id, path, state FROM nexus_project_locations ORDER BY path',
    );
    expect(locations).toEqual([
      { project_id: 'proj-a', device_id: 'local', path: '/work/a', state: 'live' },
      { project_id: 'proj-a', device_id: 'local', path: '/work/a-copy', state: 'live' },
      { project_id: 'proj-b', device_id: 'local', path: '/work/b', state: 'live' },
    ]);
    const b = db
      .prepare('SELECT first_seen, last_seen FROM nexus_project_locations WHERE project_id = ?')
      .get('proj-b') as Row;
    expect(b['first_seen']).toBe('2026-01-03T00:00:00.000Z');
    expect(String(b['last_seen'])).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it('leaves no UNIQUE constraint on any path or path hash', () => {
    applyMigration(db, T12469);
    const uniqueIndexes = (
      all("PRAGMA index_list('nexus_project_registry')") as Array<{
        name: string;
        unique: number;
        origin: string;
      }>
    ).filter((i) => i.unique === 1);
    // Only the primary key may be unique.
    expect(uniqueIndexes.every((i) => i.origin === 'pk')).toBe(true);

    const insert = db.prepare(
      'INSERT INTO nexus_project_registry (project_id, project_hash, project_path, name) VALUES (?, ?, ?, ?)',
    );
    insert.run('one', 'same-hash', '/same/path', 'one');
    expect(() => insert.run('two', 'same-hash', '/same/path', 'two')).not.toThrow();
    expect(() => insert.run('one', 'other', '/other', 'dup')).toThrow(/UNIQUE|PRIMARY/);
  });

  it('keys locations by (project_id, device_id, path) and rejects unknown states', () => {
    applyMigration(db, T12469);
    const insert = db.prepare(
      'INSERT INTO nexus_project_locations (project_id, device_id, path, state) VALUES (?, ?, ?, ?)',
    );
    insert.run('p', 'dev-1', '/x', 'live');
    insert.run('p', 'dev-2', '/x', 'live');
    insert.run('q', 'dev-1', '/x', 'superseded');
    expect(() => insert.run('p', 'dev-1', '/x', 'missing')).toThrow(/UNIQUE|PRIMARY/);
    expect(() => insert.run('p', 'dev-1', '/y', 'deleted')).toThrow(/CHECK/);
  });
});
