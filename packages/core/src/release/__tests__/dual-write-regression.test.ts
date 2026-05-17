/**
 * Regression tests for CLEO_PROVENANCE_DUAL_WRITE env var.
 *
 * Validates that `markReleaseShipped`:
 *   1. With CLEO_PROVENANCE_DUAL_WRITE='1' (default ON): inserts `task_commits`
 *      rows for every task in the release manifest, using the provided commit SHA.
 *   2. With CLEO_PROVENANCE_DUAL_WRITE='0' (OFF): writes nothing to `task_commits`.
 *   3. `release_manifests.tasksJson` is identical in both modes (F12 — ADR-073).
 *
 * Each test runs in a fully isolated tmp directory with a real SQLite database
 * and all migrations applied.
 *
 * @task T9510
 * @epic T9491
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../changelog-writer.js', () => ({
  writeChangelogSection: vi.fn().mockResolvedValue(undefined),
  parseChangelogBlocks: vi.fn().mockReturnValue({ customBlocks: [], strippedContent: '' }),
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

/** Resolve path to the drizzle-tasks migration folder. */
function migrationsDir(): string {
  return join(__dirname, '..', '..', '..', 'migrations', 'drizzle-tasks');
}

/**
 * Set up a fully-migrated tasks.db in a temp project root.
 * Returns the project root path and a cleanup function.
 */
async function setupMigratedDb(): Promise<{ projectRoot: string; cleanup: () => void }> {
  const projectRoot = mkdtempSync(join(tmpdir(), 'cleo-dw-'));
  const cleoDir = join(projectRoot, '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  mkdirSync(join(projectRoot, '.git'), { recursive: true });

  // Write a minimal config so the session/acceptance enforcement is disabled.
  writeFileSync(
    join(cleoDir, 'config.json'),
    JSON.stringify({
      enforcement: {
        session: { requiredForMutate: false },
        acceptance: { mode: 'off' },
      },
      lifecycle: { mode: 'off' },
      verification: { enabled: false },
    }),
  );

  // Apply all migrations to create the full schema including task_commits.
  const dbPath = join(cleoDir, 'tasks.db');
  const nativeDb = new DatabaseSync(dbPath);
  const { drizzle } = await import('drizzle-orm/node-sqlite');
  const { reconcileJournal, migrateSanitized } = await import('../../store/migration-manager.js');
  const db = drizzle({ client: nativeDb });
  reconcileJournal(nativeDb, migrationsDir(), 'tasks', 'tasks');
  migrateSanitized(db, { migrationsFolder: migrationsDir() });
  nativeDb.close();

  return {
    projectRoot,
    cleanup: () => rmSync(projectRoot, { recursive: true, force: true }),
  };
}

/**
 * Insert a synthetic release manifest into the given project root's tasks.db.
 * Returns the version string.
 */
async function insertManifest(
  projectRoot: string,
  version: string,
  taskIds: string[],
): Promise<void> {
  const { getDb } = await import('../../store/sqlite.js');
  const { resetDbState } = await import('../../store/sqlite.js');
  resetDbState();

  const db = await getDb(projectRoot);
  const id = `rel-${version.replace(/[^a-z0-9]/gi, '-')}`;
  const { sql } = await import('drizzle-orm');
  await db.run(
    sql`INSERT INTO release_manifests (id, version, status, tasks_json, created_at)
        VALUES (${id}, ${version}, 'prepared', ${JSON.stringify(taskIds)}, datetime('now'))`,
  );
}

/**
 * Count rows in task_commits for the given commit SHA and project root.
 */
async function countTaskCommits(projectRoot: string, commitSha: string): Promise<number> {
  const { getDb } = await import('../../store/sqlite.js');
  const { sql } = await import('drizzle-orm');
  const db = await getDb(projectRoot);
  const rows = await db.all<{ cnt: number }>(
    sql`SELECT COUNT(*) AS cnt FROM task_commits WHERE commit_sha = ${commitSha}`,
  );
  return rows[0]?.cnt ?? 0;
}

/**
 * Read tasksJson from release_manifests for validation.
 */
async function readTasksJson(projectRoot: string, version: string): Promise<string> {
  const { getDb } = await import('../../store/sqlite.js');
  const { sql } = await import('drizzle-orm');
  const db = await getDb(projectRoot);
  const rows = await db.all<{ tasks_json: string }>(
    sql`SELECT tasks_json FROM release_manifests WHERE version = ${version}`,
  );
  return rows[0]?.tasks_json ?? '[]';
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('CLEO_PROVENANCE_DUAL_WRITE — dual-write regression', () => {
  let projectRoot: string;
  let cleanup: () => void;
  const COMMIT_SHA = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555';
  const TASK_IDS = ['T0001', 'T0002', 'T0003'];
  const VERSION = 'v2026.99.1';

  beforeEach(async () => {
    const env = await setupMigratedDb();
    projectRoot = env.projectRoot;
    cleanup = env.cleanup;
    // Insert synthetic release manifest with 3 tasks.
    await insertManifest(projectRoot, VERSION, TASK_IDS);
  });

  afterEach(async () => {
    const { resetDbState } = await import('../../store/sqlite.js');
    resetDbState();
    cleanup();
    // Reset the per-process warn flag between tests.
    const mod = await import('../release-manifest.js');
    // Force reset of the module-level warn flag via environment toggle.
    process.env['CLEO_PROVENANCE_DUAL_WRITE'] = '1';
    delete process.env['CLEO_PROVENANCE_DUAL_WRITE'];
  });

  it('Test 1: DUAL_WRITE=1 inserts task_commits rows for all 3 tasks', async () => {
    process.env['CLEO_PROVENANCE_DUAL_WRITE'] = '1';

    const { markReleaseShipped } = await import('../release-manifest.js');
    const result = await markReleaseShipped(VERSION, new Date().toISOString(), projectRoot, {
      commitSha: COMMIT_SHA,
    });

    expect(result.taskCommitsInserted).toBe(TASK_IDS.length);
    const count = await countTaskCommits(projectRoot, COMMIT_SHA);
    expect(count).toBe(TASK_IDS.length);
  });

  it('Test 2: DUAL_WRITE=0 inserts NO task_commits rows', async () => {
    process.env['CLEO_PROVENANCE_DUAL_WRITE'] = '0';

    // Use a different version/commit to avoid collision with test 1.
    const version2 = 'v2026.99.2';
    const commit2 = 'ffff0000aaaa1111bbbb2222cccc3333dddd4444';
    await insertManifest(projectRoot, version2, TASK_IDS);

    const { markReleaseShipped } = await import('../release-manifest.js');
    const result = await markReleaseShipped(version2, new Date().toISOString(), projectRoot, {
      commitSha: commit2,
    });

    expect(result.taskCommitsInserted).toBe(0);
    const count = await countTaskCommits(projectRoot, commit2);
    expect(count).toBe(0);
  });

  it('Test 3: release_manifests.tasksJson is identical regardless of DUAL_WRITE mode', async () => {
    // Test with dual-write ON.
    process.env['CLEO_PROVENANCE_DUAL_WRITE'] = '1';
    const vON = 'v2026.99.3';
    const commitON = '1111aaaa2222bbbb3333cccc4444dddd5555eeee';
    await insertManifest(projectRoot, vON, TASK_IDS);
    const { markReleaseShipped } = await import('../release-manifest.js');
    await markReleaseShipped(vON, new Date().toISOString(), projectRoot, {
      commitSha: commitON,
    });
    const tasksJsonON = await readTasksJson(projectRoot, vON);

    // Test with dual-write OFF.
    process.env['CLEO_PROVENANCE_DUAL_WRITE'] = '0';
    const vOFF = 'v2026.99.4';
    const commitOFF = '9999aaaa8888bbbb7777cccc6666dddd5555eeee';
    await insertManifest(projectRoot, vOFF, TASK_IDS);
    await markReleaseShipped(vOFF, new Date().toISOString(), projectRoot, {
      commitSha: commitOFF,
    });
    const tasksJsonOFF = await readTasksJson(projectRoot, vOFF);

    // Both runs should preserve the same task list in release_manifests.
    const parsedON = JSON.parse(tasksJsonON) as string[];
    const parsedOFF = JSON.parse(tasksJsonOFF) as string[];
    expect(parsedON.sort()).toEqual(parsedOFF.sort());
    expect(parsedON.sort()).toEqual([...TASK_IDS].sort());
  });
});
