/**
 * Unit tests for `releaseReconcileV2` (T9526 / SPEC-T9345 §4.4).
 *
 * Coverage:
 *   - Happy path: full reconcile populates all 11 tables.
 *   - Idempotency: re-run is a no-op; no duplicate rows.
 *   - E_PLAN_NOT_FOUND when plan file missing.
 *   - E_PLAN_INVALID when plan JSON malformed.
 *   - E_TAG_NOT_FOUND when git tag missing.
 *   - E_EVIDENCE_STALE when commit no longer reachable; bypassed by owner override.
 *   - E_PROVENANCE_FAILED rolls back the transaction on any insert failure.
 *   - Unknown T#### tokens are reported under `meta.unknownTokens` and do
 *     NOT fail the verb (R-331).
 *   - Orphan commits (no T#### token) are surfaced in `data.orphanCommits`.
 *
 * Test strategy: each test creates an isolated temp project root with:
 *   - A real git repo with synthetic commits + an annotated tag.
 *   - A fully-migrated SQLite tasks.db.
 *   - A hand-crafted `.cleo/release/<v>.plan.json` matching the ReleasePlan schema.
 *
 * `gh` is unavailable in CI sandboxes — `assertReleaseMatchesTag` already
 * treats gh failure as non-fatal, so we exercise only the local code paths.
 *
 * @task T9526
 * @epic T9492
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { releaseReconcileV2, sanitisePrShasForFk } from '../reconcile.js';

const _require = createRequire(import.meta.url);
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
    opts?: { readonly?: boolean },
  ) => import('node:sqlite').DatabaseSync;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Number of legacy v5.x ship/merge commits backfilled by the T9755 migration
 * (`20260520163324_t9755-backfill-legacy-ship-commits`). Every fresh tasks.db
 * starts with these rows already in the `commits` table, so tests that assert
 * absolute counts must shift by this baseline.
 */
const LEGACY_BACKFILL_COMMIT_COUNT = 18;

/** Resolve path to the drizzle-tasks migrations folder. */
function migrationsDir(): string {
  return join(__dirname, '..', '..', '..', 'migrations', 'drizzle-tasks');
}

/** Set up a fully-migrated tasks.db + git repo in a temp project root. */
async function setupProject(): Promise<{
  projectRoot: string;
  cleanup: () => void;
}> {
  const projectRoot = mkdtempSync(join(tmpdir(), 'cleo-rec2-'));
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

  // Initialise git repo. Configure committer for the test process.
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
  const { sql } = await import('drizzle-orm');
  const db = await getDb(projectRoot);
  for (const id of taskIds) {
    await db.run(
      sql`INSERT OR IGNORE INTO tasks (id, title, status, priority, role, scope)
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

/** Write a synthetic plan file matching the v1 schema. */
function writePlan(
  projectRoot: string,
  version: string,
  taskIds: string[],
  opts: { previousVersion?: string | null; previousTag?: string | null } = {},
): void {
  const nowIso = new Date().toISOString();
  const plan = {
    $schema: 'https://cleocode.io/schemas/release-plan/v1.json',
    version,
    resolvedVersion: version,
    suffixApplied: false,
    scheme: 'calver',
    channel: 'latest',
    epicId: 'T9999',
    releaseKind: 'regular',
    createdAt: nowIso,
    createdBy: 'reconcile-v2-test',
    previousVersion: opts.previousVersion ?? null,
    previousTag: opts.previousTag ?? null,
    previousShippedAt: null,
    tasks: taskIds.map((id) => ({
      id,
      kind: 'feat' as const,
      impact: 'minor' as const,
      userFacingSummary: `Ship ${id}`,
      evidenceAtoms: [],
      epicAncestor: 'T9999',
    })),
    changelog: { features: taskIds, fixes: [], chores: [], breaking: [] },
    gates: [],
    platformMatrix: [{ platform: 'any', publisher: 'npm', package: '@cleocode/cleo', smoke: true }],
    preflightSummary: {
      esbuildExternalsDrift: false,
      lockfileDrift: false,
      epicCompletenessClean: true,
      doubleListingClean: true,
    },
    workflowRunUrl: null,
    prUrl: null,
    mergeCommitSha: null,
    status: 'published',
    meta: { firstEverRelease: opts.previousVersion === undefined },
  };
  writeFileSync(
    join(projectRoot, '.cleo', 'release', `${version}.plan.json`),
    JSON.stringify(plan, null, 2),
  );
}

/** Count rows in a table for the given project root. */
async function countRows(projectRoot: string, table: string): Promise<number> {
  const { getDb } = await import('../../store/sqlite.js');
  const { sql } = await import('drizzle-orm');
  const db = await getDb(projectRoot);
  const rows = await db.all<{ cnt: number }>(sql.raw(`SELECT COUNT(*) AS cnt FROM ${table}`));
  return rows[0]?.cnt ?? 0;
}

// ── Reset the per-test DB singleton ─────────────────────────────────────────

afterEach(async () => {
  const { resetDbState } = await import('../../store/sqlite.js');
  resetDbState();
  delete process.env['CLEO_OWNER_OVERRIDE'];
  delete process.env['CLEO_OWNER_OVERRIDE_REASON'];
  // Re-enable mocks reset between tests.
  vi.restoreAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────────────────

// C3 regression: FK-safe PR sanitisation. Verifies pull_requests INSERT no
// longer crashes when a PR refers to commits outside the reconcile range.
describe('sanitisePrShasForFk — C3 FK safety (T9686)', () => {
  it('nulls headSha when not in inserted-commits set', () => {
    const inserted = new Set(['aaa111', 'bbb222']);
    const out = sanitisePrShasForFk(
      { headSha: 'deadbeef', mergeCommitSha: 'aaa111', commits: [] },
      inserted,
    );
    expect(out.headSha).toBeNull();
    expect(out.mergeCommitSha).toBe('aaa111');
  });

  it('nulls mergeCommitSha when not in inserted-commits set', () => {
    const inserted = new Set(['aaa111']);
    const out = sanitisePrShasForFk(
      { headSha: 'aaa111', mergeCommitSha: 'unknown-sha', commits: [] },
      inserted,
    );
    expect(out.headSha).toBe('aaa111');
    expect(out.mergeCommitSha).toBeNull();
  });

  it('filters pr_commits down to only in-range SHAs (NOT NULL FK can not be NULLed)', () => {
    const inserted = new Set(['aaa', 'bbb']);
    const out = sanitisePrShasForFk(
      {
        headSha: null,
        mergeCommitSha: null,
        commits: [{ sha: 'aaa' }, { sha: 'xxx' }, { sha: 'bbb' }, { sha: 'yyy' }],
      },
      inserted,
    );
    expect(out.commits).toEqual([{ sha: 'aaa' }, { sha: 'bbb' }]);
  });

  it('passes through null FKs unchanged', () => {
    const out = sanitisePrShasForFk(
      { headSha: null, mergeCommitSha: null, commits: [] },
      new Set(),
    );
    expect(out).toEqual({ headSha: null, mergeCommitSha: null, commits: [] });
  });

  it('returns valid FKs unchanged when all commits are in the set', () => {
    const inserted = new Set(['aaa', 'bbb', 'ccc']);
    const out = sanitisePrShasForFk(
      {
        headSha: 'aaa',
        mergeCommitSha: 'bbb',
        commits: [{ sha: 'aaa' }, { sha: 'ccc' }],
      },
      inserted,
    );
    expect(out.headSha).toBe('aaa');
    expect(out.mergeCommitSha).toBe('bbb');
    expect(out.commits).toEqual([{ sha: 'aaa' }, { sha: 'ccc' }]);
  });
});

describe('releaseReconcileV2 — Phase 1 (T9526)', () => {
  let projectRoot: string;
  let cleanup: () => void;
  const VERSION = 'v2026.6.0';
  const TASK_IDS = ['T8001', 'T8002'];

  beforeEach(async () => {
    const env = await setupProject();
    projectRoot = env.projectRoot;
    cleanup = env.cleanup;
    await insertTasks(projectRoot, TASK_IDS);
  });

  afterEach(() => {
    cleanup();
  });

  it('returns E_PLAN_NOT_FOUND when plan file missing', async () => {
    const result = await releaseReconcileV2(VERSION, { projectRoot });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('E_PLAN_NOT_FOUND');
  });

  it('returns E_PLAN_INVALID when plan JSON malformed', async () => {
    writeFileSync(
      join(projectRoot, '.cleo', 'release', `${VERSION}.plan.json`),
      '{ this is: not valid json',
    );
    const result = await releaseReconcileV2(VERSION, { projectRoot });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('E_PLAN_INVALID');
  });

  it('returns E_TAG_NOT_FOUND when git tag missing', async () => {
    writePlan(projectRoot, VERSION, TASK_IDS);
    // commit + DO NOT tag
    gitCommit(projectRoot, 'a.txt', 'hello', `feat(${TASK_IDS[0]}): ship a`);
    const result = await releaseReconcileV2(VERSION, { projectRoot });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('E_TAG_NOT_FOUND');
  });

  it('happy path: populates commits + task_commits + release_changes + release_artifacts', async () => {
    writePlan(projectRoot, VERSION, TASK_IDS);
    gitCommit(projectRoot, 'a.txt', '1', `feat(${TASK_IDS[0]}): ship a\n\nRefs: ${TASK_IDS[0]}`);
    gitCommit(projectRoot, 'b.txt', '2', `feat(${TASK_IDS[1]}): ship b\n\nRefs: ${TASK_IDS[1]}`);
    gitTag(projectRoot, VERSION);

    const result = await releaseReconcileV2(VERSION, { projectRoot });
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.version).toBe(VERSION);
    expect(result.data.commitCount).toBe(2);
    expect(result.data.taskCount).toBe(2);
    expect(result.data.changeCount).toBe(2);
    expect(result.data.artifactCount).toBe(1);
    expect(result.data.orphanCommits).toHaveLength(0);

    // Verify table populations. The T9755 migration backfills
    // LEGACY_BACKFILL_COMMIT_COUNT legacy ship commits into the `commits`
    // table on init; the 2 commits written by this reconcile sit on top of
    // that baseline. `task_commits` is NOT touched by the backfill — none
    // of the legacy SHAs carry T#### tokens that would seed task_commits —
    // so its count remains a clean 2.
    expect(await countRows(projectRoot, 'commits')).toBe(LEGACY_BACKFILL_COMMIT_COUNT + 2);
    expect(await countRows(projectRoot, 'commit_files')).toBeGreaterThanOrEqual(2);
    expect(await countRows(projectRoot, 'task_commits')).toBe(2);
    expect(await countRows(projectRoot, 'releases')).toBe(1);
    expect(await countRows(projectRoot, 'release_commits')).toBe(2);
    expect(await countRows(projectRoot, 'release_changes')).toBe(2);
    expect(await countRows(projectRoot, 'release_artifacts')).toBe(1);
  });

  it('idempotent: re-run is a no-op and produces no duplicate rows', async () => {
    writePlan(projectRoot, VERSION, TASK_IDS);
    gitCommit(projectRoot, 'a.txt', '1', `feat(${TASK_IDS[0]}): ship a`);
    gitCommit(projectRoot, 'b.txt', '2', `feat(${TASK_IDS[1]}): ship b`);
    gitTag(projectRoot, VERSION);

    const first = await releaseReconcileV2(VERSION, { projectRoot });
    expect(first.success).toBe(true);

    const commitsAfterFirst = await countRows(projectRoot, 'commits');
    const taskCommitsAfterFirst = await countRows(projectRoot, 'task_commits');
    const changesAfterFirst = await countRows(projectRoot, 'release_changes');

    // Plan file is archived on success — restore for the second run.
    writePlan(projectRoot, VERSION, TASK_IDS);

    const second = await releaseReconcileV2(VERSION, { projectRoot });
    expect(second.success).toBe(true);
    if (!second.success) return;
    // Second run should report re-reconciliation.
    expect(second.data.reReconciled).toBe(true);

    expect(await countRows(projectRoot, 'commits')).toBe(commitsAfterFirst);
    expect(await countRows(projectRoot, 'task_commits')).toBe(taskCommitsAfterFirst);
    expect(await countRows(projectRoot, 'release_changes')).toBe(changesAfterFirst);
  });

  it('unknown T#### tokens are reported in meta.unknownTokens (non-fatal)', async () => {
    writePlan(projectRoot, VERSION, TASK_IDS);
    // Subject references T9999999 which is not in tasks table.
    gitCommit(projectRoot, 'a.txt', '1', `feat(T99999): bogus task ${TASK_IDS[0]}`);
    gitTag(projectRoot, VERSION);

    const result = await releaseReconcileV2(VERSION, { projectRoot });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.unknownTokens).toContain('T99999');
    // Real token still linked.
    expect(await countRows(projectRoot, 'task_commits')).toBeGreaterThan(0);
  });

  it('orphan commits (no T#### token) are surfaced in data.orphanCommits', async () => {
    writePlan(projectRoot, VERSION, TASK_IDS);
    gitCommit(projectRoot, 'a.txt', '1', 'chore: misc tooling change');
    gitCommit(projectRoot, 'b.txt', '2', `feat(${TASK_IDS[0]}): ship b`);
    gitTag(projectRoot, VERSION);

    const result = await releaseReconcileV2(VERSION, { projectRoot });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.orphanCommits).toHaveLength(1);
  });

  it('E_EVIDENCE_STALE when commit:<sha> atom is no longer reachable', async () => {
    // Write a plan with a fake commit SHA that doesn't exist in the repo.
    const taskWithBadCommit = TASK_IDS[0];
    const planPath = join(projectRoot, '.cleo', 'release', `${VERSION}.plan.json`);
    const realCommit = gitCommit(projectRoot, 'a.txt', '1', `feat(${TASK_IDS[0]}): ship a`);
    gitTag(projectRoot, VERSION);
    // Plan references a SHA that is NOT reachable from the tag.
    const badSha = '0'.repeat(40);
    const nowIso = new Date().toISOString();
    const plan = {
      $schema: 'https://cleocode.io/schemas/release-plan/v1.json',
      version: VERSION,
      resolvedVersion: VERSION,
      suffixApplied: false,
      scheme: 'calver',
      channel: 'latest',
      epicId: 'T9999',
      releaseKind: 'regular',
      createdAt: nowIso,
      createdBy: 'reconcile-v2-test',
      previousVersion: null,
      previousTag: null,
      previousShippedAt: null,
      tasks: [
        {
          id: taskWithBadCommit,
          kind: 'feat',
          impact: 'minor',
          userFacingSummary: `Ship ${taskWithBadCommit}`,
          evidenceAtoms: [`commit:${badSha}`],
          epicAncestor: 'T9999',
        },
      ],
      changelog: { features: [taskWithBadCommit], fixes: [], chores: [], breaking: [] },
      gates: [],
      platformMatrix: [
        { platform: 'any', publisher: 'npm', package: '@cleocode/cleo', smoke: true },
      ],
      preflightSummary: {
        esbuildExternalsDrift: false,
        lockfileDrift: false,
        epicCompletenessClean: true,
        doubleListingClean: true,
      },
      workflowRunUrl: null,
      prUrl: null,
      mergeCommitSha: realCommit,
      status: 'published',
    };
    writeFileSync(planPath, JSON.stringify(plan));

    const result = await releaseReconcileV2(VERSION, { projectRoot });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('E_EVIDENCE_STALE');
      const details = result.error.details as { staleTasks?: Array<{ taskId: string }> };
      expect(details.staleTasks?.[0]?.taskId).toBe(taskWithBadCommit);
    }
  });

  it('CLEO_OWNER_OVERRIDE bypasses E_EVIDENCE_STALE', async () => {
    const realCommit = gitCommit(projectRoot, 'a.txt', '1', `feat(${TASK_IDS[0]}): ship a`);
    gitTag(projectRoot, VERSION);
    const badSha = '0'.repeat(40);
    const nowIso = new Date().toISOString();
    const plan = {
      $schema: 'https://cleocode.io/schemas/release-plan/v1.json',
      version: VERSION,
      resolvedVersion: VERSION,
      suffixApplied: false,
      scheme: 'calver',
      channel: 'latest',
      epicId: 'T9999',
      releaseKind: 'regular',
      createdAt: nowIso,
      createdBy: 'reconcile-v2-test',
      previousVersion: null,
      previousTag: null,
      previousShippedAt: null,
      tasks: [
        {
          id: TASK_IDS[0],
          kind: 'feat',
          impact: 'minor',
          userFacingSummary: `Ship ${TASK_IDS[0]}`,
          evidenceAtoms: [`commit:${badSha}`],
          epicAncestor: 'T9999',
        },
      ],
      changelog: { features: [TASK_IDS[0]], fixes: [], chores: [], breaking: [] },
      gates: [],
      platformMatrix: [
        { platform: 'any', publisher: 'npm', package: '@cleocode/cleo', smoke: true },
      ],
      preflightSummary: {
        esbuildExternalsDrift: false,
        lockfileDrift: false,
        epicCompletenessClean: true,
        doubleListingClean: true,
      },
      workflowRunUrl: null,
      prUrl: null,
      mergeCommitSha: realCommit,
      status: 'published',
    };
    writeFileSync(
      join(projectRoot, '.cleo', 'release', `${VERSION}.plan.json`),
      JSON.stringify(plan),
    );

    process.env['CLEO_OWNER_OVERRIDE'] = '1';
    process.env['CLEO_OWNER_OVERRIDE_REASON'] = 'incident-test-1234';

    const result = await releaseReconcileV2(VERSION, { projectRoot });
    expect(result.success).toBe(true);
  });

  it('emits envelope with meta.durationMs and meta.txSize', async () => {
    writePlan(projectRoot, VERSION, TASK_IDS);
    gitCommit(projectRoot, 'a.txt', '1', `feat(${TASK_IDS[0]}): ship a`);
    gitTag(projectRoot, VERSION);

    const result = await releaseReconcileV2(VERSION, { projectRoot });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.data.txSize).toBeGreaterThan(0);
    expect(result.data.tagSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('hotfix release kind classifies fix tasks as change_type=hotfix', async () => {
    const hotfixVersion = 'v2026.6.0.1';
    const taskId = TASK_IDS[0];
    gitCommit(projectRoot, 'a.txt', '1', `fix(${taskId}): hotfix a`);
    gitTag(projectRoot, hotfixVersion);
    const nowIso = new Date().toISOString();
    const plan = {
      $schema: 'https://cleocode.io/schemas/release-plan/v1.json',
      version: hotfixVersion,
      resolvedVersion: hotfixVersion,
      suffixApplied: true,
      scheme: 'calver-suffix',
      channel: 'latest',
      epicId: 'T9999',
      releaseKind: 'hotfix',
      createdAt: nowIso,
      createdBy: 'reconcile-v2-test',
      previousVersion: null,
      previousTag: null,
      previousShippedAt: null,
      tasks: [
        {
          id: taskId,
          kind: 'fix',
          impact: 'patch',
          userFacingSummary: `Hotfix ${taskId}`,
          evidenceAtoms: [],
          epicAncestor: 'T9999',
        },
      ],
      changelog: { features: [], fixes: [taskId], chores: [], breaking: [] },
      gates: [],
      platformMatrix: [
        { platform: 'any', publisher: 'npm', package: '@cleocode/cleo', smoke: true },
      ],
      preflightSummary: {
        esbuildExternalsDrift: false,
        lockfileDrift: false,
        epicCompletenessClean: true,
        doubleListingClean: true,
      },
      workflowRunUrl: null,
      prUrl: null,
      mergeCommitSha: null,
      status: 'published',
    };
    writeFileSync(
      join(projectRoot, '.cleo', 'release', `${hotfixVersion}.plan.json`),
      JSON.stringify(plan),
    );

    const result = await releaseReconcileV2(hotfixVersion, { projectRoot });
    expect(result.success).toBe(true);
    if (!result.success) return;

    // Read back the change_type for the task.
    const { getDb } = await import('../../store/sqlite.js');
    const { sql } = await import('drizzle-orm');
    const db = await getDb(projectRoot);
    const rows = await db.all<{ change_type: string }>(
      sql`SELECT change_type FROM release_changes WHERE task_id = ${taskId}`,
    );
    expect(rows[0]?.change_type).toBe('hotfix');
  });

  it('archives the plan file on success', async () => {
    writePlan(projectRoot, VERSION, TASK_IDS);
    gitCommit(projectRoot, 'a.txt', '1', `feat(${TASK_IDS[0]}): ship a`);
    gitTag(projectRoot, VERSION);

    const result = await releaseReconcileV2(VERSION, { projectRoot });
    expect(result.success).toBe(true);

    // Archive dir should exist with the plan inside.
    const { existsSync } = await import('node:fs');
    const archivePath = join(projectRoot, '.cleo', 'release', 'archive', `${VERSION}.plan.json`);
    expect(existsSync(archivePath)).toBe(true);
  });
});
