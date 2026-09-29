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
} from '../project-activity.js';
import {
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
      await nexusProjectsFleet({}),
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
    const fleet = await nexusProjectsFleet({});
    expect(fleet.success).toBe(false);
    expect(fleet.error?.code).toBe('E_NEXUS_REGISTRY_READ');
  });

  it('an empty but readable registry is still an empty list, not an error', async () => {
    await expect(nexusList()).resolves.toEqual([]);
    await expect(nexusGetProject('nope')).resolves.toBeNull();
    const fleet = await nexusProjectsFleet({});
    expect(fleet.success).toBe(true);
    expect(fleet.data?.total).toBe(0);
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
