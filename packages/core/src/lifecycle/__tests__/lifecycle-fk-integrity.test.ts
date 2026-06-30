/**
 * Integration tests for lifecycle referential integrity under FK enforcement
 * ON (gh#1107 / T12017).
 *
 * The bug: the lifecycle drizzle symbols (`schema.lifecyclePipelines`, …) were
 * still bound to the EMPTY legacy bare tables (`lifecycle_pipelines`), whose
 * `task_id` FK points at the now-dead bare `tasks` table. Every lifecycle write
 * hit `FOREIGN KEY constraint failed`, so an epic could never advance past
 * `research`, which in turn blocked `cleo complete` on every child. The fix
 * rebinds the symbols + raw-SQL sites to the PREFIXED `tasks_lifecycle_*`
 * tables (which hold all real data and carry no bare-`tasks` FK).
 *
 * CRITICAL: the default test harness disables FK enforcement (`getDb` runs
 * `PRAGMA foreign_keys=OFF` when VITEST is set) — which is exactly why this bug
 * shipped uncaught. These tests force `PRAGMA foreign_keys = ON` after `getDb`
 * (the verify-provenance.test.ts pattern) so they exercise real referential
 * integrity. They FAIL against the pre-fix code and PASS after.
 *
 * @task T12017
 * @issue 1107
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteDataAccessor } from '@cleocode/core/internal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedTasks } from '../../store/__tests__/test-db-helper.js';

// Lifecycle stage scaffolding touches the ADR sync path — mock it out so these
// tests stay focused on referential integrity (mirrors stage-record-provenance).
const syncAdrsToDbMock = vi.hoisted(() =>
  vi.fn(async () => ({ inserted: 0, updated: 0, skipped: 0, errors: [] })),
);
const linkPipelineAdrMock = vi.hoisted(() =>
  vi.fn(async () => ({ linked: [], synced: 0, skipped: 0, errors: [] })),
);
vi.mock('../../adrs/sync.js', () => ({ syncAdrsToDb: syncAdrsToDbMock }));
vi.mock('../../adrs/link-pipeline.js', () => ({ linkPipelineAdr: linkPipelineAdrMock }));

describe('lifecycle FK integrity under foreign_keys=ON (gh#1107 / T12017)', () => {
  let testDir: string;
  let cleoDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'cleo-lifecycle-fk-'));
    cleoDir = join(testDir, '.cleo');
    await mkdir(join(cleoDir, 'rcasd'), { recursive: true });
    await mkdir(join(cleoDir, 'adrs'), { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;
    syncAdrsToDbMock.mockClear();
    linkPipelineAdrMock.mockClear();
  });

  afterEach(async () => {
    try {
      const { closeAllDatabases } = await import('../../store/sqlite.js');
      await closeAllDatabases();
    } catch {
      /* module may not be loaded */
    }
    delete process.env['CLEO_DIR'];
    await rm(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** Open the DB and force real FK enforcement (the harness defaults to OFF). */
  async function openWithFkOn() {
    const { getDb, getNativeDb } = await import('../../store/sqlite.js');
    const db = await getDb(testDir);
    const native = getNativeDb();
    if (!native) throw new Error('native db not initialized');
    native.exec('PRAGMA foreign_keys = ON');
    return { db, native };
  }

  it('recordStageProgress succeeds with FK ON and writes to the PREFIXED table only', async () => {
    const { recordStageProgress } = await import('../index.js');
    const { native } = await openWithFkOn();

    // Pre-fix this throws `FOREIGN KEY constraint failed` (bare table FK → empty bare tasks).
    await expect(
      recordStageProgress(testDir, { taskId: 'T9100', stage: 'research', status: 'in_progress' }),
    ).resolves.not.toThrow();

    const prefixed = native
      .prepare(`SELECT count(*) AS c FROM tasks_lifecycle_pipelines WHERE task_id = 'T9100'`)
      .get() as { c: number };
    const bare = native.prepare(`SELECT count(*) AS c FROM lifecycle_pipelines`).get() as {
      c: number;
    };

    expect(prefixed.c).toBe(1); // written to the prefixed table
    expect(bare.c).toBe(0); // nothing written to the dead bare table
  });

  it('orchestrate start initializes a pipeline that lifecycle show can read (initialized:true)', async () => {
    // Seed the epic so orchestrateStartup's loadTasks/getReadyTasks find it.
    const accessor = await createSqliteDataAccessor(testDir);
    await seedTasks(accessor, [
      {
        id: 'T9101',
        title: 'Foundation epic',
        type: 'epic',
        status: 'active',
        priority: 'high',
        createdAt: new Date().toISOString(),
      },
    ]);
    await accessor.close();

    await openWithFkOn();
    const { orchestrateStartup } = await import('../../orchestrate/lifecycle-ops.js');
    const { getLifecycleStatus } = await import('../index.js');

    const startResult = await orchestrateStartup('T9101', testDir);
    // Pre-fix: orchestrate start swallowed the FK error and returned success:true
    // while writing nothing. After the fix it genuinely initializes (or surfaces
    // a real failure via E_LIFECYCLE_INIT_FAILED instead of a false green).
    expect(startResult.success).toBe(true);

    const status = await getLifecycleStatus(testDir, { epicId: 'T9101' });
    // Pre-fix this read joined the EMPTY bare table → initialized:false forever.
    expect(status.initialized).toBe(true);
  });

  it('lifecycle stage can advance (research → completed) without an FK error', async () => {
    const { recordStageProgress } = await import('../index.js');
    await openWithFkOn();

    await expect(
      recordStageProgress(testDir, { taskId: 'T9102', stage: 'research', status: 'in_progress' }),
    ).resolves.not.toThrow();
    await expect(
      recordStageProgress(testDir, { taskId: 'T9102', stage: 'research', status: 'completed' }),
    ).resolves.not.toThrow();
    await expect(
      recordStageProgress(testDir, { taskId: 'T9102', stage: 'consensus', status: 'in_progress' }),
    ).resolves.not.toThrow();
  });
});
