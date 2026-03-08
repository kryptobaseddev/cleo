/**
 * Tests for nexusReconcile() — 4-scenario handshake contract.
 * @task T5368
 * @epic T4540
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  nexusInit,
  nexusRegister,
  nexusReconcile,
  nexusGetProject,
  resetNexusDbState,
} from '../registry.js';
import { generateProjectHash } from '../hash.js';
import { getNexusDb } from '../../../store/nexus-sqlite.js';
import { projectRegistry } from '../../../store/nexus-schema.js';
import { createSqliteDataAccessor } from '../../../store/sqlite-data-accessor.js';
import { resetDbState } from '../../../store/sqlite.js';
import { seedTasks } from '../../../store/__tests__/test-db-helper.js';
import { CleoError } from '../../errors.js';

/** Create a test project with tasks in SQLite (tasks.db) and project-info.json. */
async function createTestProject(
  dir: string,
  projectId?: string,
): Promise<string> {
  await mkdir(join(dir, '.cleo'), { recursive: true });

  // Create project-info.json with projectId
  const pid = projectId ?? randomUUID();
  await writeFile(
    join(dir, '.cleo', 'project-info.json'),
    JSON.stringify({ projectId: pid, createdAt: new Date().toISOString() }),
  );

  // Create tasks.db with seed data
  resetDbState();
  const accessor = await createSqliteDataAccessor(dir);
  await seedTasks(accessor, [
    { id: 'T001', title: 'Test task', status: 'pending', description: 'A test task' },
  ]);
  await accessor.close();
  resetDbState();

  return pid;
}

let testDir: string;
let registryDir: string;
let projectDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'nexus-reconcile-test-'));
  registryDir = join(testDir, 'cleo-home');
  projectDir = join(testDir, 'test-project');

  await mkdir(registryDir, { recursive: true });

  process.env['CLEO_HOME'] = registryDir;
  process.env['NEXUS_HOME'] = join(registryDir, 'nexus');
  process.env['NEXUS_CACHE_DIR'] = join(registryDir, 'nexus', 'cache');

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

describe('nexusReconcile', () => {
  it('scenario 1: known project at same path returns ok and updates lastSeen', async () => {
    const projectId = await createTestProject(projectDir);

    // Register the project first
    await nexusInit();
    await nexusRegister(projectDir, 'test-proj');

    // Record the lastSeen before reconcile
    const db = await getNexusDb();
    const beforeRows = await db.select().from(projectRegistry)
      .where(eq(projectRegistry.projectId, projectId));
    const beforeLastSeen = beforeRows[0].lastSeen;

    // Small delay to ensure timestamp differs
    await new Promise(r => setTimeout(r, 10));

    const result = await nexusReconcile(projectDir);

    expect(result.status).toBe('ok');
    expect(result.oldPath).toBeUndefined();
    expect(result.newPath).toBeUndefined();

    // Verify lastSeen was updated
    const afterRows = await db.select().from(projectRegistry)
      .where(eq(projectRegistry.projectId, projectId));
    expect(afterRows[0].lastSeen >= beforeLastSeen).toBe(true);
  });

  it('scenario 2: known project at different path returns path_updated', async () => {
    const projectId = await createTestProject(projectDir);

    // Register the project at the original path
    await nexusInit();
    await nexusRegister(projectDir, 'test-proj');

    // Create a new project directory with the same projectId (simulating a move)
    const newProjectDir = join(testDir, 'moved-project');
    await createTestProject(newProjectDir, projectId);

    const result = await nexusReconcile(newProjectDir);

    expect(result.status).toBe('path_updated');
    expect(result.oldPath).toBe(projectDir);
    expect(result.newPath).toBe(newProjectDir);

    // Verify the registry was updated with the new path and hash
    const project = await nexusGetProject('test-proj');
    expect(project).not.toBeNull();
    expect(project!.path).toBe(newProjectDir);
    expect(project!.hash).toBe(generateProjectHash(newProjectDir));
  });

  it('scenario 3: unknown project auto-registers', async () => {
    await createTestProject(projectDir);

    // Do not register — just reconcile against empty registry
    const result = await nexusReconcile(projectDir);

    expect(result.status).toBe('auto_registered');

    // Verify the project is now in the registry
    const hash = generateProjectHash(projectDir);
    const project = await nexusGetProject(hash);
    expect(project).not.toBeNull();
    expect(project!.path).toBe(projectDir);
  });

  it('scenario 4: hash conflict with different projectId throws CleoError', async () => {
    const projectId1 = randomUUID();
    await createTestProject(projectDir, projectId1);

    // Register the project
    await nexusInit();
    await nexusRegister(projectDir, 'test-proj');

    // Overwrite project-info.json with a different projectId at the same path
    const projectId2 = randomUUID();
    await writeFile(
      join(projectDir, '.cleo', 'project-info.json'),
      JSON.stringify({ projectId: projectId2, createdAt: new Date().toISOString() }),
    );

    await expect(nexusReconcile(projectDir)).rejects.toThrow(CleoError);
    try {
      await nexusReconcile(projectDir);
    } catch (err) {
      expect(err).toBeInstanceOf(CleoError);
      expect((err as CleoError).code).toBe(75); // NEXUS_REGISTRY_CORRUPT
      expect((err as CleoError).message).toContain('Project identity conflict');
    }
  });

  it('throws on empty project root', async () => {
    await expect(nexusReconcile('')).rejects.toThrow('Project root path required');
  });
});
