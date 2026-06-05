/**
 * Post-cutover plan FK smoke test (DHQ-051 · T11818 — plan/open slice).
 *
 * Sibling of `reconcile-fk-cutover.test.ts` (T11659). `cleo release plan` UPSERTs
 * a `releases` row whose `epic_id` is a nullable FK → `tasks.id`. On a
 * consolidated dual-scope `cleo.db` (T11578 cutover) the bare `tasks` table is
 * empty — the live task store moved to `tasks_tasks`. For the `--tasks` scope
 * `plan.epicId` is the first task's `parentId` (a real `tasks.id`); for
 * `--epic` / `--saga` it is the epic / saga id. Any of those exist only in
 * `tasks_tasks`, so inserting them straight into `epic_id` violated the FK at
 * INSERT time and aborted the whole plan with a "FOREIGN KEY constraint failed"
 * `E_INTERNAL` (the same class as the reconcile DHQ-051 failure).
 *
 * The fix reuses the reconcile shim {@link ensureProvenanceTaskFkParents}: the
 * FK parent is backfilled in FK order (the referenced task is copied from
 * `tasks_tasks` into the bare `tasks` table) BEFORE the `releases` UPSERT, so
 * the row lands with `epic_id` populated. An epic that exists in neither table
 * stays unresolvable and `epic_id` is NULLed — never a hard-fail.
 *
 * ## Why this test forces `PRAGMA foreign_keys = ON`
 *
 * `getDb()` (sqlite.ts) disables FK enforcement under VITEST so existing
 * fixtures can seed without full referential integrity — which means the
 * pre-existing plan tests run with FKs OFF and CANNOT reproduce the production
 * failure. This test re-enables FK enforcement after setup (matching the
 * `reconcile-fk-cutover.test.ts` pattern) so the strict consolidated constraint
 * is actually exercised.
 *
 * @task T11818
 * @epic T11466
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReleasePlan } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __test__ } from '../plan.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Resolve path to the drizzle-tasks migrations folder. */
function migrationsDir(): string {
  return join(__dirname, '..', '..', '..', 'migrations', 'drizzle-tasks');
}

/** Set up a fully-migrated consolidated cleo.db + git repo in a temp project root. */
async function setupProject(): Promise<{ projectRoot: string; cleanup: () => void }> {
  const projectRoot = mkdtempSync(join(tmpdir(), 'cleo-plan-fk-'));
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
  // `tasks` / `releases` FK family) — `getDb()` later layers the prefixed
  // `tasks_tasks` consolidated tables on top of the same handle.
  const { createRequire } = await import('node:module');
  const _require = createRequire(import.meta.url);
  const { DatabaseSync } = _require('node:sqlite') as {
    DatabaseSync: new (path: string) => import('node:sqlite').DatabaseSync;
  };
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
 * The bare `tasks` table — the physical FK parent of `releases.epic_id` — is
 * left EMPTY, which is exactly the production split-brain that triggers the FK
 * violation when FK enforcement is ON.
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

/** Build a minimal v1 ReleasePlan with `epicId` set to the given task. */
function makePlan(version: string, epicId: string): ReleasePlan {
  const nowIso = new Date().toISOString();
  return {
    $schema: 'https://cleocode.io/schemas/release-plan/v1.json',
    version,
    resolvedVersion: version,
    suffixApplied: false,
    scheme: 'calver',
    channel: 'latest',
    epicId,
    releaseKind: 'regular',
    createdAt: nowIso,
    createdBy: 'plan-fk-cutover-test',
    previousVersion: null,
    previousTag: null,
    previousShippedAt: null,
    tasks: [
      {
        id: epicId,
        kind: 'feat',
        impact: 'minor',
        userFacingSummary: `Ship ${epicId}`,
        evidenceAtoms: [],
        epicAncestor: epicId,
      },
    ],
    changelog: { features: [epicId], fixes: [], chores: [], breaking: [] },
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
    status: 'planned',
    meta: { firstEverRelease: true },
  };
}

/** Read the `releases` row for a version (epic_id projection). */
async function readReleaseEpicId(
  projectRoot: string,
  version: string,
): Promise<{ count: number; epicId: string | null }> {
  const { getDb } = await import('../../store/sqlite.js');
  const { sql } = await import('drizzle-orm');
  const db = await getDb(projectRoot);
  const rows = await db.all<{ epic_id: string | null }>(
    sql`SELECT epic_id FROM releases WHERE version = ${version}`,
  );
  return { count: rows.length, epicId: rows[0]?.epic_id ?? null };
}

afterEach(async () => {
  const { resetDbState } = await import('../../store/sqlite.js');
  resetDbState();
});

describe('release plan upsertReleasesRow — post-cutover FK safety (DHQ-051 · T11818)', () => {
  let projectRoot: string;
  let cleanup: () => void;
  const VERSION = 'v2026.6.6';
  const TASK_ID = 'T8801';

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

  it('does NOT throw a FK-constraint error under strict FK enforcement (the DHQ-051 plan repro)', async () => {
    const plan = makePlan(VERSION, TASK_ID);

    // Before the fix this threw "FOREIGN KEY constraint failed" on the
    // `releases.epic_id` insert. It must now succeed.
    await expect(__test__.upsertReleasesRow(plan, 'latest', projectRoot)).resolves.toBeUndefined();
  });

  it('backfills the FK parent so the releases row keeps its epic_id (not NULLed)', async () => {
    const plan = makePlan(VERSION, TASK_ID);
    await __test__.upsertReleasesRow(plan, 'latest', projectRoot);

    const { count, epicId } = await readReleaseEpicId(projectRoot, VERSION);
    expect(count).toBe(1);
    // The FK-ordered parent shim made the epic resolvable → epic_id is preserved.
    expect(epicId).toBe(TASK_ID);

    // The FK parent (bare `tasks`) now holds exactly the shimmed row.
    const { getDb } = await import('../../store/sqlite.js');
    const { sql } = await import('drizzle-orm');
    const db = await getDb(projectRoot);
    const fkParentRows = await db.all<{ id: string }>(
      sql`SELECT id FROM tasks WHERE id = ${TASK_ID}`,
    );
    expect(fkParentRows).toHaveLength(1);
  });

  it('NULLs epic_id (does not abort) when the epic exists in NEITHER table', async () => {
    // An epicId that is not a known task anywhere — e.g. the `--tasks` literal
    // fallback `'explicit-tasks'`, or a task absent from both stores. It is not
    // FK-resolvable, so epic_id must be NULLed and the plan row still written.
    const plan = makePlan(VERSION, 'explicit-tasks');

    await expect(__test__.upsertReleasesRow(plan, 'latest', projectRoot)).resolves.toBeUndefined();

    const { count, epicId } = await readReleaseEpicId(projectRoot, VERSION);
    expect(count).toBe(1);
    expect(epicId).toBeNull();
  });

  it('writes epic_id directly when the bare tasks parent ALREADY contains the epic', async () => {
    // Exodus-populated-both case: the bare `tasks` parent already has the row,
    // so no shim is needed and epic_id is written directly.
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

    const plan = makePlan(VERSION, TASK_ID);
    await __test__.upsertReleasesRow(plan, 'latest', projectRoot);

    const { count, epicId } = await readReleaseEpicId(projectRoot, VERSION);
    expect(count).toBe(1);
    expect(epicId).toBe(TASK_ID);
  });

  it('is idempotent on re-run with identical inputs', async () => {
    const plan = makePlan(VERSION, TASK_ID);
    await __test__.upsertReleasesRow(plan, 'latest', projectRoot);
    await __test__.upsertReleasesRow(plan, 'latest', projectRoot);

    const { count, epicId } = await readReleaseEpicId(projectRoot, VERSION);
    expect(count).toBe(1);
    expect(epicId).toBe(TASK_ID);
  });
});
