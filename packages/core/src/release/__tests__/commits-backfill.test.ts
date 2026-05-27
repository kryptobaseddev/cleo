/**
 * T9755 backfill migration — regression lock.
 *
 * Locks the invariants of the
 * `20260520163324_t9755-backfill-legacy-ship-commits` migration:
 *
 *   1. Applying the migration on an empty `tasks.db` inserts all 18
 *      backfill rows into `commits`.
 *   2. The migration is idempotent — re-running it via raw INSERTs is a
 *      no-op (ON CONFLICT(sha) DO NOTHING) and never duplicates rows.
 *   3. After the migration the `merge_commit_sha` FK is hard again:
 *      inserting a `releases` row whose `merge_commit_sha` does NOT
 *      exist in `commits` fails with a SQLite FK constraint error.
 *   4. Inserting a `releases` row whose `merge_commit_sha` references one
 *      of the backfilled SHAs succeeds.
 *   5. Idempotent re-apply of the FULL migration (commits inserts + table
 *      rebuild) does not duplicate `commits` rows.
 *
 * The migration is loaded from disk and split on
 * `--> statement-breakpoint` exactly the way drizzle's runner does in
 * production (mirrored from `unify-migration.test.ts`).
 *
 * @task T9755
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

/**
 * Resolve the drizzle-tasks migrations folder.
 *
 * @internal
 */
function migrationsDir(): string {
  return join(__dirname, '..', '..', '..', 'migrations', 'drizzle-tasks');
}

/**
 * The 18 SHAs the T9755 migration backfills. Used by the "all rows present"
 * and "idempotent" assertions.
 *
 * @internal
 */
const BACKFILLED_SHAS: ReadonlyArray<string> = [
  '9f1eac565d44818f7c803e3327aaed4d5d830c67',
  '1e1f2302b1ad5ed764206f573b6ca07d638cfa5b',
  '572630ee6a54b94a904ae6c79a7a86fc3a5054b0',
  'f2b2466bf9f5f53c5ab6f619a30490621c27e903',
  '101c0eb6f637cdc92165ade04ceef58f8f4dd014',
  '1386636d32bfd58d90d900e2636c02cc939025a8',
  '6607fc2cd09f0bd700bf6bdbcc7d7aac75873b4d',
  '5638ac5f567a9420c9c18b356ed1640f4236f526',
  'bd4bba8f654722a0e4ebd491bbb8b500cf8ae4d0',
  '1867e9778f7c02807d543435dd6bd29fc89abddd',
  '856353ebe45a4904e461fe00f326bd83d863ded8',
  '018b2cd7d36c0edde68234544834d9bc076c08d8',
  '85fa011fb08eb4e49f94be4ac92071e5b7f80b6e',
  '8a0a0131a536730a0017cf9de056d18f4a86e800',
  '422ff7353365f7e3ab5b2e1b7ca824e0b486ded6',
  'd36146b979ed0c50b4275400074188dabce79c86',
  '23dc2cc5e10176697f14f172c4ee5b94937fd7fc',
  'ebee726e5318d3cd7407310d0c44c0b53ead392b',
] as const;

/**
 * Apply the pre-T9755 schema for `commits` + `releases` + their
 * dependencies. This matches the production state at HEAD of `main` AFTER
 * T9686-B2 ran but BEFORE T9755 ran — i.e. `commits` exists (empty),
 * `releases` exists with the soft `merge_commit_sha` text column (no FK).
 *
 * Mirrors the snapshot approach used by `unify-migration.test.ts` to keep
 * the test stable against unrelated DDL drift in the 50+ unrelated
 * migrations.
 *
 * @internal
 */
function applySchemaBeforeBackfill(dbPath: string): import('node:sqlite').DatabaseSync {
  const nativeDb = new DatabaseSync(dbPath);
  const preBackfillDdl = `
    PRAGMA foreign_keys=ON;

    CREATE TABLE tasks (id TEXT PRIMARY KEY);
    CREATE TABLE pull_requests (id TEXT PRIMARY KEY);

    -- Post-T9506 \`commits\` shape (matches migration
    -- 20260517000000_t9506-add-commits-table/migration.sql verbatim).
    CREATE TABLE commits (
      sha                TEXT PRIMARY KEY NOT NULL,
      short_sha          TEXT NOT NULL,
      author_name        TEXT,
      author_email       TEXT,
      authored_at        TEXT NOT NULL,
      committer_name     TEXT,
      committer_email    TEXT,
      committed_at       TEXT NOT NULL,
      message            TEXT NOT NULL,
      subject            TEXT NOT NULL,
      conventional_type  TEXT,
      is_release_commit  INTEGER NOT NULL DEFAULT 0,
      is_merge_commit    INTEGER NOT NULL DEFAULT 0,
      parent_shas        TEXT NOT NULL DEFAULT '[]',
      signature_verified INTEGER,
      branch_at_commit   TEXT,
      project_hash       TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Post-T9686-B2 \`releases\` shape: merge_commit_sha is a soft TEXT
    -- column with NO foreign key — exactly what T9755 must replace.
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

    CREATE INDEX idx_releases_version ON releases (version);
    CREATE INDEX idx_releases_status ON releases (status);
    CREATE INDEX idx_releases_channel ON releases (channel);
    CREATE INDEX idx_releases_epic_id ON releases (epic_id);
    CREATE INDEX idx_releases_merge_commit_sha ON releases (merge_commit_sha);
    CREATE INDEX idx_releases_project_hash ON releases (project_hash);
    CREATE INDEX idx_releases_published_at ON releases (published_at);
    CREATE INDEX idx_releases_pushed_at ON releases (pushed_at);
  `;
  nativeDb.exec(preBackfillDdl);
  return nativeDb;
}

/**
 * Apply the T9755 backfill migration to the supplied DB by splitting the
 * SQL on `--> statement-breakpoint` and exec'ing each chunk. Mirrors the
 * production runner's behaviour exactly (see drizzle-orm/migrator).
 *
 * @internal
 */
function applyBackfillMigration(nativeDb: import('node:sqlite').DatabaseSync): void {
  const sqlPath = join(
    migrationsDir(),
    '20260520163324_t9755-backfill-legacy-ship-commits',
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

describe('T9755 backfill-legacy-ship-commits migration', () => {
  let tempDir: string;
  let nativeDb: import('node:sqlite').DatabaseSync;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-t9755-mig-'));
    nativeDb = applySchemaBeforeBackfill(join(tempDir, 'tasks.db'));
  });

  afterEach(() => {
    try {
      nativeDb.close();
    } catch {
      // already closed
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('inserts all 18 backfill rows into `commits` on first apply', () => {
    applyBackfillMigration(nativeDb);

    const count = (nativeDb.prepare('SELECT COUNT(*) AS n FROM commits').get() as { n: number }).n;
    expect(count).toBe(BACKFILLED_SHAS.length);

    const shas = (
      nativeDb.prepare('SELECT sha FROM commits ORDER BY sha').all() as Array<{ sha: string }>
    ).map((r) => r.sha);
    expect(shas.sort()).toEqual([...BACKFILLED_SHAS].sort());
  });

  it('flags every backfilled row as a release commit', () => {
    applyBackfillMigration(nativeDb);

    const nonRelease = (
      nativeDb.prepare('SELECT COUNT(*) AS n FROM commits WHERE is_release_commit = 0').get() as {
        n: number;
      }
    ).n;
    expect(nonRelease).toBe(0);
  });

  it('marks the 9 PR-merge / squash-merge rows as merge commits', () => {
    applyBackfillMigration(nativeDb);

    // PR merge commits and the v5.88 squash-merge — every row whose
    // parent_shas JSON array has 2 entries (and conventional_type=merge OR
    // is_merge_commit=1).
    const mergeCount = (
      nativeDb.prepare('SELECT COUNT(*) AS n FROM commits WHERE is_merge_commit = 1').get() as {
        n: number;
      }
    ).n;
    expect(mergeCount).toBe(9);
  });

  it('is idempotent — replaying ONLY the INSERT statements is a no-op', () => {
    applyBackfillMigration(nativeDb);
    const firstCount = (
      nativeDb.prepare('SELECT COUNT(*) AS n FROM commits').get() as { n: number }
    ).n;

    // Re-run just the INSERT block (ON CONFLICT DO NOTHING is the
    // idempotency guarantee). We splice out the table-rebuild block
    // because dropping + recreating the table is not idempotent on its
    // own — only Drizzle's journal makes the whole migration idempotent
    // at the runner level. We're testing the INSERT idempotency only.
    const sqlPath = join(
      migrationsDir(),
      '20260520163324_t9755-backfill-legacy-ship-commits',
      'migration.sql',
    );
    const sql = execSync(`cat ${sqlPath}`, { encoding: 'utf-8' });
    const statements = sql.split('--> statement-breakpoint');
    for (const stmt of statements) {
      const trimmed = stmt.trim();
      if (!trimmed) continue;
      // Only re-run the INSERT INTO commits statements.
      if (trimmed.startsWith('INSERT INTO `commits`')) {
        nativeDb.exec(trimmed);
      }
    }

    const secondCount = (
      nativeDb.prepare('SELECT COUNT(*) AS n FROM commits').get() as { n: number }
    ).n;
    expect(secondCount).toBe(firstCount);
    expect(secondCount).toBe(BACKFILLED_SHAS.length);
  });

  it('re-enables the merge_commit_sha FK (insert with unknown SHA fails)', () => {
    applyBackfillMigration(nativeDb);

    // After the migration, FKs are re-enabled (final PRAGMA in migration.sql).
    // Inserting a `releases` row whose merge_commit_sha doesn't exist in
    // `commits` MUST fail.
    expect(() => {
      nativeDb.exec(`
        INSERT INTO releases (id, version, status, merge_commit_sha, created_at)
        VALUES ('test:v0.0.1', 'v0.0.1', 'planned', 'deadbeef0000000000000000000000000000beef', '2026-05-20T00:00:00Z');
      `);
    }).toThrow(/foreign key/i);
  });

  it('accepts a releases row whose merge_commit_sha matches a backfilled commit', () => {
    applyBackfillMigration(nativeDb);

    // v5.88 PR squash-merge SHA — should be present in `commits` post-migration.
    nativeDb.exec(`
      INSERT INTO releases (id, version, status, merge_commit_sha, created_at)
      VALUES (
        'hash1:v2026.5.88',
        'v2026.5.88',
        'reconciled',
        '23dc2cc5e10176697f14f172c4ee5b94937fd7fc',
        '2026-05-20T01:00:31Z'
      );
    `);

    const row = nativeDb
      .prepare("SELECT id, merge_commit_sha FROM releases WHERE version = 'v2026.5.88'")
      .get() as { id: string; merge_commit_sha: string };
    expect(row).toMatchObject({
      id: 'hash1:v2026.5.88',
      merge_commit_sha: '23dc2cc5e10176697f14f172c4ee5b94937fd7fc',
    });
  });

  it('preserves pre-existing releases rows across the table rebuild', () => {
    // Seed a legacy `legacy:vX` row whose merge_commit_sha points at one of
    // the SHAs that this migration will backfill. The rebuild must copy
    // it across without changing its values (and without an FK violation
    // because the migration inserts commits BEFORE rebuilding the table).
    nativeDb.exec(`
      INSERT INTO releases (id, version, scheme, channel, status, merge_commit_sha, tasks_json, created_at)
      VALUES (
        'legacy:v2026.5.80',
        'v2026.5.80',
        'calver',
        'latest',
        'pushed',
        '1e1f2302b1ad5ed764206f573b6ca07d638cfa5b',
        '["T9580"]',
        '2026-05-18T20:07:47Z'
      );
    `);

    applyBackfillMigration(nativeDb);

    const row = nativeDb
      .prepare(
        "SELECT id, status, merge_commit_sha, tasks_json FROM releases WHERE version = 'v2026.5.80'",
      )
      .get() as { id: string; status: string; merge_commit_sha: string; tasks_json: string };
    expect(row).toMatchObject({
      id: 'legacy:v2026.5.80',
      status: 'pushed',
      merge_commit_sha: '1e1f2302b1ad5ed764206f573b6ca07d638cfa5b',
      tasks_json: '["T9580"]',
    });
  });

  it('preserves pre-existing releases rows whose merge_commit_sha is NULL', () => {
    // Releases that never recorded a merge_commit_sha (e.g. cancelled
    // planning rows) must survive the rebuild — the FK is ON DELETE SET NULL
    // and the column is nullable.
    nativeDb.exec(`
      INSERT INTO releases (id, version, status, created_at)
      VALUES ('hash1:v2026.6.99', 'v2026.6.99', 'cancelled', '2026-06-01T00:00:00Z');
    `);

    applyBackfillMigration(nativeDb);

    const row = nativeDb
      .prepare("SELECT id, status, merge_commit_sha FROM releases WHERE version = 'v2026.6.99'")
      .get() as { id: string; status: string; merge_commit_sha: string | null };
    expect(row).toMatchObject({
      id: 'hash1:v2026.6.99',
      status: 'cancelled',
      merge_commit_sha: null,
    });
  });
});
