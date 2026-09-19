/**
 * Tests for NEXUS registry module (SQLite backend).
 * @task T5366
 * @epic T4540
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedTasks } from '../../store/__tests__/test-db-helper.js';
import * as dataAccessors from '../../store/data-accessor.js';
import { getNexusDb, getNexusNativeDb } from '../../store/nexus-sqlite.js';
import { projectIdAliases } from '../../store/schema/nexus-schema.js';
import { resetDbState } from '../../store/sqlite.js';
import { createSqliteDataAccessor } from '../../store/sqlite-data-accessor.js';
import { generateProjectHash } from '../hash.js';
import { canonicalProjectId } from '../identity.js';
import {
  nexusGetProject,
  nexusInit,
  nexusList,
  nexusProjectExists,
  nexusRegister,
  nexusSync,
  nexusSyncAll,
  nexusUnregister,
  readRegistry,
  resetNexusDbState,
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
let registryDir: string;
let projectDir: string;

// Multi-project scenarios resolve each store from its explicit fixture root.
beforeEach(() => {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'nexus-registry-test-'));
  registryDir = join(testDir, 'cleo-home');
  projectDir = join(testDir, 'test-project');

  // Create fake CLEO home
  await mkdir(registryDir, { recursive: true });

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

  // Point env vars to test dirs — CLEO_HOME controls nexus.db location
  process.env['CLEO_HOME'] = registryDir;
  process.env['NEXUS_HOME'] = join(registryDir, 'nexus');
  process.env['NEXUS_CACHE_DIR'] = join(registryDir, 'nexus', 'cache');

  // Reset nexus.db singleton so each test gets a fresh database
  resetNexusDbState();
});

afterEach(async () => {
  delete process.env['CLEO_HOME'];
  delete process.env['NEXUS_HOME'];
  delete process.env['NEXUS_CACHE_DIR'];
  resetNexusDbState();
  resetDbState();
  await rm(testDir, { recursive: true, force: true });
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

  it('rejects changed immutable ownership without rewriting the registered row', async () => {
    vi.stubEnv('CLEO_DISABLE_PROJECT_AUTOREGISTER', '1');
    const hash = await nexusRegister(projectDir, 'owner', 'write');
    const before = await nexusGetProject(hash);
    await writeFile(
      join(projectDir, '.cleo/project-info.json'),
      JSON.stringify({ projectId: 'different-owner' }),
    );
    await expect(nexusRegister(projectDir, 'overwrite', 'read')).rejects.toThrow(
      /Conflicting project identity/,
    );
    expect(await nexusGetProject(hash)).toEqual(before);
  });

  it('refuses to move another registered path merely because the declared IDs agree', async () => {
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
    await expect(nexusRegister(other, 'other')).rejects.toThrow(/Conflicting project identity/);
    expect(await nexusGetProject(hash)).toEqual(before);
    expect(await nexusList()).toHaveLength(1);
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

  it('refuses a canonical alias owned elsewhere and rolls back the new registration', async () => {
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
    await expect(nexusRegister(projectDir, 'new-name', 'write')).rejects.toThrow(
      /alias already belongs to another project/,
    );
    expect(await nexusList()).toEqual([]);
    expect(await db.select().from(projectIdAliases)).toEqual(aliasesBefore);
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
