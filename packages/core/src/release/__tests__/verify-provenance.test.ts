/**
 * Unit tests for {@link verifyProvenance} (T9529 / Phase 2 of T9493).
 *
 * Coverage:
 *   - Happy path: provenance graph populated → all 8 categories pass.
 *   - Missing release row → releaseExists fails, overall fail.
 *   - Orphan release_commits row → commitFkIntegrity fails.
 *   - Orphan task_commits row → taskCommitFkIntegrity fails.
 *   - Orphan release_changes row → releaseChangesIntegrity fails.
 *   - Evidence staleness: unreachable commit:<sha> atom → evidenceStaleness fails.
 *   - --all mode iterates the most-recent N releases.
 *   - --all mode with no releases returns E_PROVENANCE_INCOMPLETE.
 *
 * @task T9529
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
import { provenanceBackfill } from '../backfill.js';
import { verifyProvenance } from '../verify-provenance.js';

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
  const projectRoot = mkdtempSync(join(tmpdir(), 'cleo-vp-'));
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

  const dbPath = join(cleoDir, 'tasks.db');
  const nativeDb = new DatabaseSync(dbPath);
  const { drizzle } = await import('drizzle-orm/node-sqlite');
  const { reconcileJournal, migrateSanitized } = await import('../../store/migration-manager.js');
  const db = drizzle({ client: nativeDb });
  reconcileJournal(nativeDb, migrationsDir(), 'tasks', 'tasks');
  migrateSanitized(db, { migrationsFolder: migrationsDir() });
  nativeDb.close();

  execFileSync('git', ['init', '-q'], { cwd: projectRoot });
  execFileSync('git', ['config', 'user.email', 'test@cleo.dev'], { cwd: projectRoot });
  execFileSync('git', ['config', 'user.name', 'Cleo Test'], { cwd: projectRoot });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: projectRoot });

  return {
    projectRoot,
    cleanup: () => rmSync(projectRoot, { recursive: true, force: true }),
  };
}

async function insertTasks(projectRoot: string, taskIds: string[]): Promise<void> {
  const { getDb } = await import('../../store/sqlite.js');
  const db = await getDb(projectRoot);
  for (const id of taskIds) {
    await db.run(
      sql`INSERT OR IGNORE INTO tasks (id, title, status, priority, role, scope)
          VALUES (${id}, ${`Task ${id}`}, 'pending', 'medium', 'work', 'feature')`,
    );
  }
}

function gitCommit(projectRoot: string, file: string, content: string, subject: string): string {
  writeFileSync(join(projectRoot, file), content);
  execFileSync('git', ['add', file], { cwd: projectRoot });
  execFileSync('git', ['commit', '-q', '-m', subject], { cwd: projectRoot });
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf-8',
  }).trim();
}

function gitTag(projectRoot: string, version: string): void {
  execFileSync('git', ['tag', '-a', version, '-m', `Release ${version}`], { cwd: projectRoot });
}

/** Seed a single populated release for the happy-path test. */
async function seedOneRelease(projectRoot: string, taskId: string, tag: string): Promise<void> {
  await insertTasks(projectRoot, [taskId]);
  gitCommit(projectRoot, `${tag}-a.txt`, `${tag}-a`, `feat(${taskId}): ship ${taskId} for ${tag}`);
  gitCommit(projectRoot, `${tag}-b.txt`, `${tag}-b`, `chore: bump version to ${tag}`);
  gitTag(projectRoot, tag);
  const res = await provenanceBackfill({ since: '', projectRoot });
  if (!res.success) {
    throw new Error(`backfill failed: ${res.error.message}`);
  }
}

afterEach(async () => {
  const { resetDbState } = await import('../../store/sqlite.js');
  resetDbState();
  vi.restoreAllMocks();
});

describe('verifyProvenance — Phase 2 (T9529)', () => {
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

  // ──────────────────────────────────────────────────────────────────────
  // 1. Input validation — missing version + missing --all
  // ──────────────────────────────────────────────────────────────────────
  it('rejects calls with neither version nor --all', async () => {
    const result = await verifyProvenance({ projectRoot });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('E_INVALID_INPUT');
  });

  // ──────────────────────────────────────────────────────────────────────
  // 2. --all on empty graph returns E_PROVENANCE_INCOMPLETE
  // ──────────────────────────────────────────────────────────────────────
  it('--all on empty graph returns E_PROVENANCE_INCOMPLETE', async () => {
    const result = await verifyProvenance({ all: true, projectRoot });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('E_PROVENANCE_INCOMPLETE');
  });

  // ──────────────────────────────────────────────────────────────────────
  // 3. Missing release row → releaseExists fails
  // ──────────────────────────────────────────────────────────────────────
  it('returns E_PROVENANCE_INCOMPLETE when the release row is missing', async () => {
    const result = await verifyProvenance({ version: 'v0.0.0', projectRoot });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('E_PROVENANCE_INCOMPLETE');
    // The full envelope is preserved in error.details.data per the spec.
    const details = result.error.details as {
      data: { categories: { releaseExists: { passed: boolean; count: number } } };
    };
    expect(details.data.categories.releaseExists.passed).toBe(false);
    expect(details.data.categories.releaseExists.count).toBe(0);
  });

  // ──────────────────────────────────────────────────────────────────────
  // 4. Happy path — populated graph → every category passes
  // ──────────────────────────────────────────────────────────────────────
  it('happy path: all 8 categories pass for a freshly-reconciled release', async () => {
    await seedOneRelease(projectRoot, 'T2001', 'v2.0.0');

    const result = await verifyProvenance({ version: 'v2.0.0', projectRoot });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const c = result.data.categories;
    expect(c.releaseExists.passed).toBe(true);
    expect(c.releaseExists.count).toBe(1);
    expect(c.commitFkIntegrity.passed).toBe(true);
    expect(c.commitFkIntegrity.orphanCount).toBe(0);
    expect(c.taskCommitFkIntegrity.passed).toBe(true);
    expect(c.prCommitFkIntegrity.passed).toBe(true);
    expect(c.prTaskFkIntegrity.passed).toBe(true);
    expect(c.releaseChangesIntegrity.passed).toBe(true);
    expect(c.releaseArtifactsIntegrity.passed).toBe(true);
    expect(c.evidenceStaleness.passed).toBe(true);
    expect(result.data.passed).toBe(true);
    expect(result.data.releases).toHaveLength(1);
    expect(result.data.releases[0]?.version).toBe('v2.0.0');
  });

  // ──────────────────────────────────────────────────────────────────────
  // 5. Orphan release_commits — directly insert a row with a fake SHA
  // ──────────────────────────────────────────────────────────────────────
  it('detects orphan release_commits (FK to commits broken)', async () => {
    await seedOneRelease(projectRoot, 'T2002', 'v2.1.0');

    // Hand-insert a bad row that bypasses the FK by disabling PRAGMA briefly.
    const { getDb, getNativeDb } = await import('../../store/sqlite.js');
    const db = await getDb(projectRoot);
    const releaseRow = await db.all<{ id: string }>(
      sql`SELECT id FROM tasks_releases WHERE version = 'v2.1.0'`,
    );
    expect(releaseRow[0]).toBeDefined();
    const releaseId = releaseRow[0]?.id ?? '';

    const native = getNativeDb();
    if (!native) throw new Error('native db not initialized');
    native.exec('PRAGMA foreign_keys = OFF');
    native.exec(
      `INSERT INTO tasks_release_commits (release_id, commit_sha, position, is_first, is_last, is_release_chore)
       VALUES ('${releaseId.replace(/'/g, "''")}', '0000000000000000000000000000000000000000', 99, 0, 0, 0)`,
    );
    native.exec('PRAGMA foreign_keys = ON');

    const result = await verifyProvenance({ version: 'v2.1.0', projectRoot });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('E_PROVENANCE_INCOMPLETE');
    const details = result.error.details as {
      data: {
        categories: {
          commitFkIntegrity: { passed: boolean; orphanCount: number; orphans: string[] };
        };
      };
    };
    expect(details.data.categories.commitFkIntegrity.passed).toBe(false);
    expect(details.data.categories.commitFkIntegrity.orphanCount).toBe(1);
    expect(details.data.categories.commitFkIntegrity.orphans).toContain(
      '0000000000000000000000000000000000000000',
    );
  });

  // ──────────────────────────────────────────────────────────────────────
  // 6. Orphan task_commits — task_id references missing task
  // ──────────────────────────────────────────────────────────────────────
  it('detects orphan task_commits (task_id missing in tasks table)', async () => {
    await seedOneRelease(projectRoot, 'T2003', 'v2.2.0');

    const { getDb, getNativeDb } = await import('../../store/sqlite.js');
    const db = await getDb(projectRoot);
    const commitRow = await db.all<{ sha: string }>(
      sql`SELECT commit_sha AS sha FROM tasks_release_commits LIMIT 1`,
    );
    expect(commitRow[0]).toBeDefined();
    const commitSha = commitRow[0]?.sha ?? '';

    const native = getNativeDb();
    if (!native) throw new Error('native db not initialized');
    native.exec('PRAGMA foreign_keys = OFF');
    native.exec(
      `INSERT INTO tasks_task_commits (task_id, commit_sha, link_kind, link_source)
       VALUES ('T-DOES-NOT-EXIST', '${commitSha.replace(/'/g, "''")}', 'implements', 'commit-subject')`,
    );
    native.exec('PRAGMA foreign_keys = ON');

    const result = await verifyProvenance({ version: 'v2.2.0', projectRoot });
    expect(result.success).toBe(false);
    if (result.success) return;
    const details = result.error.details as {
      data: {
        categories: {
          taskCommitFkIntegrity: { passed: boolean; orphanCount: number; orphans: string[] };
        };
      };
    };
    expect(details.data.categories.taskCommitFkIntegrity.passed).toBe(false);
    expect(details.data.categories.taskCommitFkIntegrity.orphans).toContain('T-DOES-NOT-EXIST');
  });

  // ──────────────────────────────────────────────────────────────────────
  // 7. Orphan release_changes — task_id references missing task
  // ──────────────────────────────────────────────────────────────────────
  it('detects orphan release_changes (non-null task_id pointing at missing task)', async () => {
    await seedOneRelease(projectRoot, 'T2004', 'v2.3.0');

    const { getDb, getNativeDb } = await import('../../store/sqlite.js');
    const db = await getDb(projectRoot);
    const releaseRow = await db.all<{ id: string }>(
      sql`SELECT id FROM tasks_releases WHERE version = 'v2.3.0'`,
    );
    expect(releaseRow[0]).toBeDefined();
    const releaseId = releaseRow[0]?.id ?? '';

    const native = getNativeDb();
    if (!native) throw new Error('native db not initialized');
    native.exec('PRAGMA foreign_keys = OFF');
    native.exec(
      `INSERT INTO tasks_release_changes (id, release_id, task_id, change_type, summary, impact, classified_by, classified_at)
       VALUES ('orphan-rc-1', '${releaseId.replace(/'/g, "''")}', 'T-NOT-A-REAL-TASK', 'feature', 'orphan row', 'patch', 'auto', datetime('now'))`,
    );
    native.exec('PRAGMA foreign_keys = ON');

    const result = await verifyProvenance({ version: 'v2.3.0', projectRoot });
    expect(result.success).toBe(false);
    if (result.success) return;
    const details = result.error.details as {
      data: { categories: { releaseChangesIntegrity: { passed: boolean; orphanCount: number } } };
    };
    expect(details.data.categories.releaseChangesIntegrity.passed).toBe(false);
    expect(details.data.categories.releaseChangesIntegrity.orphanCount).toBeGreaterThanOrEqual(1);
  });

  // ──────────────────────────────────────────────────────────────────────
  // 8. Evidence staleness — plan with unreachable commit:<sha> atom
  // ──────────────────────────────────────────────────────────────────────
  it('detects evidence staleness when a commit atom is not reachable from the tag', async () => {
    await insertTasks(projectRoot, ['T2005']);
    gitCommit(projectRoot, 'v2.4.0-a.txt', 'a', `feat(T2005): ship for v2.4.0`);
    gitTag(projectRoot, 'v2.4.0');
    const backfill = await provenanceBackfill({ since: '', projectRoot });
    expect(backfill.success).toBe(true);

    // Overwrite the plan with a deliberately unreachable commit SHA atom. The
    // backfill writes the plan into .cleo/release/<tag>.plan.json — we mutate
    // it in place. Re-archive of the plan happens inside reconcile, so we
    // write to BOTH the live dir and the archive dir for safety.
    const plan = {
      $schema: 'https://cleocode.io/schemas/release-plan/v1.json',
      version: 'v2.4.0',
      resolvedVersion: 'v2.4.0',
      suffixApplied: false,
      scheme: 'calver',
      channel: 'latest',
      epicId: 'T2005',
      releaseKind: 'regular',
      createdAt: new Date().toISOString(),
      createdBy: 'test',
      previousVersion: null,
      previousTag: null,
      previousShippedAt: null,
      tasks: [
        {
          id: 'T2005',
          kind: 'feat',
          impact: 'patch',
          userFacingSummary: 'T2005 — synthetic',
          evidenceAtoms: ['commit:deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'],
          epicAncestor: 'T2005',
        },
      ],
      changelog: { features: ['T2005'], fixes: [], chores: [], breaking: [] },
      gates: [],
      platformMatrix: [
        { platform: 'any', publisher: 'npm', package: '@cleocode/cleo', smoke: false },
      ],
      preflightSummary: {
        esbuildExternalsDrift: false,
        lockfileDrift: false,
        epicCompletenessClean: true,
        doubleListingClean: true,
        preflightWarnings: ['synth'],
      },
      workflowRunUrl: null,
      prUrl: null,
      mergeCommitSha: null,
      status: 'published',
      meta: { firstEverRelease: true },
    };
    const planJson = JSON.stringify(plan, null, 2);
    mkdirSync(join(projectRoot, '.cleo', 'release'), { recursive: true });
    mkdirSync(join(projectRoot, '.cleo', 'release', 'archive'), { recursive: true });
    writeFileSync(join(projectRoot, '.cleo', 'release', 'v2.4.0.plan.json'), planJson);
    writeFileSync(join(projectRoot, '.cleo', 'release', 'archive', 'v2.4.0.plan.json'), planJson);

    const result = await verifyProvenance({ version: 'v2.4.0', projectRoot });
    expect(result.success).toBe(false);
    if (result.success) return;
    const details = result.error.details as {
      data: {
        categories: {
          evidenceStaleness: {
            passed: boolean;
            staleAtoms: Array<{ taskId: string; atom: string; reason: string }>;
          };
        };
      };
    };
    expect(details.data.categories.evidenceStaleness.passed).toBe(false);
    expect(details.data.categories.evidenceStaleness.staleAtoms.length).toBeGreaterThanOrEqual(1);
    expect(details.data.categories.evidenceStaleness.staleAtoms[0]?.taskId).toBe('T2005');
  });

  // ──────────────────────────────────────────────────────────────────────
  // 9. --all mode iterates the most-recent N releases
  // ──────────────────────────────────────────────────────────────────────
  it('--all mode verifies the most-recent N releases', async () => {
    await insertTasks(projectRoot, ['T3001', 'T3002', 'T3003']);
    for (const tag of ['v3.0.0', 'v3.1.0', 'v3.2.0']) {
      gitCommit(projectRoot, `${tag}-a.txt`, `${tag}-a`, `feat(T3001): ship for ${tag}`);
      gitCommit(projectRoot, `${tag}-b.txt`, `${tag}-b`, `chore: bump to ${tag}`);
      gitTag(projectRoot, tag);
    }
    const backfill = await provenanceBackfill({ since: '', projectRoot });
    expect(backfill.success).toBe(true);

    const result = await verifyProvenance({ all: true, limit: 2, projectRoot });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.releases.length).toBe(2);
    expect(result.data.passed).toBe(true);
  });
});
