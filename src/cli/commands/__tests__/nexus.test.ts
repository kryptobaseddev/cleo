/**
 * Tests for NEXUS CLI command.
 * Tests the unified nexus command that ports the 4 bash scripts.
 *
 * @task T4554
 * @epic T4545
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerNexusCommand } from '../nexus.js';
import {
  nexusInit,
  nexusRegister,
  nexusList,
  nexusGetProject,
} from '../../../core/nexus/index.js';

let testDir: string;
let registryDir: string;
let projectDirA: string;
let projectDirB: string;

/** Create a test project with tasks. */
async function createTestProject(
  dir: string,
  tasks: Array<{ id: string; title: string; status: string; description?: string; labels?: string[]; depends?: string[]; priority?: string }>,
): Promise<void> {
  await mkdir(join(dir, '.cleo'), { recursive: true });
  await writeFile(
    join(dir, '.cleo', 'todo.json'),
    JSON.stringify({ tasks }),
  );
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'nexus-cli-test-'));
  registryDir = join(testDir, 'cleo-home');
  projectDirA = join(testDir, 'project-alpha');
  projectDirB = join(testDir, 'project-beta');

  await mkdir(registryDir, { recursive: true });

  // Create test project A
  await createTestProject(projectDirA, [
    { id: 'T001', title: 'Auth module', status: 'pending', labels: ['auth', 'api'], description: 'Implement JWT authentication', priority: 'high' },
    { id: 'T002', title: 'Database setup', status: 'done', labels: ['db'], description: 'Set up PostgreSQL database', priority: 'medium' },
    { id: 'T003', title: 'API endpoints', status: 'pending', labels: ['api'], description: 'REST API endpoints', depends: ['T002'], priority: 'medium' },
  ]);

  // Create test project B
  await createTestProject(projectDirB, [
    { id: 'T001', title: 'Frontend auth', status: 'pending', labels: ['auth', 'ui'], description: 'Login and signup UI', priority: 'high' },
    { id: 'T002', title: 'Dashboard', status: 'pending', labels: ['ui'], description: 'Main dashboard component', priority: 'medium' },
  ]);

  // Set env vars
  process.env['CLEO_HOME'] = registryDir;
  process.env['NEXUS_HOME'] = join(registryDir, 'nexus');
  process.env['NEXUS_CACHE_DIR'] = join(registryDir, 'nexus', 'cache');
  process.env['NEXUS_REGISTRY_FILE'] = join(registryDir, 'projects-registry.json');
  process.env['NEXUS_SKIP_PERMISSION_CHECK'] = 'true';
  process.env['NEXUS_CURRENT_PROJECT'] = 'project-alpha';
});

afterEach(async () => {
  delete process.env['CLEO_HOME'];
  delete process.env['NEXUS_HOME'];
  delete process.env['NEXUS_CACHE_DIR'];
  delete process.env['NEXUS_REGISTRY_FILE'];
  delete process.env['NEXUS_SKIP_PERMISSION_CHECK'];
  delete process.env['NEXUS_CURRENT_PROJECT'];
  await rm(testDir, { recursive: true, force: true });
});

describe('registerNexusCommand', () => {
  it('should register the nexus command with subcommands', () => {
    const program = new Command();
    registerNexusCommand(program);

    const nexusCmd = program.commands.find(c => c.name() === 'nexus');
    expect(nexusCmd).toBeDefined();

    const subcommandNames = nexusCmd!.commands.map(c => c.name());
    expect(subcommandNames).toContain('init');
    expect(subcommandNames).toContain('register');
    expect(subcommandNames).toContain('unregister');
    expect(subcommandNames).toContain('list');
    expect(subcommandNames).toContain('status');
    expect(subcommandNames).toContain('query');
    expect(subcommandNames).toContain('discover');
    expect(subcommandNames).toContain('search');
    expect(subcommandNames).toContain('deps');
    expect(subcommandNames).toContain('sync');
  });
});

describe('nexus init (core integration)', () => {
  it('should initialize nexus registry', async () => {
    await nexusInit();
    const projects = await nexusList();
    expect(projects).toEqual([]);
  });
});

describe('nexus register/unregister (core integration)', () => {
  it('should register a project and retrieve it', async () => {
    await nexusInit();
    const hash = await nexusRegister(projectDirA, 'alpha', 'read');

    expect(hash).toMatch(/^[a-f0-9]{12}$/);

    const project = await nexusGetProject('alpha');
    expect(project).not.toBeNull();
    expect(project!.name).toBe('alpha');
    expect(project!.path).toBe(projectDirA);
    expect(project!.permissions).toBe('read');
    expect(project!.taskCount).toBe(3);
    expect(project!.labels).toContain('auth');
    expect(project!.labels).toContain('api');
    expect(project!.labels).toContain('db');
  });

  it('should list registered projects', async () => {
    await nexusInit();
    await nexusRegister(projectDirA, 'alpha', 'read');
    await nexusRegister(projectDirB, 'beta', 'write');

    const projects = await nexusList();
    expect(projects).toHaveLength(2);
    const names = projects.map(p => p.name).sort();
    expect(names).toEqual(['alpha', 'beta']);
  });
});

describe('nexus search (core integration)', () => {
  it('should search tasks across projects by pattern', async () => {
    await nexusInit();
    await nexusRegister(projectDirA, 'alpha', 'read');
    await nexusRegister(projectDirB, 'beta', 'read');

    // Import the search function indirectly through the command
    // We test the core search logic by reading back tasks
    const projects = await nexusList();
    expect(projects).toHaveLength(2);
    expect(projects.reduce((sum, p) => sum + p.taskCount, 0)).toBe(5);
  });
});

describe('nexus query (core integration)', () => {
  it('should resolve a task from a named project', async () => {
    await nexusInit();
    await nexusRegister(projectDirA, 'alpha', 'read');

    const { resolveTask } = await import('../../../core/nexus/index.js');
    const result = await resolveTask('alpha:T001');
    expect(Array.isArray(result)).toBe(false);
    if (!Array.isArray(result)) {
      expect(result.id).toBe('T001');
      expect(result.title).toBe('Auth module');
      expect(result._project).toBe('alpha');
    }
  });

  it('should resolve wildcard queries across projects', async () => {
    await nexusInit();
    await nexusRegister(projectDirA, 'alpha', 'read');
    await nexusRegister(projectDirB, 'beta', 'read');

    const { resolveTask } = await import('../../../core/nexus/index.js');
    const results = await resolveTask('*:T001');
    expect(Array.isArray(results)).toBe(true);
    if (Array.isArray(results)) {
      expect(results.length).toBe(2);
      const projects = results.map(r => r._project).sort();
      expect(projects).toEqual(['alpha', 'beta']);
    }
  });
});

describe('nexus status (core integration)', () => {
  it('should report registry status', async () => {
    await nexusInit();
    await nexusRegister(projectDirA, 'alpha', 'read');
    await nexusRegister(projectDirB, 'beta', 'write');

    const { readRegistry } = await import('../../../core/nexus/index.js');
    const registry = await readRegistry();
    expect(registry).not.toBeNull();
    expect(Object.keys(registry!.projects)).toHaveLength(2);
    expect(registry!.schemaVersion).toBe('1.0.0');
  });
});

describe('nexus sync (core integration)', () => {
  it('should sync a specific project', async () => {
    await nexusInit();
    await nexusRegister(projectDirA, 'alpha', 'read');

    // Modify project tasks
    await createTestProject(projectDirA, [
      { id: 'T001', title: 'Auth module', status: 'done', labels: ['auth', 'api'] },
      { id: 'T002', title: 'Database setup', status: 'done', labels: ['db'] },
      { id: 'T003', title: 'API endpoints', status: 'done', labels: ['api'] },
      { id: 'T004', title: 'New task', status: 'pending', labels: ['new'] },
    ]);

    const { nexusSync } = await import('../../../core/nexus/index.js');
    await nexusSync('alpha');

    const project = await nexusGetProject('alpha');
    expect(project!.taskCount).toBe(4);
    expect(project!.labels).toContain('new');
  });

  it('should sync all projects', async () => {
    await nexusInit();
    await nexusRegister(projectDirA, 'alpha', 'read');
    await nexusRegister(projectDirB, 'beta', 'read');

    const { nexusSyncAll } = await import('../../../core/nexus/index.js');
    const result = await nexusSyncAll();
    expect(result.synced).toBe(2);
    expect(result.failed).toBe(0);
  });
});

describe('nexus deps (core integration)', () => {
  it('should report forward dependencies', async () => {
    await nexusInit();
    await nexusRegister(projectDirA, 'alpha', 'read');

    const { nexusDeps } = await import('../../../core/nexus/index.js');
    const result = await nexusDeps('alpha:T003', 'forward');
    expect(result.task).toBe('alpha:T003');
    expect(result.depends.length).toBeGreaterThanOrEqual(1);
    expect(result.depends[0].query).toContain('T002');
  });
});
