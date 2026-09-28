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
const T12470 = '20260928010000_t12470-location-candidates';

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
    // The pre-T12470 CHECK rejects the new state.
    expect(() => insert.run('p3', 'dev', '/c', '2026-01-01', '2026-01-01', 'candidate')).toThrow();

    applyMigration(db, T12470);

    const after = db
      .prepare(
        'SELECT project_id, device_id, path, first_seen, last_seen, state, checkout_nonce, git_root_commit, git_remote FROM nexus_project_locations ORDER BY project_id, path',
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
        checkout_nonce: null,
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

/**
 * H1 regression: a store that a MAIN build already migrated through T12469
 * (every existing home) must RUN this migration, not have the journal
 * reconciler mark it applied because `nexus_project_locations` exists.
 * Exercised through the real open path, not by executing SQL directly.
 */
describe('T12470 migration on a store main already migrated (real migrator)', () => {
  const T12469_LOCATIONS = `CREATE TABLE \`nexus_project_locations_main\` (
    \`project_id\` text NOT NULL, \`device_id\` text NOT NULL, \`path\` text NOT NULL,
    \`first_seen\` text NOT NULL DEFAULT (datetime('now')),
    \`last_seen\` text NOT NULL DEFAULT (datetime('now')),
    \`state\` text NOT NULL DEFAULT 'live',
    PRIMARY KEY (\`project_id\`, \`device_id\`, \`path\`),
    CHECK ("state" IN ('live', 'missing', 'superseded')))`;

  it('adds the columns and the candidate state, then registration works', async () => {
    const { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { execFileSync } = await import('node:child_process');
    const { vi } = await import('vitest');
    const { _resetDualScopeDbCache, openDualScopeDbAtPath } = await import('../dual-scope-db.js');
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-t12470-migrate-')));
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    const dbPath = join(home, 'cleo.db');
    vi.stubEnv('CLEO_HOME', home);
    vi.stubEnv('CLEO_DISABLE_PROJECT_AUTOREGISTER', '1');
    try {
      // 1. A current open, then roll the store back to exactly what a main
      //    build leaves: T12469's table shape, no T12470 journal entry.
      await openDualScopeDbAtPath('global', dbPath);
      _resetDualScopeDbCache();
      const Ctor = getDbSyncConstructor();
      const raw = new Ctor(dbPath);
      raw.exec(T12469_LOCATIONS);
      raw.exec(
        "INSERT INTO nexus_project_locations_main (project_id, device_id, path, first_seen, last_seen, state) VALUES ('kept', 'local', '/kept', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'live')",
      );
      raw.exec('DROP TABLE nexus_project_locations');
      raw.exec('ALTER TABLE nexus_project_locations_main RENAME TO nexus_project_locations');
      raw.exec(
        'CREATE INDEX idx_nexus_project_locations_device_path ON nexus_project_locations (device_id, path)',
      );
      raw.exec("DELETE FROM __drizzle_migrations WHERE name LIKE '%t12470%'");
      const columnsBefore = (
        raw.prepare('PRAGMA table_info(nexus_project_locations)').all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(columnsBefore).not.toContain('checkout_nonce');
      raw.close();

      // 2. Reopen through the real migrator (journal reconcile + migrate).
      await openDualScopeDbAtPath('global', dbPath);
      _resetDualScopeDbCache();
      const check = new Ctor(dbPath, { readOnly: true });
      const columns = (
        check.prepare('PRAGMA table_info(nexus_project_locations)').all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(columns).toEqual(
        expect.arrayContaining(['checkout_nonce', 'git_root_commit', 'git_remote']),
      );
      const ddl = (
        check
          .prepare("SELECT sql FROM sqlite_master WHERE name = 'nexus_project_locations'")
          .get() as { sql: string }
      ).sql;
      expect(ddl).toContain("'candidate'");
      expect(
        check.prepare("SELECT project_id FROM nexus_project_locations WHERE path = '/kept'").get(),
      ).toEqual({ project_id: 'kept' });
      expect(
        check
          .prepare("SELECT count(*) AS n FROM __drizzle_migrations WHERE name LIKE '%t12470%'")
          .get(),
      ).toEqual({ n: 1 });
      check.close();

      // 3. Registration — which reads and writes the new columns — succeeds.
      const project = join(root, 'project');
      mkdirSync(join(project, '.cleo'), { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: project, stdio: 'ignore' });
      writeFileSync(
        join(project, '.cleo', 'project-info.json'),
        JSON.stringify({ projectId: 'migrated-T12470' }),
      );
      const { nexusRegister, resetNexusDbState } = await import('../../nexus/registry.js');
      resetNexusDbState();
      await nexusRegister(project, 'migrated');
      resetNexusDbState();
      _resetDualScopeDbCache();
      const after = new Ctor(dbPath, { readOnly: true });
      const location = after
        .prepare(
          "SELECT state, checkout_nonce FROM nexus_project_locations WHERE project_id = 'migrated-T12470'",
        )
        .get() as { state: string; checkout_nonce: string | null };
      after.close();
      expect(location.state).toBe('live');
      expect(location.checkout_nonce).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      _resetDualScopeDbCache();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
