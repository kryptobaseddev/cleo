/**
 * Tests for NEXUS registry module.
 * @task T4574
 * @epic T4540
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  generateProjectHash,
  nexusInit,
  nexusRegister,
  nexusUnregister,
  nexusList,
  nexusGetProject,
  nexusProjectExists,
  nexusSync,
  nexusSyncAll,
  readRegistry,
  getRegistryPath,
} from '../registry.js';

let testDir: string;
let registryDir: string;
let projectDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'nexus-registry-test-'));
  registryDir = join(testDir, 'cleo-home');
  projectDir = join(testDir, 'test-project');

  // Create fake CLEO home
  await mkdir(registryDir, { recursive: true });

  // Create a fake project with .cleo/todo.json
  await mkdir(join(projectDir, '.cleo'), { recursive: true });
  await writeFile(
    join(projectDir, '.cleo', 'todo.json'),
    JSON.stringify({
      tasks: [
        { id: 'T001', title: 'Test task', status: 'pending', labels: ['auth', 'api'] },
        { id: 'T002', title: 'Another task', status: 'done', labels: ['api'] },
      ],
    }),
  );

  // Point env vars to test dirs
  process.env['CLEO_HOME'] = registryDir;
  process.env['NEXUS_HOME'] = join(registryDir, 'nexus');
  process.env['NEXUS_CACHE_DIR'] = join(registryDir, 'nexus', 'cache');
  process.env['NEXUS_REGISTRY_FILE'] = join(registryDir, 'projects-registry.json');
});

afterEach(async () => {
  delete process.env['CLEO_HOME'];
  delete process.env['NEXUS_HOME'];
  delete process.env['NEXUS_CACHE_DIR'];
  delete process.env['NEXUS_REGISTRY_FILE'];
  await rm(testDir, { recursive: true, force: true });
});

describe('generateProjectHash', () => {
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
  it('creates the NEXUS directories and registry file', async () => {
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

  it('throws on duplicate registration', async () => {
    await nexusRegister(projectDir, 'test-proj', 'read');

    await expect(
      nexusRegister(projectDir, 'test-proj', 'read'),
    ).rejects.toThrow(/already registered/);
  });

  it('throws if path has no .cleo/todo.json', async () => {
    const emptyDir = join(testDir, 'empty');
    await mkdir(emptyDir, { recursive: true });

    await expect(
      nexusRegister(emptyDir, 'empty', 'read'),
    ).rejects.toThrow(/missing .cleo\/todo.json/i);
  });

  it('throws on name conflict', async () => {
    await nexusRegister(projectDir, 'test-proj', 'read');

    // Create a second project with different path
    const secondDir = join(testDir, 'second-project');
    await mkdir(join(secondDir, '.cleo'), { recursive: true });
    await writeFile(join(secondDir, '.cleo', 'todo.json'), '{"tasks":[]}');

    await expect(
      nexusRegister(secondDir, 'test-proj', 'read'),
    ).rejects.toThrow(/already exists/);
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

    await expect(
      nexusUnregister('nonexistent'),
    ).rejects.toThrow(/not found/i);
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

    // Add a task
    await writeFile(
      join(projectDir, '.cleo', 'todo.json'),
      JSON.stringify({
        tasks: [
          { id: 'T001', title: 'Task 1', status: 'pending', labels: ['new-label'] },
          { id: 'T002', title: 'Task 2', status: 'done', labels: ['new-label'] },
          { id: 'T003', title: 'Task 3', status: 'active', labels: [] },
        ],
      }),
    );

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
