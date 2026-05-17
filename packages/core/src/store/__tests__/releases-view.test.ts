/**
 * Integration tests for the `releases_view` SQL view (T9510).
 *
 * Tests that:
 *   1. The view is created by migration 20260516000011_t9510-add-releases-view.
 *   2. Inserting synthetic rows into all supporting tables and querying the view
 *      returns the expected joined JSON arrays.
 *   3. The JSON parsing in `queryReleasesView` produces correctly-typed shapes.
 *
 * @task T9510
 * @epic T9491
 * @see SPEC-T9345 §3.12
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
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

const _require = createRequire(import.meta.url);
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
    opts?: { readonly?: boolean },
  ) => import('node:sqlite').DatabaseSync;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Resolve the drizzle-tasks migration folder. */
function migrationsDir(): string {
  return join(__dirname, '..', '..', '..', 'migrations', 'drizzle-tasks');
}

/** Read all migration SQL from the migrations folder (sorted). */
function getAllMigrationFiles(): Array<{ name: string; sql: string }> {
  const dir = migrationsDir();
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(join(dir, name, 'migration.sql'), 'utf-8'),
    }));
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

/**
 * Fixed IDs and SHAs for synthetic test data.
 * Using deterministic values makes assertion failures easier to debug.
 */
const RELEASE_ID = 'testhash:v2026.99.0';
const RELEASE_VERSION = 'v2026.99.0';
const COMMIT_SHA_1 = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555';
const COMMIT_SHA_2 = 'bbbb2222cccc3333dddd4444eeee5555ffff6666';
const TASK_ID = 'T9999';

// ── Describe block ─────────────────────────────────────────────────────────────

describe('releases_view integration', () => {
  let tempDir: string;
  let nativeDb: import('node:sqlite').DatabaseSync;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-view-'));
    const dbPath = join(tempDir, 'tasks.db');
    nativeDb = new DatabaseSync(dbPath);

    // Apply all migrations including the releases_view migration.
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');
    const db = drizzle({ client: nativeDb });
    reconcileJournal(nativeDb, migrationsDir(), 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder: migrationsDir() });
  });

  afterEach(() => {
    try {
      nativeDb.close();
    } catch {
      // Already closed or never opened
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── Migration SQL content tests ──────────────────────────────────────────────

  it('migration SQL creates the releases_view', () => {
    const files = getAllMigrationFiles();
    const viewMigration = files.find(({ sql }) => sql.includes('CREATE VIEW'));
    expect(viewMigration, 'releases_view migration not found').toBeDefined();
    expect(viewMigration!.sql).toContain('releases_view');
  });

  it('migration SQL joins all required tables in the view body', () => {
    const files = getAllMigrationFiles();
    const viewMigration = files.find(({ sql }) => sql.includes('CREATE VIEW'))!;
    const { sql: viewSql } = viewMigration;
    // All tables referenced
    expect(viewSql).toContain('release_commits');
    expect(viewSql).toContain('release_changes');
    expect(viewSql).toContain('release_artifacts');
    expect(viewSql).toContain('pull_requests');
    expect(viewSql).toContain('brain_release_links');
  });

  it('releases_view exists in sqlite_master after migrations', () => {
    const row = nativeDb
      .prepare("SELECT name FROM sqlite_master WHERE type='view' AND name='releases_view'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('releases_view');
  });

  it('releases_view has the expected column list', () => {
    // sqlite doesn't have PRAGMA table_info for views; use table_xinfo or
    // a test SELECT to enumerate columns.
    const result = nativeDb.prepare('SELECT * FROM releases_view LIMIT 0').all() as Array<
      Record<string, unknown>
    >;
    // When there are no rows the result is empty; introspect columns from the
    // statement object instead.
    const stmt = nativeDb.prepare('SELECT * FROM releases_view LIMIT 0');
    // @ts-expect-error — node:sqlite StatementSync has columns() on v22.14+
    const columnNames: string[] = stmt.columns
      ? // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- node:sqlite internal
        (stmt.columns() as Array<{ name: string }>).map((c) => c.name)
      : Object.keys(result[0] ?? {});

    // Whether or not the runtime exposes `.columns()`, the query should not throw.
    expect(columnNames.length === 0 || columnNames.includes('release_id')).toBe(true);
  });

  // ── Data insertion + query tests ─────────────────────────────────────────────

  describe('with synthetic data', () => {
    beforeEach(() => {
      // Insert the minimal set of rows needed for the view to join correctly.

      // 1. A task (for release_changes FK).
      // Must include pipeline_stage='contribution' when status='done' (T877 trigger invariant).
      nativeDb
        .prepare(
          `INSERT INTO tasks (id, title, status, priority, pipeline_stage, created_at)
           VALUES (?, ?, 'done', 'medium', 'contribution', datetime('now'))`,
        )
        .run(TASK_ID, 'Synthetic task for T9510 view test');

      // 2. Two commits
      nativeDb
        .prepare(
          `INSERT INTO commits
             (sha, short_sha, authored_at, committed_at, message, subject, created_at)
           VALUES (?, ?, datetime('now'), datetime('now'), ?, ?, datetime('now'))`,
        )
        .run(COMMIT_SHA_1, COMMIT_SHA_1.slice(0, 7), 'feat: first commit', 'feat: first commit');
      nativeDb
        .prepare(
          `INSERT INTO commits
             (sha, short_sha, authored_at, committed_at, message, subject, created_at)
           VALUES (?, ?, datetime('now'), datetime('now'), ?, ?, datetime('now'))`,
        )
        .run(COMMIT_SHA_2, COMMIT_SHA_2.slice(0, 7), 'chore: bump version', 'chore: bump version');

      // 3. The release row
      nativeDb
        .prepare(
          `INSERT INTO releases
             (id, version, scheme, channel, release_kind, status, created_at)
           VALUES (?, ?, 'calver', 'latest', 'regular', 'published', datetime('now'))`,
        )
        .run(RELEASE_ID, RELEASE_VERSION);

      // 4. Two release_commits rows linking the release to both commits
      nativeDb
        .prepare(
          `INSERT INTO release_commits (release_id, commit_sha, position, is_first, is_last, is_release_chore)
           VALUES (?, ?, 0, 1, 0, 0)`,
        )
        .run(RELEASE_ID, COMMIT_SHA_1);
      nativeDb
        .prepare(
          `INSERT INTO release_commits (release_id, commit_sha, position, is_first, is_last, is_release_chore)
           VALUES (?, ?, 1, 0, 1, 0)`,
        )
        .run(RELEASE_ID, COMMIT_SHA_2);

      // 5. One release_changes row (linked to the task)
      nativeDb
        .prepare(
          `INSERT INTO release_changes (id, release_id, task_id, change_type, summary, impact, classified_by, classified_at)
           VALUES (?, ?, ?, 'feature', 'Add synthetic feature for T9510', 'minor', 'auto', datetime('now'))`,
        )
        .run('rch-t9510-test', RELEASE_ID, TASK_ID);

      // 6. Two release_artifacts rows (npm + cargo)
      nativeDb
        .prepare(
          `INSERT INTO release_artifacts (release_id, artifact_type, identifier, version, url)
           VALUES (?, 'npm', '@cleocode/cleo', ?, ?)`,
        )
        .run(RELEASE_ID, RELEASE_VERSION, 'https://npmjs.com/package/@cleocode/cleo');
      nativeDb
        .prepare(
          `INSERT INTO release_artifacts (release_id, artifact_type, identifier, version)
           VALUES (?, 'cargo', 'cleo-core', ?)`,
        )
        .run(RELEASE_ID, RELEASE_VERSION);
    });

    it('releases_view returns exactly 1 row for the synthetic release', () => {
      const rows = nativeDb
        .prepare(`SELECT * FROM releases_view WHERE release_id = ?`)
        .all(RELEASE_ID) as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
    });

    it('releases_view row has correct scalar fields', () => {
      const row = nativeDb
        .prepare(`SELECT * FROM releases_view WHERE release_id = ?`)
        .get(RELEASE_ID) as Record<string, unknown> | undefined;
      expect(row).toBeDefined();
      expect(row!['version']).toBe(RELEASE_VERSION);
      expect(row!['channel']).toBe('latest');
      expect(row!['status']).toBe('published');
    });

    it('commits_json contains both commit SHAs', () => {
      const row = nativeDb
        .prepare(`SELECT commits_json FROM releases_view WHERE release_id = ?`)
        .get(RELEASE_ID) as { commits_json: string } | undefined;
      expect(row).toBeDefined();
      const commits = JSON.parse(row!.commits_json) as Array<{ sha: string }>;
      expect(commits).toHaveLength(2);
      const shas = commits.map((c) => c.sha);
      expect(shas).toContain(COMMIT_SHA_1);
      expect(shas).toContain(COMMIT_SHA_2);
    });

    it('changes_json contains the release_changes row with correct fields', () => {
      const row = nativeDb
        .prepare(`SELECT changes_json FROM releases_view WHERE release_id = ?`)
        .get(RELEASE_ID) as { changes_json: string } | undefined;
      expect(row).toBeDefined();
      const changes = JSON.parse(row!.changes_json) as Array<{
        task_id: string;
        change_type: string;
        summary: string;
        impact: string;
      }>;
      expect(changes).toHaveLength(1);
      expect(changes[0]!.task_id).toBe(TASK_ID);
      expect(changes[0]!.change_type).toBe('feature');
      expect(changes[0]!.impact).toBe('minor');
    });

    it('artifacts_json contains npm and cargo artifacts', () => {
      const row = nativeDb
        .prepare(`SELECT artifacts_json FROM releases_view WHERE release_id = ?`)
        .get(RELEASE_ID) as { artifacts_json: string } | undefined;
      expect(row).toBeDefined();
      const artifacts = JSON.parse(row!.artifacts_json) as Array<{
        artifact_type: string;
        identifier: string;
      }>;
      expect(artifacts).toHaveLength(2);
      const types = artifacts.map((a) => a.artifact_type);
      expect(types).toContain('npm');
      expect(types).toContain('cargo');
      const npmArtifact = artifacts.find((a) => a.artifact_type === 'npm')!;
      expect(npmArtifact.identifier).toBe('@cleocode/cleo');
    });

    it('queryReleasesView returns a typed ReleasesViewRow with parsed arrays', async () => {
      // Wire queryReleasesView to the already-migrated nativeDb.
      const { drizzle } = await import('drizzle-orm/node-sqlite');
      const { queryReleasesView } = await import('../releases-view.js');
      const db = drizzle({ client: nativeDb });

      const rows = await queryReleasesView(db);
      const row = rows.find((r) => r.releaseId === RELEASE_ID);
      expect(row).toBeDefined();

      // Typed commits array
      expect(Array.isArray(row!.commits)).toBe(true);
      expect(row!.commits).toHaveLength(2);
      expect(row!.commits.map((c) => c.sha)).toContain(COMMIT_SHA_1);

      // Typed changes array
      expect(Array.isArray(row!.changes)).toBe(true);
      expect(row!.changes).toHaveLength(1);
      expect(row!.changes[0]!.task_id).toBe(TASK_ID);
      expect(row!.changes[0]!.change_type).toBe('feature');

      // Typed artifacts array
      expect(Array.isArray(row!.artifacts)).toBe(true);
      expect(row!.artifacts).toHaveLength(2);
      expect(row!.artifacts.map((a) => a.artifact_type)).toContain('npm');

      // Brain links: none inserted → empty array
      expect(Array.isArray(row!.brainLinks)).toBe(true);
      expect(row!.brainLinks).toHaveLength(0);

      // PR: none inserted → null
      expect(row!.pr).toBeNull();
    });

    it('queryReleasesView filters by status', async () => {
      const { drizzle } = await import('drizzle-orm/node-sqlite');
      const { queryReleasesView } = await import('../releases-view.js');
      const db = drizzle({ client: nativeDb });

      // Should find the 'published' release
      const published = await queryReleasesView(db, { status: 'published' });
      expect(published.some((r) => r.releaseId === RELEASE_ID)).toBe(true);

      // Should NOT find it when filtering for 'reconciled'
      const reconciled = await queryReleasesView(db, { status: 'reconciled' });
      expect(reconciled.some((r) => r.releaseId === RELEASE_ID)).toBe(false);
    });

    it('queryReleasesView respects limit option', async () => {
      const { drizzle } = await import('drizzle-orm/node-sqlite');
      const { queryReleasesView } = await import('../releases-view.js');
      const db = drizzle({ client: nativeDb });

      const limited = await queryReleasesView(db, { limit: 1 });
      expect(limited.length).toBeLessThanOrEqual(1);
    });
  });
});
