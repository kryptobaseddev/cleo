/**
 * T9756 (T9738-D / A4) — uniform releases.id PK migration regression lock.
 *
 * Validates the invariants of the
 * `20260520163500_t9756-uniform-releases-pk` migration:
 *
 *   1. After B2 (the predecessor migration) is applied, legacy rows carry
 *      the `legacy:<version>` PK shape.
 *   2. After T9756 is applied, the SAME rows carry the uniform
 *      `<projectHash>:<version>` shape — version preserved, only the prefix
 *      flips.
 *   3. FK references in the four dependent tables (`release_commits`,
 *      `release_changes`, `release_artifacts`, `brain_release_links`) are
 *      rewritten in lockstep with the parent PK.
 *   4. Re-applying the migration is a no-op — already-uniform rows are not
 *      double-prefixed (`projectHash:projectHash:<version>` must NOT occur).
 *   5. Revert flips uniform-shape rows back to `legacy:<version>`.
 *
 * The hard-coded project hash baked into the forward migration is the
 * canonical hash for `/mnt/projects/cleocode` (`1e3146b7352b`) — see the
 * migration header for the multi-project caveat.
 *
 * @task T9756
 * @epic T9752
 */

import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
  DatabaseSync: new (path: string) => import('node:sqlite').DatabaseSync;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Canonical hash of `/mnt/projects/cleocode` baked into the T9756 migration. */
const CLEOCODE_PROJECT_HASH = '1e3146b7352b';

function migrationsDir(): string {
  return join(__dirname, '..', '..', '..', 'migrations', 'drizzle-tasks');
}

/**
 * Materialize the post-B2 schema by hand: the unified `releases` table
 * (with all legacy columns merged in) plus the four dependent junction
 * tables. We intentionally elide the unrelated tables — the T9756
 * migration only touches these five.
 *
 * @internal
 */
function applyPostB2Schema(dbPath: string): import('node:sqlite').DatabaseSync {
  const nativeDb = new DatabaseSync(dbPath);
  nativeDb.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY);
    CREATE TABLE commits (sha TEXT PRIMARY KEY, subject TEXT);
    CREATE TABLE pull_requests (id TEXT PRIMARY KEY);
    CREATE TABLE brain_entries (id TEXT PRIMARY KEY);

    -- Post-B2 unified \`releases\` shape (matches the table that T9686-B2
    -- leaves behind, with the merge_commit_sha FK already dropped).
    CREATE TABLE releases (
      id                TEXT PRIMARY KEY NOT NULL,
      version           TEXT NOT NULL UNIQUE,
      scheme            TEXT NOT NULL DEFAULT 'calver',
      channel           TEXT NOT NULL DEFAULT 'latest',
      epic_id           TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      release_kind      TEXT NOT NULL DEFAULT 'regular',
      status            TEXT NOT NULL DEFAULT 'planned',
      previous_version  TEXT,
      merge_commit_sha  TEXT,
      pr_id             TEXT REFERENCES pull_requests(id) ON DELETE SET NULL,
      workflow_run_url  TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      planned_at        TEXT,
      pr_opened_at      TEXT,
      pr_merged_at      TEXT,
      published_at      TEXT,
      reconciled_at     TEXT,
      rolled_back_at    TEXT,
      failed_at         TEXT,
      cancelled_at      TEXT,
      failure_reason    TEXT,
      rolled_back_by    TEXT,
      project_hash      TEXT,
      tasks_json        TEXT,
      changelog         TEXT,
      notes             TEXT,
      git_tag           TEXT,
      prepared_at       TEXT,
      committed_at      TEXT,
      tagged_at         TEXT,
      pushed_at         TEXT
    );

    -- Dependent tables — minimal columns + FK to releases(id).
    CREATE TABLE release_commits (
      release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
      commit_sha TEXT NOT NULL REFERENCES commits(sha) ON DELETE CASCADE,
      position   INTEGER NOT NULL,
      PRIMARY KEY (release_id, commit_sha)
    );

    CREATE TABLE release_changes (
      id         TEXT PRIMARY KEY NOT NULL,
      release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE
    );

    CREATE TABLE release_artifacts (
      release_id    TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
      artifact_type TEXT NOT NULL,
      identifier    TEXT NOT NULL,
      PRIMARY KEY (release_id, artifact_type, identifier)
    );

    CREATE TABLE brain_release_links (
      brain_entry_id TEXT NOT NULL REFERENCES brain_entries(id) ON DELETE CASCADE,
      release_id     TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
      link_type      TEXT NOT NULL,
      PRIMARY KEY (brain_entry_id, release_id, link_type)
    );
  `);
  return nativeDb;
}

/**
 * Apply the T9756 forward migration to an already-post-B2-seeded DB.
 *
 * @internal
 */
function applyT9756Migration(nativeDb: import('node:sqlite').DatabaseSync): void {
  const sqlPath = join(
    migrationsDir(),
    '20260520163500_t9756-uniform-releases-pk',
    'migration.sql',
  );
  const sql = execSync(`cat ${sqlPath}`, { encoding: 'utf-8' });
  const statements = sql.split('--> statement-breakpoint');
  for (const stmt of statements) {
    const trimmed = stmt.trim();
    if (!trimmed) continue;
    nativeDb.exec(trimmed);
  }
}

/**
 * Apply the T9756 revert migration.
 *
 * @internal
 */
function applyT9756Revert(nativeDb: import('node:sqlite').DatabaseSync): void {
  const sqlPath = join(migrationsDir(), '20260520163500_t9756-uniform-releases-pk', 'revert.sql');
  const sql = execSync(`cat ${sqlPath}`, { encoding: 'utf-8' });
  const statements = sql.split('--> statement-breakpoint');
  for (const stmt of statements) {
    const trimmed = stmt.trim();
    if (!trimmed) continue;
    nativeDb.exec(trimmed);
  }
}

describe('T9756 uniform releases.id PK migration', () => {
  let tempDir: string;
  let nativeDb: import('node:sqlite').DatabaseSync;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-t9756-mig-'));
    nativeDb = applyPostB2Schema(join(tempDir, 'tasks.db'));
  });

  afterEach(() => {
    try {
      nativeDb.close();
    } catch {
      // already closed
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('rewrites legacy:<version> PKs to <projectHash>:<version> shape', () => {
    nativeDb.exec(`
      INSERT INTO releases (id, version, status, tasks_json, created_at, prepared_at)
      VALUES
        ('legacy:v1.0.0',     'v1.0.0',     'prepared', '["T100"]',          '2026-01-01', '2026-01-01'),
        ('legacy:v2026.5.73', 'v2026.5.73', 'pushed',   '["T9000","T9001"]', '2026-05-15', '2026-05-15');
    `);

    applyT9756Migration(nativeDb);

    const rows = nativeDb
      .prepare('SELECT id, version FROM releases ORDER BY version')
      .all() as Array<{ id: string; version: string }>;

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      id: `${CLEOCODE_PROJECT_HASH}:v1.0.0`,
      version: 'v1.0.0',
    });
    expect(rows[1]).toEqual({
      id: `${CLEOCODE_PROJECT_HASH}:v2026.5.73`,
      version: 'v2026.5.73',
    });
  });

  it('preserves new-pipeline rows (does not double-prefix them)', () => {
    // New-pipeline rows already use the uniform shape — they must be left
    // untouched by the LIKE 'legacy:%' guard.
    nativeDb.exec(`
      INSERT INTO releases (id, version, status, created_at)
      VALUES
        ('legacy:v1.0.0',       'v1.0.0',       'pushed',    '2026-01-01'),
        ('aaaaaaaaaaaa:v2026.6.0', 'v2026.6.0', 'planned',   '2026-06-01'),
        ('bbbbbbbbbbbb:v2026.6.1', 'v2026.6.1', 'reconciled', '2026-06-02');
    `);

    applyT9756Migration(nativeDb);

    const rows = nativeDb.prepare('SELECT id FROM releases ORDER BY version').all() as Array<{
      id: string;
    }>;

    // The legacy row was rewritten; the two new-pipeline rows were not.
    expect(rows.map((r) => r.id)).toEqual([
      `${CLEOCODE_PROJECT_HASH}:v1.0.0`,
      'aaaaaaaaaaaa:v2026.6.0',
      'bbbbbbbbbbbb:v2026.6.1',
    ]);
  });

  it('updates FK references in all four dependent tables', () => {
    // Seed parent + a row in each dependent table.
    nativeDb.exec(`
      INSERT INTO commits (sha) VALUES ('abc123');
      INSERT INTO brain_entries (id) VALUES ('B-001');

      INSERT INTO releases (id, version, status, created_at)
      VALUES ('legacy:v1.0.0', 'v1.0.0', 'pushed', '2026-01-01');

      INSERT INTO release_commits (release_id, commit_sha, position)
      VALUES ('legacy:v1.0.0', 'abc123', 0);

      INSERT INTO release_changes (id, release_id)
      VALUES ('chg-1', 'legacy:v1.0.0');

      INSERT INTO release_artifacts (release_id, artifact_type, identifier)
      VALUES ('legacy:v1.0.0', 'npm', '@cleocode/cleo@v1.0.0');

      INSERT INTO brain_release_links (brain_entry_id, release_id, link_type)
      VALUES ('B-001', 'legacy:v1.0.0', 'shipped');
    `);

    applyT9756Migration(nativeDb);

    const expectedId = `${CLEOCODE_PROJECT_HASH}:v1.0.0`;

    const rc = nativeDb.prepare('SELECT release_id FROM release_commits').all() as Array<{
      release_id: string;
    }>;
    expect(rc).toEqual([{ release_id: expectedId }]);

    const rch = nativeDb.prepare('SELECT release_id FROM release_changes').all() as Array<{
      release_id: string;
    }>;
    expect(rch).toEqual([{ release_id: expectedId }]);

    const ra = nativeDb.prepare('SELECT release_id FROM release_artifacts').all() as Array<{
      release_id: string;
    }>;
    expect(ra).toEqual([{ release_id: expectedId }]);

    const brl = nativeDb.prepare('SELECT release_id FROM brain_release_links').all() as Array<{
      release_id: string;
    }>;
    expect(brl).toEqual([{ release_id: expectedId }]);
  });

  it('is idempotent — re-running does not double-prefix', () => {
    nativeDb.exec(`
      INSERT INTO releases (id, version, status, created_at)
      VALUES ('legacy:v1.0.0', 'v1.0.0', 'pushed', '2026-01-01');
    `);

    applyT9756Migration(nativeDb);
    applyT9756Migration(nativeDb); // second apply — should be a no-op

    const row = nativeDb.prepare("SELECT id FROM releases WHERE version = 'v1.0.0'").get() as {
      id: string;
    };

    expect(row.id).toBe(`${CLEOCODE_PROJECT_HASH}:v1.0.0`);
    // Must NOT have been re-prefixed:
    expect(row.id).not.toContain(`${CLEOCODE_PROJECT_HASH}:${CLEOCODE_PROJECT_HASH}`);
  });

  it('preserves all non-PK columns verbatim (no data loss on rewrite)', () => {
    nativeDb.exec(`
      INSERT INTO releases (
        id, version, status, tasks_json, changelog, notes,
        previous_version, merge_commit_sha, git_tag, created_at,
        prepared_at, committed_at, tagged_at, pushed_at
      )
      VALUES (
        'legacy:v2026.5.73', 'v2026.5.73', 'pushed',
        '["T9000","T9001"]', 'CHANGELOG body', 'release notes',
        'v2026.5.72', 'fedcba987654', 'v2026.5.73-tag', '2026-05-15T00:00:00Z',
        '2026-05-15T01:00:00Z', '2026-05-15T02:00:00Z', '2026-05-15T03:00:00Z', '2026-05-15T04:00:00Z'
      );
    `);

    applyT9756Migration(nativeDb);

    const row = nativeDb
      .prepare("SELECT * FROM releases WHERE version = 'v2026.5.73'")
      .get() as Record<string, unknown>;

    expect(row).toMatchObject({
      id: `${CLEOCODE_PROJECT_HASH}:v2026.5.73`,
      version: 'v2026.5.73',
      status: 'pushed',
      tasks_json: '["T9000","T9001"]',
      changelog: 'CHANGELOG body',
      notes: 'release notes',
      previous_version: 'v2026.5.72',
      merge_commit_sha: 'fedcba987654',
      git_tag: 'v2026.5.73-tag',
      prepared_at: '2026-05-15T01:00:00Z',
      committed_at: '2026-05-15T02:00:00Z',
      tagged_at: '2026-05-15T03:00:00Z',
      pushed_at: '2026-05-15T04:00:00Z',
    });
  });

  it('revert flips uniform-shape rows back to legacy:<version>', () => {
    nativeDb.exec(`
      INSERT INTO releases (id, version, status, created_at)
      VALUES ('legacy:v1.0.0', 'v1.0.0', 'pushed', '2026-01-01');
    `);

    applyT9756Migration(nativeDb);
    expect((nativeDb.prepare('SELECT id FROM releases').get() as { id: string }).id).toBe(
      `${CLEOCODE_PROJECT_HASH}:v1.0.0`,
    );

    applyT9756Revert(nativeDb);
    expect((nativeDb.prepare('SELECT id FROM releases').get() as { id: string }).id).toBe(
      'legacy:v1.0.0',
    );
  });

  it('revert reverses FK rewrites in dependent tables', () => {
    nativeDb.exec(`
      INSERT INTO commits (sha) VALUES ('abc123');
      INSERT INTO releases (id, version, status, created_at)
      VALUES ('legacy:v1.0.0', 'v1.0.0', 'pushed', '2026-01-01');
      INSERT INTO release_commits (release_id, commit_sha, position)
      VALUES ('legacy:v1.0.0', 'abc123', 0);
    `);

    applyT9756Migration(nativeDb);
    applyT9756Revert(nativeDb);

    const rc = nativeDb.prepare('SELECT release_id FROM release_commits').all() as Array<{
      release_id: string;
    }>;
    expect(rc).toEqual([{ release_id: 'legacy:v1.0.0' }]);
  });

  it('handles versions that contain the literal `legacy:` substring safely', () => {
    // Defensive: ensure we strip ONLY the leading `legacy:` prefix and not
    // any later occurrence inside the version string.
    nativeDb.exec(`
      INSERT INTO releases (id, version, status, created_at)
      VALUES ('legacy:v1.0.0-legacy:hotfix', 'v1.0.0-legacy:hotfix', 'pushed', '2026-01-01');
    `);

    applyT9756Migration(nativeDb);

    const row = nativeDb.prepare('SELECT id FROM releases').get() as { id: string };
    expect(row.id).toBe(`${CLEOCODE_PROJECT_HASH}:v1.0.0-legacy:hotfix`);
  });
});
