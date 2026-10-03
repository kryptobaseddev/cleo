/**
 * Tests for NEXUS registry module (SQLite backend).
 * @task T5366
 * @epic T4540
 */

import { readdirSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { WarningCollector, withWarningCollector } from '@cleocode/lafs';
import {
  readPortableProjectId,
  resolveProjectByCwd,
  VAULT_REMOTE_PATH_PREFIX,
} from '@cleocode/paths';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedTasks } from '../../store/__tests__/test-db-helper.js';
import { awaitBackgroundOps } from '../../store/background-ops.js';
import * as dataAccessors from '../../store/data-accessor.js';
import { resolveDualScopeDbPath } from '../../store/dual-scope-db.js';
import { getNexusDb, getNexusNativeDb } from '../../store/nexus-sqlite.js';
import { nexusNodes, projectIdAliases, projectRegistry } from '../../store/schema/nexus-schema.js';
import { closeAllDatabases, resetDbState } from '../../store/sqlite.js';
import { createSqliteDataAccessor } from '../../store/sqlite-data-accessor.js';
import { nexusContractsShow } from '../api-contracts.js';
import { getProjectClusters } from '../clusters.js';
import { getSymbolContext } from '../context.js';
import { diffNexusIndex } from '../diff.js';
import { getProjectFlows } from '../flows.js';
import { generateProjectHash } from '../hash.js';
import { canonicalProjectId, legacyProjectId, projectPathFingerprint } from '../identity.js';
import {
  nexusGetProject,
  nexusGetProjectById,
  nexusInit,
  nexusList,
  nexusProjectExists,
  nexusReconcile,
  nexusRegister,
  nexusSync,
  nexusSyncAll,
  nexusUnregister,
  readRegistry,
  resetNexusDbState,
  resolveNexusQueryProjectId,
} from '../registry.js';

/** Create a test project with tasks in SQLite (tasks.db). */
async function createTestProjectDb(
  dir: string,
  tasks: Array<Partial<Task> & { id: string }>,
): Promise<void> {
  await mkdir(join(dir, '.cleo'), { recursive: true });
  resetDbState();
  const accessor = await createSqliteDataAccessor(dir);
  await seedTasks(accessor, tasks);
  await accessor.close();
  resetDbState();
}

let testDir: string;
let originalCwd: string;
let registryDir: string;
let projectDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'nexus-registry-test-'));
  // No-argument registry calls need a caller project independent of registered targets.
  await mkdir(join(testDir, '.cleo'), { recursive: true });
  await mkdir(join(testDir, '.git'), { recursive: true });
  originalCwd = process.cwd();
  process.chdir(testDir);
  vi.stubEnv('CLEO_ROOT', testDir);
  vi.stubEnv('CLEO_PROJECT_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  registryDir = join(testDir, 'cleo-home');
  projectDir = join(testDir, 'test-project');

  // Create fake CLEO home
  await mkdir(registryDir, { recursive: true });

  // Point env vars to test dirs — CLEO_HOME controls nexus.db location
  vi.stubEnv('CLEO_HOME', registryDir);
  vi.stubEnv('NEXUS_HOME', join(registryDir, 'nexus'));
  vi.stubEnv('NEXUS_CACHE_DIR', join(registryDir, 'nexus', 'cache'));

  // Create a fake project with tasks.db
  await createTestProjectDb(projectDir, [
    {
      id: 'T001',
      title: 'Test task',
      status: 'pending',
      labels: ['auth', 'api'],
      description: 'Test task description',
    },
    {
      id: 'T002',
      title: 'Another task',
      status: 'done',
      labels: ['api'],
      description: 'Another task description',
    },
  ]);

  // Reset nexus.db singleton so each test gets a fresh database
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

describe('portable query identity (T12472)', () => {
  const portableId = '7f6b09d3-0b65-487d-a35e-e251b6c5df50';

  it('reads tracked identity before a conflicting cache, without registration', async () => {
    await writeFile(join(projectDir, '.cleo/project-id'), `${portableId}\n`);
    await writeFile(
      join(projectDir, '.cleo/project-info.json'),
      JSON.stringify({ projectId: 'stale-cache' }),
    );
    expect(await resolveNexusQueryProjectId(projectDir)).toBe(portableId);
    expect(await resolveNexusQueryProjectId(projectDir, portableId)).toBe(portableId);
    expect(await nexusList()).toEqual([]);
  });

  it('refuses missing identity rather than manufacturing a path-based id', async () => {
    await expect(resolveNexusQueryProjectId(projectDir)).rejects.toThrow('declares no identity');
  });

  it('resolves a recorded legacy id with an envelope deprecation warning', async () => {
    await writeFile(join(projectDir, '.cleo/project-id'), `${portableId}\n`);
    await nexusRegister(projectDir, 'portable-project', 'read');
    const alias = legacyProjectId('/previous-device/portable-project');
    const db = await getNexusDb();
    db.insert(projectIdAliases)
      .values({ legacyId: alias, canonicalId: portableId, createdAt: new Date().toISOString() })
      .run();
    const warnings = new WarningCollector();
    expect(
      await withWarningCollector(warnings, () => resolveNexusQueryProjectId(projectDir, alias)),
    ).toBe(portableId);
    expect(warnings.drain()).toEqual([
      expect.objectContaining({
        code: 'W_NEXUS_LEGACY_PROJECT_ID',
        context: { alias, projectId: portableId },
      }),
    ]);
  });

  it('does not interpret a project name, hash, or unresolved id as --project-id', async () => {
    await writeFile(join(projectDir, '.cleo/project-id'), `${portableId}\n`);
    const hash = await nexusRegister(projectDir, 'portable-name', 'read');
    for (const selector of ['portable-name', hash, 'unregistered-id']) {
      expect(await nexusGetProjectById(projectDir, selector)).toBeNull();
      await expect(resolveNexusQueryProjectId(projectDir, selector)).rejects.toThrow(
        'cannot select the graph',
      );
    }
  });

  it('refuses a registered foreign id and its alias', async () => {
    await writeFile(join(projectDir, '.cleo/project-id'), `${portableId}\n`);
    await nexusRegister(projectDir, 'local-project', 'read');
    const foreign = join(testDir, 'foreign');
    await createTestProjectDb(foreign, []);
    await writeFile(join(foreign, '.cleo/project-id'), 'foreign-project-id\n');
    await nexusRegister(foreign, 'foreign-project', 'read');
    const alias = legacyProjectId('/foreign-device/project');
    const db = await getNexusDb();
    db.insert(projectIdAliases)
      .values({
        legacyId: alias,
        canonicalId: 'foreign-project-id',
        createdAt: new Date().toISOString(),
      })
      .run();
    await expect(resolveNexusQueryProjectId(projectDir, 'foreign-project-id')).rejects.toThrow(
      'cannot select the graph',
    );
    await expect(resolveNexusQueryProjectId(projectDir, alias)).rejects.toThrow(
      'cannot select the graph',
    );
  });

  it('refuses a legacy prefix collision instead of choosing the alias row owner', async () => {
    await writeFile(join(projectDir, '.cleo/project-id'), `${portableId}\n`);
    await nexusRegister(projectDir, 'first-project', 'read');
    const sibling = join(testDir, 'sibling');
    await createTestProjectDb(sibling, []);
    await writeFile(join(sibling, '.cleo/project-id'), 'sibling-project-id\n');
    await nexusRegister(sibling, 'second-project', 'read');
    const alias = legacyProjectId(projectDir);
    expect(legacyProjectId(sibling)).toBe(alias);
    await expect(resolveNexusQueryProjectId(projectDir, alias)).rejects.toMatchObject({
      codeName: 'E_NEXUS_PROJECT_AMBIGUOUS',
    });
  });

  it('queries the retained graph after a checkout moves without analyzing again', async () => {
    await writeFile(join(projectDir, '.cleo/project-id'), `${portableId}\n`);
    vi.stubEnv('CLEO_ROOT', projectDir);
    const db = await getNexusDb(projectDir);
    db.insert(nexusNodes)
      .values({
        id: 'src/record.ts::stopCapture',
        kind: 'function',
        label: 'stopCapture',
        name: 'stopCapture',
        filePath: 'src/record.ts',
      })
      .run();
    const before = await getSymbolContext(
      'stopCapture',
      await resolveNexusQueryProjectId(projectDir),
      projectDir,
    );
    await closeAllDatabases();
    resetDbState();
    resetNexusDbState();
    const moved = join(testDir, 'moved-checkout');
    await rename(projectDir, moved);
    vi.stubEnv('CLEO_ROOT', moved);
    const after = await getSymbolContext(
      'stopCapture',
      await resolveNexusQueryProjectId(moved, portableId),
      moved,
    );
    expect(after).toEqual(before);
    expect(after.projectId).toBe(portableId);
    expect(after.matchCount).toBe(1);
  });

  it('compares separate registered graphs by portable id, without decoding ids into paths', async () => {
    await writeFile(join(projectDir, '.cleo/project-id'), `${portableId}\n`);
    await nexusRegister(projectDir, 'contract-a', 'read');
    const second = join(testDir, 'contracts-b');
    await createTestProjectDb(second, []);
    await writeFile(join(second, '.cleo/project-id'), 'contract-project-b\n');
    await nexusRegister(second, 'contract-b', 'read');
    for (const [index, root] of [projectDir, second].entries()) {
      const db = await getNexusDb(root);
      db.insert(nexusNodes)
        .values({
          id: `route-${index}`,
          kind: 'route',
          label: `route-${index}`,
          metaJson: JSON.stringify({
            method: 'GET',
            path: '/actions',
            responseSchema: { project: index },
          }),
        })
        .run();
    }
    const result = await nexusContractsShow(portableId, 'contract-project-b', testDir);
    expect(result.success).toBe(true);
    if (!result.success || !result.data) throw new Error('Expected contract comparison result');
    expect(result.data.projectAId).toBe(portableId);
    expect(result.data.projectBId).toBe('contract-project-b');
    expect(result.data.matches).toHaveLength(1);
    expect(result.data.matches[0]?.contractA.sourceSymbolId).toBe('route-0');
    expect(result.data.matches[0]?.contractB.sourceSymbolId).toBe('route-1');
    const unresolved = await nexusContractsShow('missing-project-id', portableId, testDir);
    expect(unresolved.success).toBe(false);
  });

  it('reads clusters, flows and diff counts from the supplied checkout, preserving the other graph', async () => {
    const second = join(testDir, 'graph-b');
    await createTestProjectDb(second, []);
    for (const [index, root] of [projectDir, second].entries()) {
      await writeFile(join(root, '.cleo/project-id'), `graph-project-${index}\n`);
      const db = await getNexusDb(root);
      db.insert(nexusNodes)
        .values([
          { id: `community-${index}`, kind: 'community', label: `community-${index}` },
          { id: `process-${index}`, kind: 'process', label: `process-${index}` },
        ])
        .run();
    }
    for (const [index, root] of [projectDir, second].entries()) {
      const id = `graph-project-${index}`;
      expect((await getProjectClusters(id, root)).communities.map((entry) => entry.id)).toEqual([
        `community-${index}`,
      ]);
      expect((await getProjectFlows(id, root)).flows.map((entry) => entry.id)).toEqual([
        `process-${index}`,
      ]);
      const result = await diffNexusIndex(root, { beforeRef: 'HEAD', afterRef: 'HEAD' });
      expect(result.projectId).toBe(id);
      expect(result.nodesBefore).toBe(2);
    }
  });
});

describe('generateProjectHash — within nexus registry', () => {
  it('returns a 12-character hex string', () => {
    const hash = generateProjectHash('/some/path');
    expect(hash).toMatch(/^[a-f0-9]{12}$/);
  });

  it('is deterministic for the same path', () => {
    const a = generateProjectHash('/same/path');
    const b = generateProjectHash('/same/path');
    expect(a).toBe(b);
  });

  it('produces different hashes for different paths', () => {
    const a = generateProjectHash('/path/a');
    const b = generateProjectHash('/path/b');
    expect(a).not.toBe(b);
  });
});

describe('nexusInit', () => {
  it('creates the NEXUS directories and initializes nexus.db', async () => {
    await nexusInit();

    const registry = await readRegistry();
    expect(registry).not.toBeNull();
    expect(registry!.projects).toEqual({});
    expect(registry!.schemaVersion).toBe('1.0.0');
  });

  it('binds caller and global registry handles to distinct synthetic fixtures', async () => {
    await nexusInit();
    const native = getNexusNativeDb();
    if (!native) throw new Error('Expected initialized registry handle');
    const databases = native.prepare('PRAGMA database_list').all();
    expect(databases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'main', file: join(testDir, '.cleo', 'cleo.db') }),
        expect.objectContaining({ name: 'nexus_global', file: join(registryDir, 'cleo.db') }),
      ]),
    );
  });

  it('is idempotent', async () => {
    await nexusInit();
    await nexusInit(); // Should not throw

    const registry = await readRegistry();
    expect(registry).not.toBeNull();
  });
});

describe('nexusRegister', () => {
  it('registers a project and returns its hash', async () => {
    const hash = await nexusRegister(projectDir, 'test-proj', 'read');

    expect(hash).toMatch(/^[a-f0-9]{12}$/);
    expect(hash).toBe(generateProjectHash(projectDir));
  });

  it('stores project metadata in registry', async () => {
    await nexusRegister(projectDir, 'test-proj', 'write');

    const project = await nexusGetProject('test-proj');
    expect(project).not.toBeNull();
    expect(project!.name).toBe('test-proj');
    expect(project!.path).toBe(projectDir);
    expect(project!.permissions).toBe('write');
    expect(project!.taskCount).toBe(2);
    expect(project!.labels).toEqual(['api', 'auth']);
  });

  it('repeats registration without replacing identity or omitted metadata', async () => {
    const hash = await nexusRegister(projectDir, 'test-proj', 'write');
    const original = await nexusGetProject(hash);
    expect(await nexusRegister(projectDir)).toBe(hash);
    expect(await nexusGetProject(hash)).toMatchObject({
      projectId: original!.projectId,
      registeredAt: original!.registeredAt,
      name: 'test-proj',
      permissions: 'write',
      taskCount: 2,
    });
    expect(await nexusList()).toHaveLength(1);
  });

  it('registers empty project when directory has no pre-existing tasks.db', async () => {
    const emptyDir = join(testDir, 'empty');
    // The project is initialized (has `.cleo/`) but carries zero tasks; the
    // SQLite accessor auto-creates tasks.db inside `.cleo/` so registration
    // succeeds with taskCount=0. resolveCleoDir needs the `.cleo/` (T11262).
    await mkdir(join(emptyDir, '.cleo'), { recursive: true });

    const hash = await nexusRegister(emptyDir, 'empty', 'read');
    expect(hash).toMatch(/^[a-f0-9]{12}$/);
    const project = await nexusGetProject('empty');
    expect(project).not.toBeNull();
    expect(project!.taskCount).toBe(0);
  });

  it('registers a changed immutable id at the same path as a separate project (T12469)', async () => {
    vi.stubEnv('CLEO_DISABLE_PROJECT_AUTOREGISTER', '1');
    // Declared up front: an adopted id would be written to the tracked
    // `.cleo/project-id`, which outranks project-info.json (T12470).
    await writeFile(
      join(projectDir, '.cleo/project-info.json'),
      JSON.stringify({ projectId: 'first-owner' }),
    );
    const hash = await nexusRegister(projectDir, 'owner', 'write');
    const before = await nexusGetProject(hash);
    await writeFile(
      join(projectDir, '.cleo/project-info.json'),
      JSON.stringify({ projectId: 'different-owner' }),
    );
    // A path is a location, never an identity: the new id registers instead of
    // being refused.
    expect(await nexusRegister(projectDir, 'overwrite', 'read')).toBe(hash);
    // The old row keeps its metadata but leaves the path: it has no other live
    // location, so it is parked on the `superseded:<id>` sentinel.
    const sentinel = `superseded:${before!.projectId}`;
    expect(await nexusGetProject(before!.projectId)).toEqual({
      ...before,
      path: sentinel,
      hash: generateProjectHash(sentinel),
      brainDbPath: null,
      tasksDbPath: null,
    });
    expect(await nexusGetProject('different-owner')).toMatchObject({
      path: before!.path,
      name: 'overwrite',
    });
    expect(await nexusList()).toHaveLength(2);
  });

  it('keeps one row for a declared id seen at a second path (T12469)', async () => {
    vi.stubEnv('CLEO_DISABLE_PROJECT_AUTOREGISTER', '1');
    await writeFile(
      join(projectDir, '.cleo/project-info.json'),
      JSON.stringify({ projectId: 'immutable-owner' }),
    );
    const hash = await nexusRegister(projectDir, 'owner', 'write');
    const before = await nexusGetProject(hash);
    const other = join(testDir, 'other-owner');
    await mkdir(join(other, '.cleo'), { recursive: true });
    await writeFile(
      join(other, '.cleo/project-info.json'),
      JSON.stringify({ projectId: 'immutable-owner' }),
    );
    // Same immutable id at another path: the one row follows the latest
    // checkout; both checkouts are recorded as live locations.
    await nexusRegister(other, 'other');
    expect(await nexusList()).toHaveLength(1);
    expect(await nexusGetProject('immutable-owner')).toMatchObject({
      registeredAt: before!.registeredAt,
      path: realpathSync(other),
      name: 'other',
    });
    const { listProjectCheckouts } = await import('../path-map.js');
    const checkouts = await listProjectCheckouts('immutable-owner');
    expect(checkouts.map((c) => c.projectPath).sort()).toEqual(
      [before!.path, realpathSync(other)].sort(),
    );
    expect(checkouts.every((c) => c.state === 'live')).toBe(true);
  });

  it('records an adopted identity instead of deriving one from the path (T12470)', async () => {
    vi.stubEnv('CLEO_DISABLE_PROJECT_AUTOREGISTER', '1');
    const hash = await nexusRegister(projectDir, 'adopted');
    const row = await nexusGetProject(hash);
    const tracked = readPortableProjectId(projectDir);
    expect(tracked.status).toBe('valid');
    expect(row?.projectId).toBe(tracked.status === 'valid' ? tracked.projectId : null);
    // Never the path fingerprint — that survives only as an alias.
    const { id: fingerprint } = await projectPathFingerprint(projectDir);
    expect(row?.projectId).not.toBe(fingerprint);
  });

  it('keeps one row and the same id when a project moves between two roots (T12470 AC3)', async () => {
    vi.stubEnv('CLEO_DISABLE_PROJECT_AUTOREGISTER', '1');
    const rootA = join(testDir, 'root-a');
    const rootB = join(testDir, 'root-b', 'nested');
    await mkdir(join(rootA, 'proj', '.cleo'), { recursive: true });
    await mkdir(rootB, { recursive: true });
    await mkdir(join(rootA, 'proj', '.git'), { recursive: true }); // a git toplevel
    await writeFile(join(rootA, 'proj', '.cleo', 'project-id'), 'moving-project-id\n');
    const idA = resolveProjectByCwd(join(rootA, 'proj'))?.projectId;
    await nexusRegister(join(rootA, 'proj'), 'moving');

    await rename(join(rootA, 'proj'), join(rootB, 'proj'));
    const idB = resolveProjectByCwd(join(rootB, 'proj'))?.projectId;
    expect(await nexusReconcile(realpathSync(join(rootB, 'proj')))).toMatchObject({
      status: 'path_updated',
    });

    expect(idA).toBe('moving-project-id');
    expect(idB).toBe(idA);
    const rows = await nexusList();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      projectId: 'moving-project-id',
      path: realpathSync(join(rootB, 'proj')),
    });
  });

  it('preserves a metadata read failure instead of replacing stored counts with zero', async () => {
    vi.stubEnv('CLEO_DISABLE_PROJECT_AUTOREGISTER', '1');
    const hash = await nexusRegister(projectDir, 'owner', 'write');
    const before = await nexusGetProject(hash);
    vi.spyOn(dataAccessors, 'getTaskAccessor').mockRejectedValueOnce(
      new Error('fixture task read failed'),
    );
    await expect(nexusRegister(projectDir, 'overwrite')).rejects.toThrow(
      /Cannot read project task metadata.*fixture task read failed/,
    );
    expect(await nexusGetProject(hash)).toEqual(before);
  });

  it('rejects unreadable identity metadata instead of assigning a fallback identity', async () => {
    vi.stubEnv('CLEO_DISABLE_PROJECT_AUTOREGISTER', '1');
    await writeFile(
      join(projectDir, '.cleo/project-info.json'),
      JSON.stringify({ projectId: 'declared-owner' }),
    );
    const hash = await nexusRegister(projectDir, 'owner');
    const before = await nexusGetProject(hash);
    await writeFile(join(projectDir, '.cleo/project-info.json'), '{broken');
    await expect(nexusRegister(projectDir)).rejects.toThrow(/Cannot read project identity/);
    expect(await nexusGetProject(hash)).toEqual(before);
  });

  it('rolls back requested metadata when alias persistence fails in the transaction', async () => {
    vi.stubEnv('CLEO_DISABLE_PROJECT_AUTOREGISTER', '1');
    const hash = await nexusRegister(projectDir, 'owner', 'write');
    const before = await nexusGetProject(hash);
    const db = await getNexusDb();
    await db.delete(projectIdAliases).where(eq(projectIdAliases.canonicalId, before!.projectId));
    const native = getNexusNativeDb();
    if (!native) throw new Error('Missing canonical fixture handle');
    native.exec(
      "CREATE TRIGGER nexus_global.fail_alias BEFORE INSERT ON nexus_project_id_aliases BEGIN SELECT RAISE(ABORT, 'fixture alias failure'); END",
    );
    try {
      await expect(nexusRegister(projectDir, 'overwrite', 'execute')).rejects.toThrow();
      expect(await nexusGetProject(hash)).toEqual(before);
      expect(
        await db
          .select()
          .from(projectIdAliases)
          .where(eq(projectIdAliases.canonicalId, before!.projectId)),
      ).toEqual([]);
    } finally {
      native.exec('DROP TRIGGER nexus_global.fail_alias');
    }
  });

  it('keeps a path-derived canonical alias owned elsewhere and still registers (T12469)', async () => {
    vi.stubEnv('CLEO_DISABLE_PROJECT_AUTOREGISTER', '1');
    await writeFile(
      join(projectDir, '.cleo/project-info.json'),
      JSON.stringify({ projectId: 'declared-owner' }),
    );
    const { id: alias } = await canonicalProjectId(projectDir);
    await nexusInit();
    const db = await getNexusDb();
    await db.insert(projectIdAliases).values({
      legacyId: alias,
      canonicalId: 'another-owner',
      createdAt: new Date().toISOString(),
    });
    const aliasesBefore = await db.select().from(projectIdAliases);
    await nexusRegister(projectDir, 'new-name', 'write');
    expect((await nexusList()).map((p) => p.projectId)).toEqual(['declared-owner']);
    // The alias keeps its existing owner; it is never redirected.
    expect(
      await db.select().from(projectIdAliases).where(eq(projectIdAliases.legacyId, alias)),
    ).toEqual(aliasesBefore.filter((row) => row.legacyId === alias));
  });

  it.each([
    false,
    true,
  ])('keeps explicit project metadata when ambient pins change: %s', async (changeDuringRead) => {
    const explicitProject = join(testDir, 'explicit-project');
    await createTestProjectDb(explicitProject, [
      { id: 'T900', title: 'Only explicit B', status: 'pending', labels: ['project-b'] },
    ]);
    await writeFile(
      join(explicitProject, '.cleo/project-info.json'),
      JSON.stringify({ projectId: 'explicit-project-b' }),
    );
    await writeFile(
      join(projectDir, '.cleo/project-info.json'),
      JSON.stringify({ projectId: 'ambient-project-a' }),
    );
    const explicitAlias = (await canonicalProjectId(explicitProject)).id;
    const originalAccessor = dataAccessors.getTaskAccessor;
    const entered = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    if (changeDuringRead) {
      vi.spyOn(dataAccessors, 'getTaskAccessor').mockImplementationOnce(async (cwd) => {
        entered.resolve();
        await proceed.promise;
        return originalAccessor(cwd);
      });
      vi.stubEnv('CLEO_ROOT', explicitProject);
      vi.stubEnv('CLEO_DIR', join(explicitProject, '.cleo'));
    } else {
      vi.stubEnv('CLEO_ROOT', projectDir);
      vi.stubEnv('CLEO_DIR', join(projectDir, '.cleo'));
    }
    const registration = nexusRegister(explicitProject, 'explicit-b', 'execute');
    if (changeDuringRead) {
      await entered.promise;
      vi.stubEnv('CLEO_ROOT', projectDir);
      vi.stubEnv('CLEO_DIR', join(projectDir, '.cleo'));
      proceed.resolve();
    }
    const hash = await registration;
    expect(await nexusGetProject(hash)).toMatchObject({
      projectId: 'explicit-project-b',
      path: explicitProject,
      name: 'explicit-b',
      permissions: 'execute',
      taskCount: 1,
      labels: ['project-b'],
    });
    const db = await getNexusDb();
    expect(
      await db.select().from(projectIdAliases).where(eq(projectIdAliases.legacyId, explicitAlias)),
    ).toMatchObject([{ canonicalId: 'explicit-project-b' }]);
    vi.stubEnv('CLEO_ROOT', testDir);
    vi.stubEnv('CLEO_DIR', undefined);
    const ambient = await originalAccessor(projectDir);
    expect((await ambient.queryTasks({})).tasks.map((task) => task.id).sort()).toEqual([
      'T001',
      'T002',
    ]);
  });

  it('throws on name conflict', async () => {
    await nexusRegister(projectDir, 'test-proj', 'read');

    // Create a second project with different path (SQLite auto-creates tasks.db)
    const secondDir = join(testDir, 'second-project');
    await mkdir(join(secondDir, '.cleo'), { recursive: true });

    await expect(nexusRegister(secondDir, 'test-proj', 'read')).rejects.toThrow(/already exists/);
  });
});

describe('nexusUnregister', () => {
  it('removes a project by name', async () => {
    await nexusRegister(projectDir, 'test-proj', 'read');
    await nexusUnregister('test-proj');

    const exists = await nexusProjectExists('test-proj');
    expect(exists).toBe(false);
  });

  it('removes a project by hash', async () => {
    const hash = await nexusRegister(projectDir, 'test-proj', 'read');
    await nexusUnregister(hash);

    const exists = await nexusProjectExists(hash);
    expect(exists).toBe(false);
  });

  it('throws for non-existent project', async () => {
    await nexusInit();

    await expect(nexusUnregister('nonexistent')).rejects.toThrow(/not found/i);
  });
});

describe('nexusList', () => {
  it('returns empty array when no projects registered', async () => {
    await nexusInit();
    const projects = await nexusList();
    expect(projects).toEqual([]);
  });

  it('returns all registered projects', async () => {
    await nexusRegister(projectDir, 'test-proj', 'read');
    const projects = await nexusList();

    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe('test-proj');
  });
});

describe('nexusGetProject', () => {
  it('finds project by name', async () => {
    await nexusRegister(projectDir, 'test-proj', 'read');

    const project = await nexusGetProject('test-proj');
    expect(project).not.toBeNull();
    expect(project!.name).toBe('test-proj');
  });

  it('finds project by hash', async () => {
    const hash = await nexusRegister(projectDir, 'test-proj', 'read');

    const project = await nexusGetProject(hash);
    expect(project).not.toBeNull();
    expect(project!.hash).toBe(hash);
  });

  it('returns null for unknown project', async () => {
    await nexusInit();
    const project = await nexusGetProject('nonexistent');
    expect(project).toBeNull();
  });
});

describe('nexusProjectExists', () => {
  it('returns true for registered project', async () => {
    await nexusRegister(projectDir, 'test-proj', 'read');
    expect(await nexusProjectExists('test-proj')).toBe(true);
  });

  it('returns false for unregistered project', async () => {
    await nexusInit();
    expect(await nexusProjectExists('nonexistent')).toBe(false);
  });
});

describe('nexusSync', () => {
  it('updates task count and labels', async () => {
    await nexusRegister(projectDir, 'test-proj', 'read');

    // Update project with new tasks via SQLite
    await createTestProjectDb(projectDir, [
      {
        id: 'T001',
        title: 'Task 1',
        status: 'pending',
        labels: ['new-label'],
        description: 'First task',
      },
      {
        id: 'T002',
        title: 'Task 2',
        status: 'done',
        labels: ['new-label'],
        description: 'Second task',
      },
      { id: 'T003', title: 'Task 3', status: 'active', labels: [], description: 'Third task' },
    ]);

    await nexusSync('test-proj');

    const project = await nexusGetProject('test-proj');
    expect(project!.taskCount).toBe(3);
    expect(project!.labels).toEqual(['new-label']);
  });
});

describe('nexusSyncAll', () => {
  it('syncs all registered projects', async () => {
    await nexusRegister(projectDir, 'test-proj', 'read');

    const result = await nexusSyncAll();
    expect(result.synced).toBe(1);
    expect(result.failed).toBe(0);
  });
});

describe('cloud vault placeholder rows (T13006)', () => {
  const PLACEHOLDER = `${VAULT_REMOTE_PATH_PREFIX}nexus_project_registry:["remote-id"]:project_path`;

  /** A registry row a cloud vault restore brought from another machine. */
  async function insertRemoteRow(): Promise<void> {
    const db = await getNexusDb();
    const now = new Date().toISOString();
    await db.insert(projectRegistry).values({
      projectId: 'remote-id',
      projectHash: 'remoteremote',
      projectPath: PLACEHOLDER,
      name: 'remote',
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

  it('flags them in the registry read, and sync never opens or creates a store for them', async () => {
    await nexusRegister(projectDir, 'test-proj', 'read');
    await insertRemoteRow();
    const accessor = vi.spyOn(dataAccessors, 'getTaskAccessor');

    const remote = (await nexusList()).find((p) => p.projectId === 'remote-id');
    expect(remote).toMatchObject({ remote: true, path: PLACEHOLDER, tasksDbPath: null });
    expect((await nexusGetProject('remote-id'))?.remote).toBe(true);
    expect((await nexusList()).find((p) => p.projectId !== 'remote-id')?.remote).toBeUndefined();

    const result = await nexusSyncAll();
    expect(result).toEqual({ synced: 1, failed: 0 });
    expect(accessor.mock.calls.map((c) => c[0])).not.toContain(PLACEHOLDER);
    expect(readdirSync(testDir).filter((n) => n.startsWith(VAULT_REMOTE_PATH_PREFIX))).toEqual([]);
    await expect(nexusSync('remote-id')).rejects.toThrow(/another machine/);
  });

  it('the store opener refuses a placeholder instead of resolving it under the cwd', () => {
    expect(() => resolveDualScopeDbPath('project', PLACEHOLDER)).toThrow(/cloud vault placeholder/);
    // Already resolved against a working directory (T13021).
    expect(() => resolveDualScopeDbPath('project', join(testDir, PLACEHOLDER))).toThrow(
      /cloud vault placeholder/,
    );
    expect(readdirSync(testDir).filter((n) => n.startsWith(VAULT_REMOTE_PATH_PREFIX))).toEqual([]);
  });

  it('the task accessor refuses a placeholder, raw or resolved, and creates nothing (T13021)', async () => {
    await expect(dataAccessors.getTaskAccessor(PLACEHOLDER)).rejects.toThrow(
      /cloud vault placeholder/,
    );
    await expect(dataAccessors.createDataAccessor(join(testDir, PLACEHOLDER))).rejects.toThrow(
      /cloud vault placeholder/,
    );
    expect(readdirSync(testDir).filter((n) => n.startsWith(VAULT_REMOTE_PATH_PREFIX))).toEqual([]);
  });

  it('workspace status, agents and routing skip it, and so do the registry roots (T13021)', async () => {
    await nexusRegister(projectDir, 'test-proj', 'read');
    await insertRemoteRow();
    const accessor = vi.spyOn(dataAccessors, 'getTaskAccessor');
    const { routeDirective, workspaceAgents, workspaceStatus } = await import('../workspace.js');
    const status = await workspaceStatus();
    expect(status.projectCount).toBe(1);
    expect(status.projects.map((p) => p.path)).not.toContain(PLACEHOLDER);
    await workspaceAgents();
    await routeDirective({
      verb: 'done',
      taskRefs: ['T999'],
      agentId: 'agent-t13021',
      messageId: 'm-1',
      timestamp: new Date().toISOString(),
    });
    expect(accessor.mock.calls.length).toBeGreaterThan(0);
    expect(accessor.mock.calls.map((c) => c[0])).not.toContain(PLACEHOLDER);
    const { listRegistryParentRoots, parentRootsOf } = await import('../registry-roots.js');
    const local = (await nexusList()).filter((p) => !p.remote).map((p) => p.path);
    expect(await listRegistryParentRoots()).toEqual(parentRootsOf(local));
    expect(readdirSync(testDir).filter((n) => n.startsWith(VAULT_REMOTE_PATH_PREFIX))).toEqual([]);
  });
});
