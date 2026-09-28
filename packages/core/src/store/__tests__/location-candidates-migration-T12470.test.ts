/**
 * T12470 migration — `nexus_project_locations` gains the `candidate` state and
 * the `git_root_commit` / `git_remote` evidence columns.
 *
 * Applies every cleo-global migration before T12470, seeds location rows in
 * every pre-existing state, applies the T12470 migration, and proves each row
 * survives unchanged with NULL evidence, and that `candidate` is now accepted.
 *
 * @task T12470
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDbSyncConstructor } from '../sqlite-native.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GLOBAL_DIR = join(__dirname, '..', '..', '..', 'migrations', 'drizzle-cleo-global');
const T12470 = '20260928000000_t12470-location-candidates';

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

let db: DatabaseSync;

beforeEach(() => {
  const Ctor = getDbSyncConstructor();
  db = new Ctor(':memory:');
  const all = readdirSync(GLOBAL_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  expect(all).toContain(T12470);
  for (const folder of all) {
    if (folder === T12470) break;
    applyMigration(db, folder);
  }
});

afterEach(() => {
  db.close();
});

describe('T12470 location-candidates migration', () => {
  it('keeps every location row and accepts the candidate state', () => {
    const insert = db.prepare(
      `INSERT INTO nexus_project_locations
         (project_id, device_id, path, first_seen, last_seen, state)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const rows = [
      ['p1', 'dev', '/a', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', 'live'],
      ['p1', 'dev', '/b', '2026-01-02T00:00:00.000Z', '2026-02-02T00:00:00.000Z', 'missing'],
      ['p2', 'local', '/a', '2026-01-03T00:00:00.000Z', '2026-02-03T00:00:00.000Z', 'superseded'],
    ] as const;
    for (const row of rows) insert.run(...row);
    expect(() => insert.run('p3', 'dev', '/c', '2026-01-01', '2026-01-01', 'candidate')).toThrow();

    applyMigration(db, T12470);

    const after = db
      .prepare(
        'SELECT project_id, device_id, path, first_seen, last_seen, state, git_root_commit, git_remote FROM nexus_project_locations ORDER BY project_id, path',
      )
      .all();
    expect(after).toEqual(
      rows.map(([project_id, device_id, path, first_seen, last_seen, state]) => ({
        project_id,
        device_id,
        path,
        first_seen,
        last_seen,
        state,
        git_root_commit: null,
        git_remote: null,
      })),
    );
    insert.run('p3', 'dev', '/c', '2026-01-01', '2026-01-01', 'candidate');
    expect(() => insert.run('p4', 'dev', '/d', '2026-01-01', '2026-01-01', 'bogus')).toThrow();
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'nexus_project_locations'",
      )
      .all()
      .map((r) => (r as { name: string }).name);
    expect(indexes).toContain('idx_nexus_project_locations_device_path');
  });
});
