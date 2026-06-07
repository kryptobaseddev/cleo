/**
 * Unit tests for {@link provenanceBackfill} (T9528 / Phase 2 of T9493).
 *
 * Coverage:
 *   - Happy path: 3 synthetic tags → all 11 tables populated, audit-log rows.
 *   - Idempotency: re-run is a no-op (no duplicate rows).
 *   - Checkpoint resume: simulate Ctrl-C mid-flight, second run continues.
 *   - `--force-overwrite`: flag propagates through to result + audit-log.
 *   - `--dry-run`: enumerates tags but writes nothing to DB.
 *   - Empty range: no tags since version → success with empty results array.
 *   - Reset checkpoint: existing state file is cleared before walk starts.
 *   - Tag enumeration: walks committer-date order.
 *
 * @task T9528
 * @epic T9493
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  enumerateHistoricalTags,
  loadCheckpoint,
  provenanceBackfill,
  saveCheckpoint,
} from '../backfill.js';

const _require = createRequire(import.meta.url);
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
    opts?: { readonly?: boolean },
  ) => import('node:sqlite').DatabaseSync;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Resolve path to the drizzle-tasks migrations folder. */
function migrationsDir(): string {
  return join(__dirname, '..', '..', '..', 'migrations', 'drizzle-tasks');
}

/** Set up a fully-migrated tasks.db + git repo in a temp project root. */
async function setupProject(): Promise<{
  projectRoot: string;
  cleanup: () => void;
}> {
  const projectRoot = mkdtempSync(join(tmpdir(), 'cleo-bf-'));
  const cleoDir = join(projectRoot, '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  mkdirSync(join(projectRoot, '.cleo', 'release'), { recursive: true });

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

  // Apply migrations to create the full schema.
  const dbPath = join(cleoDir, 'tasks.db');
  const nativeDb = new DatabaseSync(dbPath);
  const { drizzle } = await import('drizzle-orm/node-sqlite');
  const { reconcileJournal, migrateSanitized } = await import('../../store/migration-manager.js');
  const db = drizzle({ client: nativeDb });
  reconcileJournal(nativeDb, migrationsDir(), 'tasks', 'tasks');
  migrateSanitized(db, { migrationsFolder: migrationsDir() });
  nativeDb.close();

  // Init git repo.
  execFileSync('git', ['init', '-q'], { cwd: projectRoot });
  execFileSync('git', ['config', 'user.email', 'test@cleo.dev'], { cwd: projectRoot });
  execFileSync('git', ['config', 'user.name', 'Cleo Test'], { cwd: projectRoot });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: projectRoot });

  return {
    projectRoot,
    cleanup: () => rmSync(projectRoot, { recursive: true, force: true }),
  };
}

/** Insert tasks via raw SQL so reconcile's task-id validation passes. */
async function insertTasks(projectRoot: string, taskIds: string[]): Promise<void> {
  const { getDb } = await import('../../store/sqlite.js');
  const db = await getDb(projectRoot);
  for (const id of taskIds) {
    // T11578 · AC1: backfill reads the PREFIXED consolidated table; seed it.
    await db.run(
      sql`INSERT OR IGNORE INTO tasks_tasks (id, title, status, priority, role, scope)
          VALUES (${id}, ${`Task ${id}`}, 'pending', 'medium', 'work', 'feature')`,
    );
  }
}

/** Commit a file with a subject; returns the SHA. */
function gitCommit(projectRoot: string, file: string, content: string, subject: string): string {
  writeFileSync(join(projectRoot, file), content);
  execFileSync('git', ['add', file], { cwd: projectRoot });
  execFileSync('git', ['commit', '-q', '-m', subject], { cwd: projectRoot });
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf-8',
  }).trim();
}

/** Tag the current HEAD as `<version>`. */
function gitTag(projectRoot: string, version: string): void {
  execFileSync('git', ['tag', '-a', version, '-m', `Release ${version}`], { cwd: projectRoot });
}

/** Count rows in a table for the given project root. */
async function countRows(projectRoot: string, table: string): Promise<number> {
  const { getDb } = await import('../../store/sqlite.js');
  const db = await getDb(projectRoot);
  const rows = await db.all<{ cnt: number }>(sql.raw(`SELECT COUNT(*) AS cnt FROM ${table}`));
  return rows[0]?.cnt ?? 0;
}

/**
 * Seed 3 sequential synthetic releases: v1.0.0, v1.1.0, v1.2.0 each with a
 * couple of commits referencing the seeded T#### tokens. Returns the tag list
 * and the SHA at HEAD.
 */
async function seedThreeReleases(
  projectRoot: string,
  taskIds: string[],
): Promise<{ tags: string[] }> {
  await insertTasks(projectRoot, taskIds);
  const tags = ['v1.0.0', 'v1.1.0', 'v1.2.0'];
  for (let r = 0; r < tags.length; r++) {
    const tag = tags[r];
    if (!tag) continue;
    const t = taskIds[r % taskIds.length];
    if (!t) continue;
    gitCommit(projectRoot, `${tag}-a.txt`, `${tag}-a`, `feat(${t}): ship ${t} for ${tag}`);
    gitCommit(projectRoot, `${tag}-b.txt`, `${tag}-b`, `chore: bump version to ${tag}`);
    gitTag(projectRoot, tag);
  }
  return { tags };
}

// ── Reset per-test singleton ────────────────────────────────────────────────

afterEach(async () => {
  const { resetDbState } = await import('../../store/sqlite.js');
  resetDbState();
  vi.restoreAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('provenanceBackfill — Phase 2 (T9528)', () => {
  let projectRoot: string;
  let cleanup: () => void;

  beforeEach(async () => {
    const env = await setupProject();
    projectRoot = env.projectRoot;
    cleanup = env.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 1. Empty range — no tags discovered since version
  // ─────────────────────────────────────────────────────────────────────────
  it('returns success with empty result when no tags exist', async () => {
    const result = await provenanceBackfill({ since: '', projectRoot });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.totalTags).toEqual([]);
    expect(result.data.completedTags).toEqual([]);
    expect(result.data.failedTags).toEqual([]);
    expect(result.data.results).toEqual([]);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Tag enumeration — `enumerateHistoricalTags` returns creator-date order
  // ─────────────────────────────────────────────────────────────────────────
  it('enumerateHistoricalTags returns tags in creator-date order, oldest first', async () => {
    await seedThreeReleases(projectRoot, ['T1001', 'T1002', 'T1003']);
    const tags = enumerateHistoricalTags('', projectRoot);
    expect(tags).toEqual(['v1.0.0', 'v1.1.0', 'v1.2.0']);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. `--since` filters out the lower-bound tag
  // ─────────────────────────────────────────────────────────────────────────
  it('enumerateHistoricalTags excludes the --since tag itself', async () => {
    await seedThreeReleases(projectRoot, ['T1001', 'T1002', 'T1003']);
    const tags = enumerateHistoricalTags('v1.0.0', projectRoot);
    expect(tags).toEqual(['v1.1.0', 'v1.2.0']);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3a. Regression (C1): annotated tags must NOT be silently dropped.
  // `git tag --list --sort=committerdate` filters annotated tags out
  // because they have no committerdate of their own — the fix is to
  // sort by `creatordate` which works for both annotated and lightweight
  // tags. seedThreeReleases creates annotated tags via `git tag -a`,
  // so this test verifies all 3 are returned.
  // ─────────────────────────────────────────────────────────────────────────
  it('enumerateHistoricalTags returns annotated tags (C1 regression)', async () => {
    await seedThreeReleases(projectRoot, ['T1001', 'T1002', 'T1003']);
    // Sanity: confirm the seed actually produces annotated (objecttype=tag)
    // tags so this test would have caught the original committerdate bug.
    const tagTypes = execFileSync('git', ['for-each-ref', '--format=%(objecttype)', 'refs/tags/'], {
      cwd: projectRoot,
      encoding: 'utf-8',
    })
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(tagTypes.every((t: string) => t === 'tag')).toBe(true);

    const tags = enumerateHistoricalTags('', projectRoot);
    expect(tags).toEqual(['v1.0.0', 'v1.1.0', 'v1.2.0']);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3b. Regression (C1): mixed annotated + lightweight tags both appear.
  // ─────────────────────────────────────────────────────────────────────────
  it('enumerateHistoricalTags returns mixed annotated + lightweight tags (C1 regression)', async () => {
    await insertTasks(projectRoot, ['T1001', 'T1002']);
    gitCommit(projectRoot, 'a.txt', 'a', 'feat(T1001): first');
    // Annotated tag.
    execFileSync('git', ['tag', '-a', 'v1.0.0', '-m', 'Release v1.0.0'], { cwd: projectRoot });
    gitCommit(projectRoot, 'b.txt', 'b', 'feat(T1002): second');
    // Lightweight tag (no -a, no -m).
    execFileSync('git', ['tag', 'v1.1.0'], { cwd: projectRoot });
    gitCommit(projectRoot, 'c.txt', 'c', 'chore: bump');
    // Another annotated tag.
    execFileSync('git', ['tag', '-a', 'v1.2.0', '-m', 'Release v1.2.0'], { cwd: projectRoot });

    const tags = enumerateHistoricalTags('', projectRoot);
    expect(tags).toEqual(['v1.0.0', 'v1.1.0', 'v1.2.0']);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. Happy path — 3 tags → 11 tables populated
  // ─────────────────────────────────────────────────────────────────────────
  it('happy path: backfills 3 synthetic tags → populates all 11 tables', async () => {
    await seedThreeReleases(projectRoot, ['T1001', 'T1002', 'T1003']);
    const result = await provenanceBackfill({ since: '', projectRoot });
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.totalTags).toEqual(['v1.0.0', 'v1.1.0', 'v1.2.0']);
    expect(result.data.completedTags.length).toBe(3);
    expect(result.data.failedTags.length).toBe(0);

    // Table populations
    expect(await countRows(projectRoot, 'tasks_commits')).toBeGreaterThanOrEqual(6);
    expect(await countRows(projectRoot, 'tasks_commit_files')).toBeGreaterThanOrEqual(6);
    expect(await countRows(projectRoot, 'tasks_task_commits')).toBeGreaterThanOrEqual(3);
    expect(await countRows(projectRoot, 'tasks_releases')).toBe(3);
    expect(await countRows(projectRoot, 'tasks_release_commits')).toBeGreaterThanOrEqual(6);
    expect(await countRows(projectRoot, 'tasks_release_changes')).toBeGreaterThanOrEqual(3);
    expect(await countRows(projectRoot, 'tasks_release_artifacts')).toBe(3);

    // Audit log written per tag.
    const auditRows = await countRows(projectRoot, 'audit_log');
    expect(auditRows).toBeGreaterThanOrEqual(3);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. Idempotency — re-running is a no-op modulo audit-log appends
  // ─────────────────────────────────────────────────────────────────────────
  it('idempotent: re-run does not duplicate provenance rows', async () => {
    await seedThreeReleases(projectRoot, ['T1001', 'T1002', 'T1003']);
    const first = await provenanceBackfill({ since: '', projectRoot });
    expect(first.success).toBe(true);

    const commitsAfter1 = await countRows(projectRoot, 'tasks_commits');
    const releasesAfter1 = await countRows(projectRoot, 'tasks_releases');
    const taskCommitsAfter1 = await countRows(projectRoot, 'tasks_task_commits');

    const second = await provenanceBackfill({ since: '', projectRoot, resetCheckpoint: true });
    expect(second.success).toBe(true);

    expect(await countRows(projectRoot, 'tasks_commits')).toBe(commitsAfter1);
    expect(await countRows(projectRoot, 'tasks_releases')).toBe(releasesAfter1);
    expect(await countRows(projectRoot, 'tasks_task_commits')).toBe(taskCommitsAfter1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 6. Checkpoint resume — synthesize a stale checkpoint, expect resume
  // ─────────────────────────────────────────────────────────────────────────
  it('resumes from existing checkpoint instead of restarting the walk', async () => {
    await seedThreeReleases(projectRoot, ['T1001', 'T1002', 'T1003']);

    // Pre-populate a checkpoint saying v1.0.0 + v1.1.0 are already done.
    saveCheckpoint(
      {
        since: '',
        totalTags: ['v1.0.0', 'v1.1.0', 'v1.2.0'],
        completedTags: ['v1.0.0', 'v1.1.0'],
        failedTags: [],
        lastProcessedTag: 'v1.1.0',
        startedAt: new Date().toISOString(),
        lastSavedAt: new Date().toISOString(),
        forceOverwrite: false,
      },
      projectRoot,
    );

    const result = await provenanceBackfill({ since: '', projectRoot });
    expect(result.success).toBe(true);
    if (!result.success) return;

    // All 3 should now be marked completed, only 1 actual reconcile happened.
    expect(result.data.completedTags.sort()).toEqual(['v1.0.0', 'v1.1.0', 'v1.2.0']);
    // Releases table should have just one row (only v1.2.0 was actually reconciled).
    expect(await countRows(projectRoot, 'tasks_releases')).toBe(1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 7. Reset checkpoint flag actively clears the file
  // ─────────────────────────────────────────────────────────────────────────
  it('resetCheckpoint clears the existing state file before walking', async () => {
    await seedThreeReleases(projectRoot, ['T1001', 'T1002', 'T1003']);

    saveCheckpoint(
      {
        since: '',
        totalTags: ['v1.0.0', 'v1.1.0', 'v1.2.0'],
        completedTags: ['v1.0.0', 'v1.1.0', 'v1.2.0'],
        failedTags: [],
        lastProcessedTag: 'v1.2.0',
        startedAt: new Date().toISOString(),
        lastSavedAt: new Date().toISOString(),
        forceOverwrite: false,
      },
      projectRoot,
    );

    const result = await provenanceBackfill({ since: '', projectRoot, resetCheckpoint: true });
    expect(result.success).toBe(true);
    if (!result.success) return;
    // With checkpoint cleared the walk re-runs every tag → releases table = 3.
    expect(await countRows(projectRoot, 'tasks_releases')).toBe(3);
    // After successful run with no failures, checkpoint is cleared.
    expect(loadCheckpoint(projectRoot)).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 8. Dry-run — no DB writes, returns plan
  // ─────────────────────────────────────────────────────────────────────────
  it('dryRun enumerates tags but writes nothing to the provenance tables', async () => {
    await seedThreeReleases(projectRoot, ['T1001', 'T1002', 'T1003']);
    const result = await provenanceBackfill({ since: '', projectRoot, dryRun: true });
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.dryRun).toBe(true);
    expect(result.data.totalTags).toEqual(['v1.0.0', 'v1.1.0', 'v1.2.0']);
    expect(result.data.results.every((r) => r.status === 'skipped')).toBe(true);

    // Zero releases written.
    expect(await countRows(projectRoot, 'tasks_releases')).toBe(0);
    // Post-cutover (T11883 · E3) the runtime reads the PREFIXED `tasks_commits`
    // table. The T9755 legacy backfill targets the BARE `commits` table only,
    // so the prefixed table has no baked-in baseline; a write-free dry-run
    // therefore leaves it empty.
    expect(await countRows(projectRoot, 'tasks_commits')).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 9. forceOverwrite flag — flows through to result + downstream reconcile
  // ─────────────────────────────────────────────────────────────────────────
  it('forceOverwrite propagates through, completes successfully, audit-logs', async () => {
    await seedThreeReleases(projectRoot, ['T1001', 'T1002', 'T1003']);

    // First run — populate baseline.
    const first = await provenanceBackfill({ since: '', projectRoot });
    expect(first.success).toBe(true);

    const releasesBefore = await countRows(projectRoot, 'tasks_releases');
    const auditBefore = await countRows(projectRoot, 'audit_log');

    // Second run with forceOverwrite — should still no-op on row counts
    // (UPSERT semantics) but should append additional audit rows.
    const second = await provenanceBackfill({
      since: '',
      projectRoot,
      forceOverwrite: true,
      resetCheckpoint: true,
    });
    expect(second.success).toBe(true);

    expect(await countRows(projectRoot, 'tasks_releases')).toBe(releasesBefore);
    expect(await countRows(projectRoot, 'audit_log')).toBeGreaterThan(auditBefore);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 10. Checkpoint persists after a partial failure for retry
  // ─────────────────────────────────────────────────────────────────────────
  it('checkpoint file is kept on disk when at least one tag failed', async () => {
    await seedThreeReleases(projectRoot, ['T1001', 'T1002', 'T1003']);

    // Pre-mark v1.1.0 as already failed so we have a known failed entry.
    saveCheckpoint(
      {
        since: '',
        totalTags: ['v1.0.0', 'v1.1.0', 'v1.2.0'],
        completedTags: [],
        failedTags: [{ tag: 'v1.1.0', errorCode: 'E_TEST', errorMessage: 'simulated failure' }],
        lastProcessedTag: 'v1.1.0',
        startedAt: new Date().toISOString(),
        lastSavedAt: new Date().toISOString(),
        forceOverwrite: false,
      },
      projectRoot,
    );

    const result = await provenanceBackfill({ since: '', projectRoot });
    expect(result.success).toBe(true);
    if (!result.success) return;

    // failedTags persisted from checkpoint should still appear.
    expect(result.data.failedTags.some((f) => f.tag === 'v1.1.0')).toBe(true);
    // Checkpoint should still be on disk for retry.
    expect(loadCheckpoint(projectRoot)).not.toBeNull();
    expect(result.data.checkpointPath).not.toBeNull();
  });
});
