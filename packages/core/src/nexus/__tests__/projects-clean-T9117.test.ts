/**
 * Tests for the T9117 additions to `cleanProjects`:
 *   - matchOrphaned    — match rows whose `project_path` no longer exists.
 *   - removeFs         — `rm -rf` matched paths after DB delete.
 *   - vacuum           — VACUUM nexus.db after delete to reclaim disk.
 *
 * Each case redirects `CLEO_HOME` to a tmp dir so the live `~/.cleo/nexus.db`
 * is never touched, and uses real `nexusInit` + `nexusRegister` to seed rows
 * via the actual schema rather than synthetic inserts.
 *
 * @task T9117
 */

import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetDbState } from '../../store/sqlite.js';
import { createSqliteDataAccessor } from '../../store/sqlite-data-accessor.js';
import { cleanProjects } from '../projects-clean.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'cleo-projects-clean-T9117-'));
  process.env['CLEO_HOME'] = join(testDir, 'cleo-home');
  await mkdir(process.env['CLEO_HOME'], { recursive: true });
});

afterEach(async () => {
  resetDbState();
  try {
    const { resetNexusDbState } = await import('../../store/nexus-sqlite.js');
    resetNexusDbState();
  } catch {
    // not all tests reach init
  }
  delete process.env['CLEO_HOME'];
  // maxRetries: Windows WAL sidecar files (.db-shm/.db-wal) stay locked
  // briefly after close(). 5 retries × 500 ms = 2.5 s max wait.
  await rm(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

/** Register two real-on-disk projects + one ghost (path never created). */
async function seedThreeProjects(): Promise<{
  alpha: string;
  beta: string;
  ghost: string;
}> {
  const alpha = join(testDir, 'alpha');
  const beta = join(testDir, 'beta');
  const ghost = join(testDir, 'ghost-missing');

  for (const p of [alpha, beta]) {
    await mkdir(join(p, '.cleo'), { recursive: true });
    resetDbState();
    const acc = await createSqliteDataAccessor(p);
    await acc.close();
    resetDbState();
  }

  const { nexusRegister, nexusInit } = await import('../registry.js');
  await nexusInit();
  await nexusRegister(alpha, 'alpha');
  await nexusRegister(beta, 'beta');

  // Insert the ghost row directly — nexusRegister refuses non-existent paths.
  const { getNexusDb } = await import('../../store/nexus-sqlite.js');
  const { projectRegistry } = await import('../../store/schema/nexus-schema.js');
  const db = await getNexusDb();
  const now = new Date().toISOString();
  await db.insert(projectRegistry).values({
    projectId: 'ghost-id',
    projectHash: 'ghostghostxx',
    projectPath: ghost,
    name: 'ghost',
    registeredAt: now,
    lastSeen: now,
    healthStatus: 'unknown',
    healthLastCheck: null,
    permissions: 'read',
    lastSync: now,
    taskCount: 0,
    labelsJson: '[]',
    brainDbPath: null,
    tasksDbPath: null,
    lastIndexed: null,
    nodeCount: 0,
    relationCount: 0,
    fileCount: 0,
  });

  return { alpha, beta, ghost };
}

describe('cleanProjects — T9117 matchOrphaned', () => {
  it('matches rows whose project_path no longer exists on disk', async () => {
    const { ghost } = await seedThreeProjects();

    const dryRun = await cleanProjects({ dryRun: true, matchOrphaned: true });
    expect(dryRun.matched).toBe(1);
    expect(dryRun.sample[0]).toBe(ghost);
    expect(dryRun.purged).toBe(0);
  });

  it('purges only the orphan row and leaves real projects intact', async () => {
    const { alpha, beta, ghost } = await seedThreeProjects();

    const result = await cleanProjects({ dryRun: false, matchOrphaned: true });
    expect(result.purged).toBe(1);
    expect(result.remaining).toBe(2);

    // Alpha + beta still exist on disk and in DB
    expect(existsSync(alpha)).toBe(true);
    expect(existsSync(beta)).toBe(true);
    // Ghost was never on disk
    expect(existsSync(ghost)).toBe(false);
  });

  it('counts as a criterion (no NoCriteriaError when only matchOrphaned set)', async () => {
    await seedThreeProjects();
    await expect(cleanProjects({ dryRun: true, matchOrphaned: true })).resolves.toBeDefined();
  });
});

describe('cleanProjects — T9117 removeFs', () => {
  it('rm -rf matched paths after DB delete (with --include-tests)', async () => {
    // Create a fake test-fixture-shaped dir matching the TESTS_RE preset.
    const fixturePath = join(testDir, 'tmp', 'cleo-fixture-junk');
    await mkdir(fixturePath, { recursive: true });
    await mkdir(join(fixturePath, '.cleo'), { recursive: true });
    resetDbState();
    const acc = await createSqliteDataAccessor(fixturePath);
    await acc.close();
    resetDbState();

    const { nexusRegister, nexusInit } = await import('../registry.js');
    await nexusInit();
    await nexusRegister(fixturePath, 'cleo-fixture-junk');
    // nexusRegister opens tasks.db (via isCleoProject→getAccessor) and leaves
    // the singleton open. On Windows the WAL sidecars stay OS-locked until the
    // connection is explicitly closed, so rm() inside cleanProjects would fail
    // with EBUSY. Close the singleton now before cleanProjects runs.
    resetDbState();

    expect(existsSync(fixturePath)).toBe(true);

    const result = await cleanProjects({
      dryRun: false,
      includeTests: true,
      removeFs: true,
    });

    expect(result.purged).toBe(1);
    expect(result.fsRemoved).toBe(1);
    expect(result.fsFailed).toBe(0);
    expect(existsSync(fixturePath)).toBe(false);
  });

  it('skips orphan rows whose path is already gone (no fs failures)', async () => {
    await seedThreeProjects(); // includes a ghost

    const result = await cleanProjects({
      dryRun: false,
      matchOrphaned: true,
      removeFs: true,
    });
    expect(result.purged).toBe(1);
    // Ghost path never existed on disk, so removeFs has nothing to remove
    // but should NOT count it as a failure.
    expect(result.fsRemoved).toBe(0);
    expect(result.fsFailed).toBe(0);
  });

  it('refuses to delete suspiciously short paths (defensive guard)', async () => {
    // Inject a row with a dangerously short path directly.
    process.env['CLEO_HOME'] = join(testDir, 'cleo-home');
    await mkdir(process.env['CLEO_HOME'], { recursive: true });
    const { nexusInit } = await import('../registry.js');
    await nexusInit();
    const { getNexusDb } = await import('../../store/nexus-sqlite.js');
    const { projectRegistry } = await import('../../store/schema/nexus-schema.js');
    const db = await getNexusDb();
    const now = new Date().toISOString();
    const dangerousPath = parse(tmpdir()).root;
    await db.insert(projectRegistry).values({
      projectId: 'dangerous-id',
      projectHash: 'shortshort01',
      projectPath: dangerousPath, // dangerously short root-ish path
      name: 'dangerous',
      registeredAt: now,
      lastSeen: now,
      healthStatus: 'unhealthy',
      healthLastCheck: null,
      permissions: 'read',
      lastSync: now,
      taskCount: 0,
      labelsJson: '[]',
      brainDbPath: null,
      tasksDbPath: null,
      lastIndexed: null,
      nodeCount: 0,
      relationCount: 0,
      fileCount: 0,
    });

    const result = await cleanProjects({
      dryRun: false,
      matchUnhealthy: true,
      removeFs: true,
    });
    // DB row purged but fs guard refused the rm
    expect(result.purged).toBe(1);
    expect(result.fsRemoved).toBe(0);
    expect(result.fsFailed).toBe(1);
    // root must still exist
    expect(existsSync(dangerousPath)).toBe(true);
    expect(statSync(dangerousPath).isDirectory()).toBe(true);
  });
});

describe('cleanProjects — T9117 vacuum', () => {
  it('runs VACUUM and reports bytesFreed (>= 0) after a non-trivial purge', async () => {
    // Seed enough rows to make VACUUM observable. 50 small rows is plenty.
    const { nexusInit } = await import('../registry.js');
    await nexusInit();
    const { getNexusDb } = await import('../../store/nexus-sqlite.js');
    const { projectRegistry } = await import('../../store/schema/nexus-schema.js');
    const db = await getNexusDb();
    const now = new Date().toISOString();
    for (let i = 0; i < 50; i++) {
      await db.insert(projectRegistry).values({
        projectId: `bulk-id-${i}`,
        projectHash: `bulkhash${String(i).padStart(4, '0')}`,
        projectPath: join(testDir, '.temp', `bulk-${i}`),
        name: `bulk-${i}`,
        registeredAt: now,
        lastSeen: now,
        healthStatus: 'unknown',
        healthLastCheck: null,
        permissions: 'read',
        lastSync: now,
        taskCount: 0,
        labelsJson: '[]',
        brainDbPath: null,
        tasksDbPath: null,
        lastIndexed: null,
        nodeCount: 0,
        relationCount: 0,
        fileCount: 0,
      });
    }

    const result = await cleanProjects({
      dryRun: false,
      includeTemp: true,
      vacuum: true,
    });

    expect(result.purged).toBe(50);
    expect(result.vacuumBytesFreed).toBeDefined();
    expect(result.vacuumBytesFreed).toBeGreaterThanOrEqual(0);
  });
});
