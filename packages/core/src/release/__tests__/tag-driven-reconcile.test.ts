/**
 * Regression tests for T11977 / DHQ-080:
 * tag-driven `cleo release reconcile` synthesises a minimal plan when no
 * `.cleo/release/<version>.plan.json` exists but the git tag is present.
 *
 * Coverage:
 *   - (1) Tag present + NO plan → synthesis fires, provenance backfilled.
 *   - (2) Tag present + NO plan + `dryRun` → returns derivation without DB writes.
 *   - (3) Tag present + NO plan + CHANGELOG section → CHANGELOG tokens included.
 *   - (4) Tag present + existing plan → synthesis is SKIPPED (behaviour unchanged).
 *   - (5) No tag + no plan → returns E_PLAN_NOT_FOUND (original behaviour).
 *   - (6) Synthesised plan carries `meta.origin = 'tag-reconcile-synthesized'`.
 *   - (7) `synthesizePlanForReconcile` is idempotent — calling twice returns
 *         same token set.
 *
 * Test strategy mirrors reconcile-v2.test.ts:
 *   - Real temp git repo + fully-migrated tasks.db per test.
 *   - No `gh` (treated as non-fatal by assertReleaseMatchesTag).
 *
 * @task T11977
 * @epic T11679
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { releaseReconcileV2, synthesizePlanForReconcile } from '../reconcile.js';

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
  const projectRoot = mkdtempSync(join(tmpdir(), 'cleo-tag-rec-'));
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

  // Initialise git repo.
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

/** Write a synthetic plan file matching the ReleasePlan schema. */
function writePlan(projectRoot: string, version: string, taskIds: string[]): void {
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
    createdBy: 'tag-driven-test',
    previousVersion: null,
    previousTag: null,
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
    meta: { firstEverRelease: true },
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
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('tag-driven reconcile — T11977 / DHQ-080', () => {
  const VERSION = 'v2026.7.1';
  const TASK_IDS = ['T9001', 'T9002'];
  let projectRoot: string;
  let cleanup: () => void;

  beforeEach(async () => {
    const env = await setupProject();
    projectRoot = env.projectRoot;
    cleanup = env.cleanup;
    await insertTasks(projectRoot, TASK_IDS);
  });

  afterEach(() => {
    cleanup();
  });

  it('(1) tag present + no plan → synthesis fires, provenance tables backfilled', async () => {
    gitCommit(projectRoot, 'a.txt', '1', `feat(${TASK_IDS[0]}): ship a`);
    gitCommit(projectRoot, 'b.txt', '2', `feat(${TASK_IDS[1]}): ship b`);
    gitTag(projectRoot, VERSION);

    // No plan file written — tag-driven path.
    const planPath = join(projectRoot, '.cleo', 'release', `${VERSION}.plan.json`);
    expect(existsSync(planPath)).toBe(false);

    const result = await releaseReconcileV2(VERSION, { projectRoot, backfill: true });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Provenance tables must be populated.
    expect(await countRows(projectRoot, 'tasks_releases')).toBe(1);
    expect(await countRows(projectRoot, 'tasks_commits')).toBeGreaterThanOrEqual(2);
    expect(await countRows(projectRoot, 'tasks_release_changes')).toBeGreaterThanOrEqual(1);

    // Synthesis metadata must be present in the result.
    expect(result.data.synthesized).toBeDefined();
    expect(result.data.synthesized?.changelogSectionFound).toBe(false);
    expect(result.data.synthesized?.commitTaskCount).toBeGreaterThan(0);
  });

  it('(2) tag present + no plan + dryRun → derivation returned, NO DB writes', async () => {
    gitCommit(projectRoot, 'a.txt', '1', `feat(${TASK_IDS[0]}): dry run`);
    gitTag(projectRoot, VERSION);

    const baselineReleases = await countRows(projectRoot, 'tasks_releases');

    const result = await releaseReconcileV2(VERSION, { projectRoot, dryRun: true });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Dry-run flag echoed in result.
    expect(result.data.dryRun).toBe(true);

    // Synthesis metadata must be present.
    expect(result.data.synthesized).toBeDefined();

    // DB must be UNCHANGED (no rows inserted).
    expect(await countRows(projectRoot, 'tasks_releases')).toBe(baselineReleases);
    expect(await countRows(projectRoot, 'tasks_release_changes')).toBe(0);
  });

  it('(3) CHANGELOG section present → CHANGELOG task tokens included in synthesis', async () => {
    gitCommit(projectRoot, 'a.txt', '1', `feat(${TASK_IDS[0]}): ship a`);
    gitTag(projectRoot, VERSION);

    // Write a CHANGELOG.md with a section for VERSION that includes task IDs.
    const normalizedVersion = VERSION.startsWith('v') ? VERSION.slice(1) : VERSION;
    writeFileSync(
      join(projectRoot, 'CHANGELOG.md'),
      [
        `## [${normalizedVersion}] (2026-07-01)`,
        '',
        '### Added',
        '',
        `- Some feature with (${TASK_IDS[0]} / #42)`,
        `- Another feature (${TASK_IDS[1]}; #43)`,
        '',
        '## [2026.6.99] (2026-06-30)',
        '',
        '- Older release.',
      ].join('\n'),
    );

    const report = await synthesizePlanForReconcile(VERSION, projectRoot);

    // Both task IDs must appear in the changelog-derived set.
    expect(report.changelogSectionFound).toBe(true);
    expect(report.changelogTaskIds).toContain(TASK_IDS[0]);
    expect(report.changelogTaskIds).toContain(TASK_IDS[1]);

    // The synthesised plan's tasks must include both IDs.
    const planTaskIds = report.plan.tasks.map((t) => t.id);
    expect(planTaskIds).toContain(TASK_IDS[0]);
    expect(planTaskIds).toContain(TASK_IDS[1]);
  });

  it('(4) existing plan present → synthesis is SKIPPED (original reconcile behaviour)', async () => {
    writePlan(projectRoot, VERSION, TASK_IDS);
    gitCommit(projectRoot, 'a.txt', '1', `feat(${TASK_IDS[0]}): ship a`);
    gitTag(projectRoot, VERSION);

    const result = await releaseReconcileV2(VERSION, { projectRoot });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // No synthesized metadata — plan was loaded from disk.
    expect(result.data.synthesized).toBeUndefined();
    // Plan tasks were used (taskCount = 2).
    expect(result.data.taskCount).toBe(2);
  });

  it('(5) no tag + no plan → returns E_PLAN_NOT_FOUND (original error path)', async () => {
    // Neither a plan file nor a git tag.
    gitCommit(projectRoot, 'a.txt', '1', 'initial commit');
    // No gitTag() call.

    const result = await releaseReconcileV2(VERSION, { projectRoot });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('E_PLAN_NOT_FOUND');
    }
  });

  it('(6) synthesised plan carries meta.origin = tag-reconcile-synthesized', async () => {
    gitCommit(projectRoot, 'a.txt', '1', `feat(${TASK_IDS[0]}): ship a`);
    gitTag(projectRoot, VERSION);

    const report = await synthesizePlanForReconcile(VERSION, projectRoot);

    expect(report.plan.createdBy).toBe('tag-reconcile-synthesized');
    expect((report.plan.meta as Record<string, unknown>)?.['origin']).toBe(
      'tag-reconcile-synthesized',
    );
    expect(report.plan.preflightSummary.preflightWarnings).toContain('tag-reconcile-synthesized');
  });

  it('(7) synthesizePlanForReconcile is idempotent — same token set on second call', async () => {
    gitCommit(projectRoot, 'a.txt', '1', `feat(${TASK_IDS[0]}): ship a`);
    gitCommit(projectRoot, 'b.txt', '2', `feat(${TASK_IDS[1]}): ship b`);
    gitTag(projectRoot, VERSION);

    const report1 = await synthesizePlanForReconcile(VERSION, projectRoot);
    // Reset DB singleton so second call gets a fresh connection.
    const { resetDbState } = await import('../../store/sqlite.js');
    resetDbState();

    const report2 = await synthesizePlanForReconcile(VERSION, projectRoot);

    // Both calls must derive the same set of task IDs.
    expect(new Set(report1.commitTaskIds)).toEqual(new Set(report2.commitTaskIds));
    expect(report1.plan.tasks.length).toBe(report2.plan.tasks.length);
  });
});
