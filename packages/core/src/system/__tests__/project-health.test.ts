/**
 * Unit tests for the cross-project health probe module.
 *
 * Covers the full matrix from the task spec:
 *   - Healthy DB (passes PRAGMA integrity_check).
 *   - Corrupted DB (random bytes written after the SQLite header).
 *   - Missing file.
 *   - Missing project directory (unreachable).
 *   - Empty project directory (unknown).
 *   - WAL sidecar detection.
 *   - Registry write-back behaviour.
 *
 * @task T-PROJECT-HEALTH
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetDbState } from '../../store/sqlite.js';
import { createSqliteDataAccessor } from '../../store/sqlite-data-accessor.js';
import {
  checkAllRegisteredProjects,
  checkGlobalHealth,
  checkProjectHealth,
  probeDb,
} from '../project-health.js';

const _require = createRequire(import.meta.url);
const { DatabaseSync } = _require('node:sqlite') as typeof import('node:sqlite');

/** Create a small, valid SQLite database at `path` with one user_version. */
function makeHealthyDb(path: string, userVersion = 7): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA user_version=${userVersion}`);
    db.exec('CREATE TABLE sample(id INTEGER PRIMARY KEY, data TEXT)');
    db.prepare("INSERT INTO sample (id, data) VALUES (1, 'hello')").run();
  } finally {
    db.close();
  }
}

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'cleo-project-health-'));
  // Redirect CLEO_HOME so checkGlobalHealth / checkAllRegisteredProjects
  // touch a tmp directory (never the user's real ~/.local/share/cleo).
  process.env['CLEO_HOME'] = join(testDir, 'cleo-home');
  await mkdir(process.env['CLEO_HOME'], { recursive: true });
});

afterEach(async () => {
  resetDbState();
  try {
    const { resetNexusDbState } = await import('../../store/nexus-sqlite.js');
    resetNexusDbState();
  } catch {
    // nexus-sqlite may not be fully set up in every test.
  }
  delete process.env['CLEO_HOME'];
  await rm(testDir, { recursive: true, force: true });
});

describe('probeDb', () => {
  it('reports a healthy SQLite DB as integrityOk + openable', async () => {
    const dbPath = join(testDir, 'healthy.db');
    makeHealthyDb(dbPath, 42);

    const probe = await probeDb(dbPath);

    expect(probe.exists).toBe(true);
    expect(probe.readable).toBe(true);
    expect(probe.sqliteOpenable).toBe(true);
    expect(probe.integrityOk).toBe(true);
    expect(probe.walSidecarClean).toBe(true);
    expect(probe.schemaVersion).toBe(42);
    expect(probe.sizeBytes).toBeGreaterThan(0);
    expect(probe.error).toBeUndefined();
  });

  it('reports a missing file as non-existent with an error', async () => {
    const probe = await probeDb(join(testDir, 'does-not-exist.db'));

    expect(probe.exists).toBe(false);
    expect(probe.readable).toBe(false);
    expect(probe.sqliteOpenable).toBe(false);
    expect(probe.integrityOk).toBe(false);
    expect(probe.sizeBytes).toBe(-1);
    expect(probe.error).toBe('File not found');
  });

  it('reports a corrupted DB as integrity-failing', async () => {
    const dbPath = join(testDir, 'corrupt.db');
    makeHealthyDb(dbPath);
    // Scramble bytes in the middle of the file (past the SQLite header so
    // the file still parses but integrity_check fails).
    const { open } = await import('node:fs/promises');
    const handle = await open(dbPath, 'r+');
    try {
      const garbage = Buffer.alloc(256, 0xff);
      await handle.write(garbage, 0, 256, 4096);
    } finally {
      await handle.close();
    }

    const probe = await probeDb(dbPath);

    expect(probe.exists).toBe(true);
    expect(probe.readable).toBe(true);
    // After corruption, either the DB fails to open OR integrity_check fails.
    // Either outcome satisfies the "unhealthy" contract.
    const unhealthy = !probe.sqliteOpenable || !probe.integrityOk;
    expect(unhealthy).toBe(true);
  });
});

describe('checkProjectHealth', () => {
  it('returns overall=unreachable when the project dir does not exist', async () => {
    const ghostPath = join(testDir, 'no-such-project');
    const report = await checkProjectHealth(ghostPath, 'abcdef012345');

    expect(report.reachable).toBe(false);
    expect(report.overall).toBe('unreachable');
    expect(report.issues[0]).toContain('not reachable');
    expect(report.dbs.tasks.exists).toBe(false);
    expect(report.dbs.brain.exists).toBe(false);
    expect(report.dbs.conduit.exists).toBe(false);
  });

  it('returns overall=unknown when the dir exists but has no .cleo/', async () => {
    const projectPath = join(testDir, 'empty-project');
    await mkdir(projectPath, { recursive: true });

    const report = await checkProjectHealth(projectPath, 'empty0000001');

    expect(report.reachable).toBe(true);
    expect(report.overall).toBe('unknown');
  });

  it('returns overall=unknown when .cleo/ exists but no tasks.db', async () => {
    const projectPath = join(testDir, 'cleo-dir-only');
    await mkdir(join(projectPath, '.cleo'), { recursive: true });

    const report = await checkProjectHealth(projectPath, 'cleo00000002');

    expect(report.reachable).toBe(true);
    // .cleo/ exists but tasks.db doesn't — unknown (never initialized tasks).
    expect(report.overall).toBe('unknown');
  });

  it('returns overall=healthy when all DBs pass integrity_check', async () => {
    const projectPath = join(testDir, 'healthy-project');
    const cleoDir = join(projectPath, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    makeHealthyDb(join(cleoDir, 'tasks.db'), 1);
    makeHealthyDb(join(cleoDir, 'brain.db'), 1);
    makeHealthyDb(join(cleoDir, 'conduit.db'), 1);
    await writeFile(join(cleoDir, 'config.json'), JSON.stringify({ a: 1 }));
    await writeFile(join(cleoDir, 'project-info.json'), JSON.stringify({ projectId: 'abc' }));

    const report = await checkProjectHealth(projectPath, 'healthy00001');

    expect(report.reachable).toBe(true);
    expect(report.overall).toBe('healthy');
    expect(report.issues).toEqual([]);
    expect(report.dbs.tasks.integrityOk).toBe(true);
    expect(report.dbs.brain.integrityOk).toBe(true);
    expect(report.dbs.conduit.integrityOk).toBe(true);
    expect(report.files.config.parseable).toBe(true);
    expect(report.files.projectInfo.parseable).toBe(true);
  });

  it('returns overall=degraded when config.json is malformed', async () => {
    const projectPath = join(testDir, 'bad-config');
    const cleoDir = join(projectPath, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    makeHealthyDb(join(cleoDir, 'tasks.db'), 1);
    await writeFile(join(cleoDir, 'config.json'), '{ this is not valid json');

    const report = await checkProjectHealth(projectPath, 'badcfg000001');

    expect(report.reachable).toBe(true);
    expect(report.overall).toBe('degraded');
    expect(report.issues.some((i) => i.startsWith('config.json:'))).toBe(true);
    expect(report.files.config.parseable).toBe(false);
  });

  it('returns overall=degraded when tasks.db is corrupted', async () => {
    const projectPath = join(testDir, 'corrupt-tasks');
    const cleoDir = join(projectPath, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    makeHealthyDb(join(cleoDir, 'tasks.db'), 1);
    // Corrupt bytes past the header
    const { open } = await import('node:fs/promises');
    const handle = await open(join(cleoDir, 'tasks.db'), 'r+');
    try {
      const garbage = Buffer.alloc(256, 0xff);
      await handle.write(garbage, 0, 256, 4096);
    } finally {
      await handle.close();
    }

    const report = await checkProjectHealth(projectPath, 'corrupt00001');

    expect(report.reachable).toBe(true);
    expect(report.overall).toBe('degraded');
    expect(report.issues.length).toBeGreaterThan(0);
  });
});

describe('checkGlobalHealth', () => {
  it('returns overall=unknown when no global DBs exist', async () => {
    const report = await checkGlobalHealth();

    expect(report.cleoHome).toBe(process.env['CLEO_HOME']);
    expect(report.overall).toBe('unknown');
    expect(report.dbs.nexus.exists).toBe(false);
    expect(report.dbs.signaldock.exists).toBe(false);
  });

  it('returns overall=healthy when both global DBs are valid', async () => {
    const cleoHome = process.env['CLEO_HOME'] as string;
    makeHealthyDb(join(cleoHome, 'nexus.db'), 1);
    makeHealthyDb(join(cleoHome, 'signaldock.db'), 1);

    const report = await checkGlobalHealth();

    expect(report.overall).toBe('healthy');
    expect(report.dbs.nexus.integrityOk).toBe(true);
    expect(report.dbs.signaldock.integrityOk).toBe(true);
  });
});

describe('checkAllRegisteredProjects', () => {
  it('returns an empty projects list when nexus.db is not initialized', async () => {
    const report = await checkAllRegisteredProjects({
      updateRegistry: false,
      includeGlobal: false,
    });

    expect(report.projects).toEqual([]);
    expect(report.summary.totalProjects).toBe(0);
  });

  it('probes every registered project and reports summary counts', async () => {
    // Set up three projects: healthy, degraded, unreachable.
    const healthyPath = join(testDir, 'alpha');
    const degradedPath = join(testDir, 'beta');
    const unreachablePath = join(testDir, 'gamma-missing');

    for (const p of [healthyPath, degradedPath]) {
      await mkdir(join(p, '.cleo'), { recursive: true });
      resetDbState();
      const accessor = await createSqliteDataAccessor(p);
      await accessor.close();
      resetDbState();
    }

    // Register them in nexus.db WHILE BOTH are still healthy — nexusRegister
    // validates that tasks.db is readable. Corruption happens after register.
    const { nexusRegister, nexusInit } = await import('../../nexus/registry.js');
    await nexusInit();
    await nexusRegister(healthyPath, 'alpha');
    await nexusRegister(degradedPath, 'beta');

    // Now corrupt beta's tasks.db so the probe sees an unhealthy DB.
    {
      const { open } = await import('node:fs/promises');
      const handle = await open(join(degradedPath, '.cleo', 'tasks.db'), 'r+');
      try {
        const garbage = Buffer.alloc(256, 0xff);
        await handle.write(garbage, 0, 256, 4096);
      } finally {
        await handle.close();
      }
    }

    // For the unreachable case, insert a row directly since nexusRegister
    // refuses to register a non-existent path.
    const { getNexusDb } = await import('../../store/nexus-sqlite.js');
    const { projectRegistry } = await import('../../store/nexus-schema.js');
    const nexusDb = await getNexusDb();
    const now = new Date().toISOString();
    await nexusDb.insert(projectRegistry).values({
      projectId: 'gamma-ghost-id',
      projectHash: 'ghostghost01',
      projectPath: unreachablePath,
      name: 'gamma-ghost',
      registeredAt: now,
      lastSeen: now,
      healthStatus: 'unknown',
      healthLastCheck: null,
      permissions: 'read',
      lastSync: now,
      taskCount: 0,
      labelsJson: '[]',
      brainDbPath: join(unreachablePath, '.cleo', 'brain.db'),
      tasksDbPath: join(unreachablePath, '.cleo', 'tasks.db'),
      statsJson: '{}',
    });

    const report = await checkAllRegisteredProjects({
      updateRegistry: true,
      parallelism: 2,
      includeGlobal: false,
    });

    expect(report.summary.totalProjects).toBe(3);
    expect(report.summary.unreachable).toBe(1);
    // beta has corruption → degraded
    expect(report.summary.degraded).toBeGreaterThanOrEqual(1);

    // Verify write-back persisted the statuses
    const { eq } = await import('drizzle-orm');
    const rows = await nexusDb
      .select()
      .from(projectRegistry)
      .where(eq(projectRegistry.projectPath, unreachablePath));
    expect(rows[0]?.healthStatus).toBe('unreachable');
    expect(rows[0]?.healthLastCheck).not.toBeNull();
  });
});
