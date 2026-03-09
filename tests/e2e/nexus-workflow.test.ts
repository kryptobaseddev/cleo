/**
 * Nexus Domain E2E Tests
 *
 * End-to-end tests for the nexus domain handler:
 * 1. Init nexus (nexus.init)
 * 2. Register project (nexus.register)
 * 3. List projects (nexus.list)
 * 4. Show project (nexus.show)
 * 5. Nexus status (nexus.status)
 * 6. Unregister project (nexus.unregister)
 *
 * All tests use real nexus.db in temp directories. No mocks.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('Nexus domain E2E workflow', () => {
  let testDir: string;
  let cleoHome: string;
  let projectDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'nexus-e2e-'));
    cleoHome = join(testDir, '.cleo-home');
    projectDir = join(testDir, 'test-project');

    // Create directories
    await mkdir(cleoHome, { recursive: true });
    await mkdir(join(projectDir, '.cleo'), { recursive: true });

    // Set env vars to isolate from real data
    process.env['CLEO_HOME'] = cleoHome;
    process.env['CLEO_DIR'] = join(projectDir, '.cleo');
    process.env['CLEO_ROOT'] = projectDir;

    // Reset database singletons
    const { resetNexusDbState } = await import('../../src/store/nexus-sqlite.js');
    resetNexusDbState();
    const { closeDb } = await import('../../src/store/sqlite.js');
    closeDb();
  });

  afterEach(async () => {
    const { closeAllDatabases } = await import('../../src/store/sqlite.js');
    await closeAllDatabases();
    const { resetNexusDbState } = await import('../../src/store/nexus-sqlite.js');
    resetNexusDbState();
    delete process.env['CLEO_HOME'];
    delete process.env['CLEO_DIR'];
    delete process.env['CLEO_ROOT'];
    await rm(testDir, { recursive: true, force: true });
  });

  it('should initialize nexus via nexusInit', async () => {
    const { nexusInit } = await import('../../src/core/nexus/registry.js');

    await nexusInit();

    // Verify nexus.db was created
    const { readRegistry } = await import('../../src/core/nexus/registry.js');
    const registry = await readRegistry();
    expect(registry).not.toBeNull();
    expect(registry!.projects).toBeDefined();
    expect(Object.keys(registry!.projects).length).toBe(0);
  });

  it('should register a project and list it', async () => {
    const { nexusInit, nexusRegister, nexusList } = await import(
      '../../src/core/nexus/registry.js'
    );

    // Initialize tasks.db so project is recognized as a CLEO project
    const { getDb } = await import('../../src/store/sqlite.js');
    await getDb();

    await nexusInit();
    const hash = await nexusRegister(projectDir, 'test-project', 'read');
    expect(hash).toBeTruthy();
    expect(typeof hash).toBe('string');

    const projects = await nexusList();
    expect(projects.length).toBe(1);
    expect(projects[0].name).toBe('test-project');
    expect(projects[0].hash).toBe(hash);
  });

  it('should show a registered project by name', async () => {
    const { nexusGetProject, nexusInit, nexusRegister } = await import(
      '../../src/core/nexus/registry.js'
    );

    const { getDb } = await import('../../src/store/sqlite.js');
    await getDb();

    await nexusInit();
    await nexusRegister(projectDir, 'show-project', 'read');

    const project = await nexusGetProject('show-project');
    expect(project).not.toBeNull();
    expect(project!.name).toBe('show-project');
    expect(project!.path).toBe(projectDir);
    expect(project!.permissions).toBe('read');
  });

  it('should report nexus status correctly', async () => {
    const { nexusInit, readRegistry } = await import('../../src/core/nexus/registry.js');

    // Before init, readRegistry returns null
    const { resetNexusDbState } = await import('../../src/store/nexus-sqlite.js');
    resetNexusDbState();

    // After init, should have empty registry
    await nexusInit();
    const registry = await readRegistry();
    expect(registry).not.toBeNull();
    expect(Object.keys(registry!.projects).length).toBe(0);
  });

  it('should unregister a project', async () => {
    const { nexusInit, nexusList, nexusRegister, nexusUnregister } = await import(
      '../../src/core/nexus/registry.js'
    );

    const { getDb } = await import('../../src/store/sqlite.js');
    await getDb();

    await nexusInit();
    await nexusRegister(projectDir, 'unreg-project', 'read');

    // Verify it's registered
    let projects = await nexusList();
    expect(projects.length).toBe(1);

    // Unregister
    await nexusUnregister('unreg-project');

    // Verify it's gone
    projects = await nexusList();
    expect(projects.length).toBe(0);
  });

  it('full lifecycle: init -> register -> list -> show -> unregister', async () => {
    const { nexusGetProject, nexusInit, nexusList, nexusRegister, nexusUnregister, readRegistry } =
      await import('../../src/core/nexus/registry.js');

    const { getDb } = await import('../../src/store/sqlite.js');
    await getDb();

    // Init
    await nexusInit();
    const reg = await readRegistry();
    expect(reg).not.toBeNull();

    // Register
    const hash = await nexusRegister(projectDir, 'lifecycle-project', 'write');
    expect(hash).toBeTruthy();

    // List
    const projects = await nexusList();
    expect(projects.length).toBe(1);
    expect(projects[0].name).toBe('lifecycle-project');

    // Show
    const project = await nexusGetProject('lifecycle-project');
    expect(project).not.toBeNull();
    expect(project!.permissions).toBe('write');

    // Unregister
    await nexusUnregister('lifecycle-project');
    const afterList = await nexusList();
    expect(afterList.length).toBe(0);
  });
});
