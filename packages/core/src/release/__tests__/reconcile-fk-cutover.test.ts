/**
 * Post-cutover reconcile FK smoke test (DHQ-051 · T11659).
 *
 * Regression guard for the FK-violation that broke `cleo release reconcile`
 * against a consolidated dual-scope `cleo.db` (T11578 cutover). The provenance
 * `task_id` foreign keys (`task_commits`, `pr_tasks`, `releases.epic_id`,
 * `release_changes.task_id`) reference the BARE `tasks` table, which is empty
 * after the cutover — the live task store moved to `tasks_tasks`. A task valid
 * in the runtime store but absent from the FK parent used to abort the entire
 * reconcile with `E_PROVENANCE_FAILED` (same class as DHQ-045).
 *
 * The fix reconciles the FK parent in FK order (parent-before-child): missing
 * parent rows are copied from `tasks_tasks` into the FK parent table BEFORE the
 * child provenance rows are written, so the links land AND the FK is satisfied.
 * A task that exists in neither table stays unresolvable and its single link is
 * skipped-with-warn / NULLed — never the whole reconcile.
 *
 * ## Why this test forces `PRAGMA foreign_keys = ON`
 *
 * `getDb()` (sqlite.ts) disables FK enforcement under VITEST so existing
 * fixtures can seed without full referential integrity — which means every
 * pre-existing reconcile test runs with FKs OFF and CANNOT reproduce the
 * production failure. This test re-enables FK enforcement after setup,
 * matching the established `verify-provenance.test.ts` pattern, so the strict
 * consolidated constraint is actually exercised.
 *
 * @task T11659
 * @epic T11466
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { releaseReconcileV2 } from '../reconcile.js';

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

/** Set up a fully-migrated consolidated cleo.db + git repo in a temp project root. */
async function setupProject(): Promise<{ projectRoot: string; cleanup: () => void }> {
  const projectRoot = mkdtempSync(join(tmpdir(), 'cleo-rec-fk-'));
  const cleoDir = join(projectRoot, '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  mkdirSync(join(cleoDir, 'release'), { recursive: true });

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

  // Apply legacy drizzle-tasks migrations to create the full bare schema (the
  // `tasks` / `task_commits` / `commits` FK family) — `getDb()` later layers
  // the prefixed `tasks_tasks` consolidated tables on top of the same handle.
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

/**
 * Seed a task into the PREFIXED consolidated table ONLY (post-cutover topology).
 * The bare `tasks` table — the physical FK parent of the provenance `task_id`
 * columns — is left EMPTY, which is exactly the production split-brain that
 * triggers the FK violation when FK enforcement is ON.
 */
async function seedConsolidatedTaskOnly(projectRoot: string, taskId: string): Promise<void> {
  const { getDb } = await import('../../store/sqlite.js');
  const { sql } = await import('drizzle-orm');
  const db = await getDb(projectRoot);
  await db.run(
    sql`INSERT OR IGNORE INTO tasks_tasks (id, title, status, priority, role, scope)
        VALUES (${taskId}, ${`Task ${taskId}`}, 'pending', 'medium', 'work', 'feature')`,
  );
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

/** Annotated-tag the current HEAD as `<version>`. */
function gitTag(projectRoot: string, version: string): void {
  execFileSync('git', ['tag', '-a', version, '-m', `Release ${version}`], { cwd: projectRoot });
}

/** Write a synthetic plan file matching the v1 schema. */
function writePlan(
  projectRoot: string,
  version: string,
  taskIds: string[],
  changesetIds: string[] = [],
): void {
  const nowIso = new Date().toISOString();
  const plan = {
    $schema: 'https://cleocode.io/schemas/release-plan/v1.json',
    version,
    resolvedVersion: version,
    suffixApplied: false,
    scheme: 'calver',
    channel: 'latest',
    epicId: taskIds[0] ?? 'T9999',
    releaseKind: 'regular',
    createdAt: nowIso,
    createdBy: 'reconcile-fk-cutover-test',
    previousVersion: null,
    previousTag: null,
    previousShippedAt: null,
    tasks: taskIds.map((id) => ({
      id,
      kind: 'feat' as const,
      impact: 'minor' as const,
      userFacingSummary: `Ship ${id}`,
      evidenceAtoms: [],
      epicAncestor: taskIds[0] ?? 'T9999',
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
    meta: {
      firstEverRelease: true,
      ...(changesetIds.length > 0 ? { changesetIds } : {}),
    },
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

/**
 * Re-enable FK enforcement on the live `cleo.db` handle. `getDb()` forces
 * `foreign_keys=OFF` under VITEST; flipping it back ON reproduces the strict
 * consolidated constraint that fires in production.
 */
async function enableForeignKeys(): Promise<void> {
  const { getNativeDb } = await import('../../store/sqlite.js');
  const native = getNativeDb();
  if (!native) throw new Error('native db not initialized');
  native.exec('PRAGMA foreign_keys = ON');
}

afterEach(async () => {
  const { resetDbState } = await import('../../store/sqlite.js');
  resetDbState();
});

describe('releaseReconcileV2 — post-cutover FK safety (DHQ-051 · T11659)', () => {
  let projectRoot: string;
  let cleanup: () => void;
  const VERSION = 'v2026.7.0';
  const TASK_ID = 'T8101';

  beforeEach(async () => {
    const env = await setupProject();
    projectRoot = env.projectRoot;
    cleanup = env.cleanup;
    // Seed the task into the consolidated table ONLY — the bare `tasks` FK
    // parent starts EMPTY, recreating the production split-brain.
    await seedConsolidatedTaskOnly(projectRoot, TASK_ID);
    await enableForeignKeys();
  });

  afterEach(() => {
    cleanup();
  });

  it('does NOT throw E_PROVENANCE_FAILED under strict FK enforcement (the DHQ-051 repro)', async () => {
    writePlan(projectRoot, VERSION, [TASK_ID]);
    gitCommit(projectRoot, 'a.txt', '1', `feat(${TASK_ID}): ship a\n\nRefs: ${TASK_ID}`);
    gitTag(projectRoot, VERSION);

    const result = await releaseReconcileV2(VERSION, { projectRoot });

    // Before the fix this aborted with E_PROVENANCE_FAILED on the `task_commits`
    // FK. It must now succeed.
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(
        `reconcile failed: ${result.error.code} — ${result.error.message} (table=${JSON.stringify((result.error.details as { table?: string })?.table)})`,
      );
    }
  });

  it('backfills the FK parent in FK order so task_commits links are PRESERVED, not dropped', async () => {
    writePlan(projectRoot, VERSION, [TASK_ID]);
    gitCommit(projectRoot, 'a.txt', '1', `feat(${TASK_ID}): ship a`);
    gitTag(projectRoot, VERSION);

    const result = await releaseReconcileV2(VERSION, { projectRoot });
    expect(result.success).toBe(true);
    if (!result.success) return;

    // All provenance tables backfill.
    expect(await countRows(projectRoot, 'releases')).toBe(1);
    expect(await countRows(projectRoot, 'release_commits')).toBeGreaterThanOrEqual(1);
    expect(await countRows(projectRoot, 'release_changes')).toBe(1);
    expect(await countRows(projectRoot, 'release_artifacts')).toBe(1);

    // The FK-ordered parent shim made the task resolvable → the task_commits
    // link IS written (provenance preserved) and the task is NOT skipped.
    expect(await countRows(projectRoot, 'task_commits')).toBe(1);
    expect(result.data.skippedTaskRefs ?? []).not.toContain(TASK_ID);

    // release_changes keeps its task linkage (task_id NOT nulled).
    const { getDb } = await import('../../store/sqlite.js');
    const { sql } = await import('drizzle-orm');
    const db = await getDb(projectRoot);
    const changeRows = await db.all<{ task_id: string | null }>(
      sql`SELECT task_id FROM release_changes`,
    );
    expect(changeRows).toHaveLength(1);
    expect(changeRows[0]?.task_id).toBe(TASK_ID);

    // The FK parent (bare `tasks`) now holds exactly the shimmed row.
    const fkParentRows = await db.all<{ id: string }>(
      sql`SELECT id FROM tasks WHERE id = ${TASK_ID}`,
    );
    expect(fkParentRows).toHaveLength(1);
  });

  it('archives this release’s changesets to .changeset/shipped/ after a successful reconcile', async () => {
    writePlan(projectRoot, VERSION, [TASK_ID], ['ship-fk']);
    const changesetDir = join(projectRoot, '.changeset');
    mkdirSync(changesetDir, { recursive: true });
    writeFileSync(
      join(changesetDir, 'ship-fk.md'),
      `---\nid: ship-fk\ntasks: [${TASK_ID}]\nkind: feat\nsummary: Ship via FK-cutover path.\n---\n`,
    );

    gitCommit(projectRoot, 'a.txt', '1', `feat(${TASK_ID}): ship a`);
    gitTag(projectRoot, VERSION);

    const result = await releaseReconcileV2(VERSION, { projectRoot });
    expect(result.success).toBe(true);

    // Changeset archived under the version-scoped shipped/ dir — proving the
    // post-reconcile archival path is reached (it only runs when reconcile
    // does not abort).
    expect(existsSync(join(changesetDir, 'ship-fk.md'))).toBe(false);
    expect(existsSync(join(changesetDir, 'shipped', VERSION, 'ship-fk.md'))).toBe(true);
  });

  it('skips-with-warn (does not abort) when a VALID task cannot be shimmed into the FK parent', async () => {
    // Make the FK-parent shim copy FAIL for a task that IS valid in the runtime
    // store: seed a `tasks_tasks` row with `status='done'` (accepted there) — the
    // bare `tasks` table's T877 invariant trigger RAISE(ABORT)s the shim
    // `INSERT … SELECT` because `pipeline_stage` is NULL (status=done requires a
    // terminal pipeline_stage). The id therefore stays unresolvable; the single
    // link is skipped-with-warn and the reconcile must still succeed.
    const badId = 'T8199';
    const { getDb, getNativeDb } = await import('../../store/sqlite.js');
    const { sql } = await import('drizzle-orm');
    const db = await getDb(projectRoot);
    const native = getNativeDb();
    if (!native) throw new Error('native db not initialized');
    native.exec('PRAGMA foreign_keys = OFF');
    await db.run(
      sql`INSERT OR IGNORE INTO tasks_tasks (id, title, status, priority, role, scope)
          VALUES (${badId}, ${'done task'}, 'done', 'medium', 'work', 'feature')`,
    );
    native.exec('PRAGMA foreign_keys = ON');

    writePlan(projectRoot, VERSION, [badId]);
    gitCommit(projectRoot, 'a.txt', '1', `feat(${badId}): ship a\n\nRefs: ${badId}`);
    gitTag(projectRoot, VERSION);

    const result = await releaseReconcileV2(VERSION, { projectRoot });
    // Reconcile still SUCCEEDS — the single unresolvable link is skipped, the
    // run is not aborted.
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(
        `reconcile failed: ${result.error.code} — ${result.error.message} (table=${JSON.stringify((result.error.details as { table?: string })?.table)})`,
      );
    }
    expect(result.data.skippedTaskRefs).toContain(badId);
    // The dangling task_commits link was skipped (no FK violation).
    expect(await countRows(projectRoot, 'task_commits')).toBe(0);
    // release_changes row still exists with a NULLed task_id.
    const changeRows = await db.all<{ task_id: string | null }>(
      sql`SELECT task_id FROM release_changes`,
    );
    expect(changeRows).toHaveLength(1);
    expect(changeRows[0]?.task_id).toBeNull();
  });

  it('links task_commits when the FK parent (bare tasks) ALREADY contains the task', async () => {
    // Exodus-populated-both case: the bare `tasks` parent already has the row,
    // so no shim is needed and the link is written directly.
    const { getDb, getNativeDb } = await import('../../store/sqlite.js');
    const { sql } = await import('drizzle-orm');
    const db = await getDb(projectRoot);
    const native = getNativeDb();
    if (!native) throw new Error('native db not initialized');
    native.exec('PRAGMA foreign_keys = OFF');
    await db.run(
      sql`INSERT OR IGNORE INTO tasks (id, title, status, priority, role, scope)
          VALUES (${TASK_ID}, ${`Task ${TASK_ID}`}, 'pending', 'medium', 'work', 'feature')`,
    );
    native.exec('PRAGMA foreign_keys = ON');

    writePlan(projectRoot, VERSION, [TASK_ID]);
    gitCommit(projectRoot, 'a.txt', '1', `feat(${TASK_ID}): ship a`);
    gitTag(projectRoot, VERSION);

    const result = await releaseReconcileV2(VERSION, { projectRoot });
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(await countRows(projectRoot, 'task_commits')).toBe(1);
    expect(result.data.skippedTaskRefs ?? []).not.toContain(TASK_ID);
  });
});
