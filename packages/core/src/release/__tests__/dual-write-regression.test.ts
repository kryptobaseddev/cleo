/**
 * Regression tests for retired CLEO_PROVENANCE_DUAL_WRITE env var.
 *
 * After T9541, the env var is gone — `markReleaseShipped` writes to
 * `task_commits` unconditionally. These tests validate the new behavior:
 *
 *   1. New-table writes happen unconditionally (no env var required).
 *   2. The env var being present (set to either value) has no effect.
 *   3. `release_manifests.tasksJson` is preserved (F12 — ADR-073).
 *   4. The retirement audit sentinel is written on first invocation.
 *
 * Each test runs in a fully isolated tmp directory with a real SQLite database
 * and all migrations applied.
 *
 * @task T9510
 * @task T9541
 * @epic T9491
 * @epic T9499
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  // T9686-B2: `release_manifests` was unified into `releases`. Use the
  // canonical `legacy:` PK prefix matching what migration produces for
  // pre-T9492 historical rows.
  const id = `legacy:${version}`;
  const { sql } = await import('drizzle-orm');
  await db.run(
    sql`INSERT INTO releases (id, version, status, tasks_json, created_at)
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
 * Read tasksJson from the unified `releases` table for validation
 * (post-T9686-B2 — legacy `release_manifests` was merged in).
 */
async function readTasksJson(projectRoot: string, version: string): Promise<string> {
  const { getDb } = await import('../../store/sqlite.js');
  const { sql } = await import('drizzle-orm');
  const db = await getDb(projectRoot);
  const rows = await db.all<{ tasks_json: string }>(
    sql`SELECT tasks_json FROM releases WHERE version = ${version}`,
  );
  return rows[0]?.tasks_json ?? '[]';
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('CLEO_PROVENANCE_DUAL_WRITE — retired (T9541)', () => {
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
    // Defensive: if a stale env var is set from another test, remove it.
    delete process.env['CLEO_PROVENANCE_DUAL_WRITE'];
  });

  afterEach(async () => {
    const { resetDbState } = await import('../../store/sqlite.js');
    resetDbState();
    cleanup();
    delete process.env['CLEO_PROVENANCE_DUAL_WRITE'];
  });

  it('Test 1: writes task_commits rows for all tasks unconditionally', async () => {
    // Env var unset — writes must still happen.
    const { markReleaseShipped } = await import('../release-manifest.js');
    const result = await markReleaseShipped(VERSION, new Date().toISOString(), projectRoot, {
      commitSha: COMMIT_SHA,
    });

    expect(result.taskCommitsInserted).toBe(TASK_IDS.length);
    const count = await countTaskCommits(projectRoot, COMMIT_SHA);
    expect(count).toBe(TASK_IDS.length);
  });

  it('Test 2: env var present (legacy "0") is ignored — writes still happen', async () => {
    // Even with the retired var set to its old disable-value, writes proceed.
    process.env['CLEO_PROVENANCE_DUAL_WRITE'] = '0';

    const version2 = 'v2026.99.2';
    const commit2 = 'ffff0000aaaa1111bbbb2222cccc3333dddd4444';
    await insertManifest(projectRoot, version2, TASK_IDS);

    const { markReleaseShipped } = await import('../release-manifest.js');
    const result = await markReleaseShipped(version2, new Date().toISOString(), projectRoot, {
      commitSha: commit2,
    });

    expect(result.taskCommitsInserted).toBe(TASK_IDS.length);
    const count = await countTaskCommits(projectRoot, commit2);
    expect(count).toBe(TASK_IDS.length);
  });

  it('Test 3: release_manifests.tasksJson is preserved (F12 backward-compat)', async () => {
    const vA = 'v2026.99.3';
    const commitA = '1111aaaa2222bbbb3333cccc4444dddd5555eeee';
    await insertManifest(projectRoot, vA, TASK_IDS);
    const { markReleaseShipped } = await import('../release-manifest.js');
    await markReleaseShipped(vA, new Date().toISOString(), projectRoot, {
      commitSha: commitA,
    });
    const tasksJsonA = await readTasksJson(projectRoot, vA);

    const vB = 'v2026.99.4';
    const commitB = '9999aaaa8888bbbb7777cccc6666dddd5555eeee';
    await insertManifest(projectRoot, vB, TASK_IDS);
    await markReleaseShipped(vB, new Date().toISOString(), projectRoot, {
      commitSha: commitB,
    });
    const tasksJsonB = await readTasksJson(projectRoot, vB);

    // The legacy release_manifests table preserves the task list verbatim.
    const parsedA = JSON.parse(tasksJsonA) as string[];
    const parsedB = JSON.parse(tasksJsonB) as string[];
    expect(parsedA.sort()).toEqual([...TASK_IDS].sort());
    expect(parsedB.sort()).toEqual([...TASK_IDS].sort());
  });

  it('Test 4: writes retirement audit sentinel + JSONL entry on first run', async () => {
    const { markReleaseShipped } = await import('../release-manifest.js');
    await markReleaseShipped(VERSION, new Date().toISOString(), projectRoot, {
      commitSha: COMMIT_SHA,
    });

    const flagPath = join(projectRoot, '.cleo', 'audit', 'dual-write-retired.flag');
    const logPath = join(projectRoot, '.cleo', 'audit', 'dual-write-retired.jsonl');
    expect(existsSync(flagPath)).toBe(true);
    expect(existsSync(logPath)).toBe(true);

    const flagContents = JSON.parse(readFileSync(flagPath, 'utf-8')) as {
      task: string;
      retiredAt: string;
    };
    expect(flagContents.task).toBe('T9541');
    expect(typeof flagContents.retiredAt).toBe('string');

    const logLines = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(logLines.length).toBeGreaterThanOrEqual(1);
    const firstEntry = JSON.parse(logLines[0]!) as {
      event: string;
      task: string;
      version: string;
    };
    expect(firstEntry.event).toBe('dual-write-retired');
    expect(firstEntry.task).toBe('T9541');
    expect(firstEntry.version).toBe(VERSION);
  });
});
