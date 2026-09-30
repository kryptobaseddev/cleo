/**
 * T12512 — registry reads surface errors instead of returning `[]` or `null`,
 * and "last probed" is separate from "last opened".
 *
 * Every case runs against a temp `CLEO_HOME` with its own caller project.
 *
 * @task T12512
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCleoHome } from '../../paths.js';
import { awaitBackgroundOps } from '../../store/background-ops.js';
import { getNexusNativeDb, getNexusRegistryDb } from '../../store/nexus-sqlite.js';
import { projectRegistry } from '../../store/schema/nexus-schema.js';
import { closeAllDatabases } from '../../store/sqlite.js';
import {
  markProjectOpened,
  markProjectsProbed,
  OPENED_WRITE_INTERVAL_MS,
  projectLastActivity,
  projectLastActivitySqlText,
} from '../project-activity.js';
import {
  NexusProjectAmbiguityError,
  nexusGetProject,
  nexusList,
  nexusProjectsFleet,
  nexusProjectsList,
  nexusRegister,
  nexusStatus,
  nexusSync,
  readRegistry,
  resetNexusDbState,
} from '../registry.js';
import { NexusRegistryReadError } from '../registry-errors.js';

let testDir: string;
let originalCwd: string;
let projectDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'nexus-read-errors-T12512-'));
  await mkdir(join(testDir, '.cleo'), { recursive: true });
  await mkdir(join(testDir, '.git'), { recursive: true });
  originalCwd = process.cwd();
  process.chdir(testDir);
  vi.stubEnv('CLEO_ROOT', testDir);
  vi.stubEnv('CLEO_PROJECT_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  const home = join(testDir, 'cleo-home');
  await mkdir(home, { recursive: true });
  vi.stubEnv('CLEO_HOME', home);
  vi.stubEnv('NEXUS_HOME', join(home, 'nexus'));
  vi.stubEnv('NEXUS_CACHE_DIR', join(home, 'nexus', 'cache'));
  projectDir = join(testDir, 'proj');
  await mkdir(join(projectDir, '.cleo'), { recursive: true });
  resetNexusDbState();
});

afterEach(async () => {
  await awaitBackgroundOps();
  resetNexusDbState();
  await closeAllDatabases();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.chdir(originalCwd);
  await rm(testDir, { recursive: true, force: true });
});

/** Break the registry the way a damaged store does: the table is gone. */
async function breakRegistry(): Promise<void> {
  await nexusList(); // open and migrate first
  const native = getNexusNativeDb();
  if (native === null) throw new Error('nexus handle not open');
  native.exec('DROP TABLE nexus_global.nexus_project_registry');
}

describe('AC1/AC3 — a corrupt registry read is a typed error, never [] or null', () => {
  it('nexusList, readRegistry and nexusGetProject reject with E_NEXUS_REGISTRY_READ', async () => {
    await breakRegistry();
    await expect(nexusList()).rejects.toBeInstanceOf(NexusRegistryReadError);
    await expect(readRegistry()).rejects.toBeInstanceOf(NexusRegistryReadError);
    await expect(nexusGetProject('anything')).rejects.toMatchObject({
      codeName: 'E_NEXUS_REGISTRY_READ',
    });
  });

  it('engine wrappers return the typed error envelope', async () => {
    await breakRegistry();
    for (const result of [
      await nexusProjectsList(),
      await nexusStatus(),
      await nexusProjectsFleet('', {}),
    ]) {
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_NEXUS_REGISTRY_READ');
      expect(result.error?.exitCode).toBe(75);
      expect(result.error?.message).toMatch(/Cannot read the project registry/);
    }
  });

  it('a global store that is not a database fails typed through the fleet view', async () => {
    const { getNexusRegistryDbPath } = await import('../../store/nexus-sqlite.js');
    await writeFile(
      getNexusRegistryDbPath(getCleoHome()),
      'this is not a sqlite database'.repeat(200),
    );
    const fleet = await nexusProjectsFleet('', {});
    expect(fleet.success).toBe(false);
    expect(fleet.error?.code).toBe('E_NEXUS_REGISTRY_READ');
  });

  it('an empty but readable registry is still an empty list, not an error', async () => {
    await expect(nexusList()).resolves.toEqual([]);
    await expect(nexusGetProject('nope')).resolves.toBeNull();
    const fleet = await nexusProjectsFleet('', {});
    expect(fleet.success).toBe(true);
    expect(fleet.data?.total).toBe(0);
  });
});

describe('AC1 — every other registry reader fails typed, never empty (T12512 follow-up)', () => {
  /** Assert an EngineResult failed with the typed registry error. */
  function expectTypedFailure(result: {
    success: boolean;
    error?: { code?: string | number; exitCode?: number; fix?: unknown };
  }): void {
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_NEXUS_REGISTRY_READ');
    expect(result.error?.exitCode).toBe(75);
    expect(result.error?.fix).toMatch(/cleo doctor/);
  }

  it('listRegistryParentRoots throws instead of returning [] (no guessed roots)', async () => {
    const { listRegistryParentRoots } = await import('../registry-roots.js');
    await expect(listRegistryParentRoots()).resolves.toEqual([]);
    await breakRegistry();
    await expect(listRegistryParentRoots()).rejects.toBeInstanceOf(NexusRegistryReadError);
  });

  it('projects scan never reports every project as unregistered, and never auto-registers', async () => {
    const { nexusProjectsScan, scanForProjects } = await import('../projects-scan.js');
    await breakRegistry();
    await expect(scanForProjects({ roots: [testDir], autoRegister: true })).rejects.toBeInstanceOf(
      NexusRegistryReadError,
    );
    expectTypedFailure(await nexusProjectsScan({ roots: testDir, autoRegister: true }));
  });

  it('projects clean fails typed instead of matching nothing', async () => {
    const { cleanProjects, nexusProjectsClean } = await import('../projects-clean.js');
    await breakRegistry();
    await expect(cleanProjects({ dryRun: true, includeTemp: true })).rejects.toBeInstanceOf(
      NexusRegistryReadError,
    );
    expectTypedFailure(await nexusProjectsClean({ dryRun: true, includeTemp: true }));
  });

  it('doctor projects (registry integrity) fails typed instead of an empty report', async () => {
    const { inspectProjectRegistry } = await import('../../doctor/projects.js');
    await breakRegistry();
    await expect(inspectProjectRegistry({ roots: [] })).rejects.toMatchObject({
      codeName: 'E_NEXUS_REGISTRY_READ',
      code: 75,
    });
  });

  it('cross-project search, discover and graph keep the typed code (not E_INTERNAL)', async () => {
    const { nexusDiscover, nexusSearch } = await import('../discover.js');
    const { invalidateGraphCache, nexusGraph } = await import('../deps.js');
    await breakRegistry();
    expectTypedFailure(await nexusSearch('anything*'));
    expectTypedFailure(await nexusDiscover('proj:T001'));
    invalidateGraphCache();
    expectTypedFailure(await nexusGraph());
  });

  it('the git-state probe fails typed on a store that is not a database', async () => {
    const { getNexusRegistryDbPath } = await import('../../store/nexus-sqlite.js');
    const { nexusProjectsStatus } = await import('../registry.js');
    await writeFile(
      getNexusRegistryDbPath(getCleoHome()),
      'this is not a sqlite database'.repeat(200),
    );
    expectTypedFailure(await nexusProjectsStatus('', {}));
  });

  it('the hygiene loop reports an unreadable registry instead of 0/0 healthy', async () => {
    const { runNexusIntegrityCheck } = await import('../../sentient/cross-project-hygiene.js');
    const healthy = await runNexusIntegrityCheck();
    expect(healthy.registryError).toBeUndefined();
    await breakRegistry();
    const broken = await runNexusIntegrityCheck();
    expect(broken.total).toBe(0);
    expect(broken.registryError).toMatch(/Cannot read the project registry/);
  });
});

describe('AC2 — probes write last_probed_at; only real use writes last_opened_at', () => {
  it('nexusSync moves last_probed_at and leaves last_seen and last_opened_at alone', async () => {
    await nexusRegister(projectDir, 'proj', 'read');
    const before = await nexusGetProject('proj');
    expect(before?.lastProbedAt).toBeNull();
    expect(before?.lastOpenedAt).toBeNull();
    await new Promise((r) => setTimeout(r, 5));
    await nexusSync('proj');
    const after = await nexusGetProject('proj');
    expect(after?.lastProbedAt).not.toBeNull();
    expect(after?.lastSeen).toBe(before?.lastSeen);
    expect(after?.lastOpenedAt).toBeNull();
  });

  it('a health check moves last_probed_at, not last_opened_at; a broken registry is reported', async () => {
    const { checkAllRegisteredProjects } = await import('../../system/project-health.js');
    await nexusRegister(projectDir, 'proj', 'read');
    const report = await checkAllRegisteredProjects({ includeGlobal: false });
    expect(report.registryError).toBeUndefined();
    const after = await nexusGetProject('proj');
    expect(after?.lastProbedAt).not.toBeNull();
    expect(after?.lastOpenedAt).toBeNull();

    await breakRegistry();
    const broken = await checkAllRegisteredProjects({ includeGlobal: false });
    expect(broken.projects).toEqual([]);
    expect(broken.registryError?.code).toBe('E_NEXUS_REGISTRY_READ');
    expect(broken.registryError?.exitCode).toBe(75);
    expect(broken.registryError?.fix).toMatch(/cleo doctor/);
  });

  it('markProjectOpened writes once per interval; markProjectsProbed never touches it', async () => {
    await nexusRegister(projectDir, 'proj', 'read');
    const id = (await nexusGetProject('proj'))?.projectId ?? '';
    const db = await getNexusRegistryDb(getCleoHome());
    const t0 = new Date('2026-09-29T10:00:00.000Z');
    expect(markProjectOpened(db, id, t0)).toBe('written');
    expect(markProjectOpened(db, id, new Date(t0.getTime() + 1_000))).toBe('throttled');
    expect(markProjectOpened(db, id, new Date(t0.getTime() + OPENED_WRITE_INTERVAL_MS + 1))).toBe(
      'written',
    );
    expect(markProjectOpened(db, 'no-such-project', t0)).toBe('unregistered');

    const probedAt = new Date('2026-09-29T11:00:00.000Z');
    expect(markProjectsProbed(db, [id, id], probedAt)).toBe(1);
    const row = db
      .select({ opened: projectRegistry.lastOpenedAt, probed: projectRegistry.lastProbedAt })
      .from(projectRegistry)
      .where(eq(projectRegistry.projectId, id))
      .get();
    expect(row).toEqual({
      opened: new Date(t0.getTime() + OPENED_WRITE_INTERVAL_MS + 1).toISOString(),
      probed: probedAt.toISOString(),
    });
  });
});

describe('one activity accessor: max(last_seen, last_opened_at, last_probed_at)', () => {
  it('projectLastActivity takes the newest, normalising datetime(now) values', () => {
    expect(
      projectLastActivity({
        lastSeen: '2026-01-01 00:00:00',
        lastOpenedAt: '2026-09-29T10:00:00.000Z',
        lastProbedAt: '2026-05-01T00:00:00.000Z',
      }),
    ).toBe('2026-09-29T10:00:00.000Z');
    // A space-separated UTC value later in the day beats an ISO one earlier.
    expect(
      projectLastActivity({
        lastSeen: '2026-09-29 23:00:00',
        lastOpenedAt: '2026-09-29T01:00:00Z',
      }),
    ).toBe('2026-09-29T23:00:00.000Z');
    expect(projectLastActivity({ lastSeen: 'garbage' })).toBeNull();
  });

  it('the raw-SQL form only names the columns the store has', () => {
    expect(projectLastActivitySqlText(new Set(['last_seen']))).toBe(
      "coalesce(replace(last_seen, ' ', 'T'), '')",
    );
    expect(
      projectLastActivitySqlText(new Set(['last_seen', 'last_opened_at', 'last_probed_at'])),
    ).toMatch(/^max\(.*last_seen.*last_opened_at.*last_probed_at.*\)$/);
  });

  it('name disambiguation lists the most recently ACTIVE project first', async () => {
    const other = join(testDir, 'other');
    await mkdir(join(other, '.cleo'), { recursive: true });
    await nexusRegister(projectDir, 'dup', 'read');
    await nexusRegister(other, 'dup-2', 'read');
    const db = await getNexusRegistryDb(getCleoHome());
    const rows = db
      .select({ id: projectRegistry.projectId, path: projectRegistry.projectPath })
      .from(projectRegistry)
      .all();
    const older = rows.find((r) => r.path.endsWith('proj'))?.id ?? '';
    const newer = rows.find((r) => r.path.endsWith('other'))?.id ?? '';
    db.update(projectRegistry)
      .set({ lastSeen: '2020-01-01 00:00:00' })
      .where(eq(projectRegistry.projectId, older))
      .run();
    db.update(projectRegistry)
      .set({ lastSeen: '2026-01-01 00:00:00', name: 'dup' })
      .where(eq(projectRegistry.projectId, newer))
      .run();
    markProjectOpened(db, older, new Date());
    try {
      await nexusGetProject('dup');
      expect.unreachable('a duplicated name must be ambiguous');
    } catch (e) {
      expect(e).toBeInstanceOf(NexusProjectAmbiguityError);
      expect((e as NexusProjectAmbiguityError).candidates.map((c) => c.projectId)).toEqual([
        older,
        newer,
      ]);
    }
  });
});
