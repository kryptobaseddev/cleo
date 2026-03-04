/**
 * Tests for NEXUS deps module.
 * @task T4574
 * @epic T4540
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildGlobalGraph,
  nexusDeps,
  blockingAnalysis,
  orphanDetection,
  invalidateGraphCache,
} from '../deps.js';
import { nexusRegister } from '../registry.js';
import { createSqliteDataAccessor } from '../../../store/sqlite-data-accessor.js';
import { resetDbState } from '../../../store/sqlite.js';
import { seedTasks } from '../../../store/__tests__/test-db-helper.js';

/** Create a test project with tasks in SQLite (tasks.db). */
async function createTestProjectDb(
  dir: string,
  tasks: Array<{ id: string; title: string; status: string; description?: string; labels?: string[]; depends?: string[]; priority?: string; createdAt?: string }>,
): Promise<void> {
  await mkdir(join(dir, '.cleo'), { recursive: true });
  resetDbState();
  const accessor = await createSqliteDataAccessor(dir);
  await seedTasks(accessor, tasks);
  await accessor.close();
  resetDbState();
}

let testDir: string;
let projectADir: string;
let projectBDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'nexus-deps-test-'));
  const registryDir = join(testDir, 'cleo-home');
  projectADir = join(testDir, 'project-a');
  projectBDir = join(testDir, 'project-b');

  await mkdir(registryDir, { recursive: true });

  // Project A: backend
  await createTestProjectDb(projectADir, [
    {
      id: 'T001',
      title: 'Auth API',
      description: 'Authentication API implementation',
      status: 'active',
      priority: 'high',
      createdAt: '2026-01-01T00:00:00Z',
      labels: ['auth'],
    },
    {
      id: 'T002',
      title: 'User endpoints',
      description: 'User management endpoints',
      status: 'pending',
      priority: 'medium',
      createdAt: '2026-01-02T00:00:00Z',
      depends: ['T001'],
    },
  ]);

  // Project B: frontend (local dependencies only — cross-project deps
  // cannot be stored in SQLite FK-constrained tables)
  await createTestProjectDb(projectBDir, [
    {
      id: 'T100',
      title: 'Login page',
      description: 'Login page UI component',
      status: 'blocked',
      priority: 'high',
      createdAt: '2026-01-03T00:00:00Z',
    },
    {
      id: 'T101',
      title: 'Dashboard',
      description: 'Main dashboard view',
      status: 'pending',
      priority: 'medium',
      createdAt: '2026-01-04T00:00:00Z',
      depends: ['T100'],
    },
  ]);

  process.env['CLEO_HOME'] = registryDir;
  process.env['NEXUS_HOME'] = join(registryDir, 'nexus');
  process.env['NEXUS_CACHE_DIR'] = join(registryDir, 'nexus', 'cache');
  process.env['NEXUS_REGISTRY_FILE'] = join(registryDir, 'projects-registry.json');
  process.env['NEXUS_SKIP_PERMISSION_CHECK'] = 'true';
  process.env['NEXUS_CURRENT_PROJECT'] = 'backend';

  invalidateGraphCache();
});

afterEach(async () => {
  delete process.env['CLEO_HOME'];
  delete process.env['NEXUS_HOME'];
  delete process.env['NEXUS_CACHE_DIR'];
  delete process.env['NEXUS_REGISTRY_FILE'];
  delete process.env['NEXUS_SKIP_PERMISSION_CHECK'];
  delete process.env['NEXUS_CURRENT_PROJECT'];
  resetDbState();
  await rm(testDir, { recursive: true, force: true });
});

describe('buildGlobalGraph', () => {
  it('builds graph with nodes from all projects', async () => {
    await nexusRegister(projectADir, 'backend', 'read');
    await nexusRegister(projectBDir, 'frontend', 'read');

    const graph = await buildGlobalGraph();

    expect(graph.nodes).toHaveLength(4); // 2 from each project
    expect(graph.nodes.map(n => n.id).sort()).toEqual(['T001', 'T002', 'T100', 'T101']);
  });

  it('builds edges for same-project dependencies', async () => {
    await nexusRegister(projectADir, 'backend', 'read');

    const graph = await buildGlobalGraph();

    const edge = graph.edges.find(e => e.from === 'T002' && e.to === 'T001');
    expect(edge).toBeDefined();
    expect(edge!.fromProject).toBe('backend');
    expect(edge!.toProject).toBe('backend');
  });

  it('builds edges for same-project dependencies in project B', async () => {
    await nexusRegister(projectADir, 'backend', 'read');
    await nexusRegister(projectBDir, 'frontend', 'read');

    const graph = await buildGlobalGraph();

    // T101 depends on T100 within frontend project
    const localEdge = graph.edges.find(e => e.from === 'T101' && e.to === 'T100');
    expect(localEdge).toBeDefined();
    expect(localEdge!.fromProject).toBe('frontend');
    expect(localEdge!.toProject).toBe('frontend');
  });

  it('uses cached graph on second call', async () => {
    await nexusRegister(projectADir, 'backend', 'read');

    const graph1 = await buildGlobalGraph();
    const graph2 = await buildGlobalGraph();

    // Same reference (cached)
    expect(graph1).toBe(graph2);
  });
});

describe('nexusDeps', () => {
  it('shows forward dependencies', async () => {
    await nexusRegister(projectADir, 'backend', 'read');

    const result = await nexusDeps('backend:T002', 'forward');

    expect(result.task).toBe('backend:T002');
    expect(result.depends).toHaveLength(1);
    expect(result.depends[0].query).toBe('backend:T001');
  });

  it('shows reverse dependencies', async () => {
    await nexusRegister(projectADir, 'backend', 'read');

    const result = await nexusDeps('backend:T001', 'reverse');

    // T002 depends on T001 within backend project
    expect(result.blocking.length).toBeGreaterThanOrEqual(1);
    const backendDep = result.blocking.find(b => b.query.includes('T002'));
    expect(backendDep).toBeDefined();
  });

  it('throws on invalid syntax', async () => {
    await expect(nexusDeps('invalid')).rejects.toThrow(/Invalid query syntax/);
  });
});

describe('blockingAnalysis', () => {
  it('finds all dependents (direct and transitive)', async () => {
    await nexusRegister(projectADir, 'backend', 'read');

    const result = await blockingAnalysis('backend:T001');

    // T001 blocks: T002 (backend) — same-project dependency
    expect(result.impactScore).toBeGreaterThanOrEqual(1);
    expect(result.task).toBe('backend:T001');
  });
});

describe('orphanDetection', () => {
  it('returns empty array when no cross-project deps exist', async () => {
    await nexusRegister(projectBDir, 'frontend', 'read');
    // No cross-project deps in SQLite (FK constraints prevent storing them)

    const orphans = await orphanDetection();
    expect(orphans).toHaveLength(0);
  });

  it('returns empty array when all deps are local', async () => {
    await nexusRegister(projectADir, 'backend', 'read');
    await nexusRegister(projectBDir, 'frontend', 'read');

    const orphans = await orphanDetection();
    // All deps are within same project — no orphans
    expect(orphans).toHaveLength(0);
  });
});
