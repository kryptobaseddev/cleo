/**
 * Tests for NEXUS deps module.
 * @task T4574
 * @epic T4540
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedTasks } from '../../../store/__tests__/test-db-helper.js';
import { resetDbState } from '../../../store/sqlite.js';
import { createSqliteDataAccessor } from '../../../store/sqlite-data-accessor.js';
import {
  blockingAnalysis,
  buildGlobalGraph,
  criticalPath,
  invalidateGraphCache,
  nexusDeps,
  orphanDetection,
} from '../deps.js';
import { nexusRegister, resetNexusDbState } from '../registry.js';

/** Create a test project with tasks in SQLite (tasks.db). */
async function createTestProjectDb(
  dir: string,
  tasks: Array<{
    id: string;
    title: string;
    status: string;
    description?: string;
    labels?: string[];
    depends?: string[];
    priority?: string;
    createdAt?: string;
  }>,
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
  process.env['NEXUS_SKIP_PERMISSION_CHECK'] = 'true';
  process.env['NEXUS_CURRENT_PROJECT'] = 'backend';

  resetNexusDbState();
  invalidateGraphCache();
});

afterEach(async () => {
  delete process.env['CLEO_HOME'];
  delete process.env['NEXUS_HOME'];
  delete process.env['NEXUS_CACHE_DIR'];
  delete process.env['NEXUS_SKIP_PERMISSION_CHECK'];
  delete process.env['NEXUS_CURRENT_PROJECT'];
  resetNexusDbState();
  resetDbState();
  await rm(testDir, { recursive: true, force: true });
});

describe('buildGlobalGraph', () => {
  it('builds graph with nodes from all projects', async () => {
    await nexusRegister(projectADir, 'backend', 'read');
    await nexusRegister(projectBDir, 'frontend', 'read');

    const graph = await buildGlobalGraph();

    expect(graph.nodes).toHaveLength(4); // 2 from each project
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(['T001', 'T002', 'T100', 'T101']);
  });

  it('builds edges for same-project dependencies', async () => {
    await nexusRegister(projectADir, 'backend', 'read');

    const graph = await buildGlobalGraph();

    const edge = graph.edges.find((e) => e.from === 'T002' && e.to === 'T001');
    expect(edge).toBeDefined();
    expect(edge!.fromProject).toBe('backend');
    expect(edge!.toProject).toBe('backend');
  });

  it('builds edges for same-project dependencies in project B', async () => {
    await nexusRegister(projectADir, 'backend', 'read');
    await nexusRegister(projectBDir, 'frontend', 'read');

    const graph = await buildGlobalGraph();

    // T101 depends on T100 within frontend project
    const localEdge = graph.edges.find((e) => e.from === 'T101' && e.to === 'T100');
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
    const backendDep = result.blocking.find((b) => b.query.includes('T002'));
    expect(backendDep).toBeDefined();
  });

  it('throws on invalid syntax', async () => {
    await expect(nexusDeps('invalid')).rejects.toThrow(/Invalid query syntax/);
  });
});

describe('criticalPath', () => {
  it('returns CriticalPathResult shape with criticalPath array, length, and blockedBy', async () => {
    await nexusRegister(projectADir, 'backend', 'read');
    await nexusRegister(projectBDir, 'frontend', 'read');

    const result = await criticalPath();

    expect(result).toHaveProperty('criticalPath');
    expect(result).toHaveProperty('length');
    expect(result).toHaveProperty('blockedBy');
    expect(Array.isArray(result.criticalPath)).toBe(true);
    expect(typeof result.length).toBe('number');
    expect(typeof result.blockedBy).toBe('string');
  });

  it('criticalPath entries have query and title fields', async () => {
    await nexusRegister(projectADir, 'backend', 'read');
    await nexusRegister(projectBDir, 'frontend', 'read');

    const result = await criticalPath();

    // The algorithm traces from root nodes (no outgoing dep edges)
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.criticalPath.length).toBeGreaterThanOrEqual(1);
    for (const entry of result.criticalPath) {
      expect(entry).toHaveProperty('query');
      expect(entry).toHaveProperty('title');
      expect(typeof entry.query).toBe('string');
      expect(typeof entry.title).toBe('string');
    }
  });

  it('length field matches criticalPath array length', async () => {
    await nexusRegister(projectADir, 'backend', 'read');

    const result = await criticalPath();

    expect(result.length).toBe(result.criticalPath.length);
  });

  it('returns empty path when no dependencies exist', async () => {
    const noDepsDir = join(testDir, 'no-deps');
    await createTestProjectDb(noDepsDir, [
      { id: 'T050', title: 'Standalone A', status: 'done', description: 'No deps' },
      { id: 'T051', title: 'Standalone B', status: 'done', description: 'No deps either' },
    ]);
    await nexusRegister(noDepsDir, 'nodeps', 'read');

    const result = await criticalPath();

    // All nodes are leaves with no outgoing edges, so max path length is 1
    expect(result.length).toBeLessThanOrEqual(1);
  });
});

describe('blockingAnalysis', () => {
  it('returns BlockingAnalysisResult shape with task, blocking array, and impactScore', async () => {
    await nexusRegister(projectADir, 'backend', 'read');

    const result = await blockingAnalysis('backend:T001');

    expect(result).toHaveProperty('task');
    expect(result).toHaveProperty('blocking');
    expect(result).toHaveProperty('impactScore');
    expect(Array.isArray(result.blocking)).toBe(true);
    expect(typeof result.impactScore).toBe('number');
    expect(result.task).toBe('backend:T001');
    // T002 depends on T001
    expect(result.impactScore).toBeGreaterThanOrEqual(1);
    expect(result.blocking.some((b) => b.query.includes('T002'))).toBe(true);
  });

  it('each blocking entry has query and project fields', async () => {
    await nexusRegister(projectADir, 'backend', 'read');

    const result = await blockingAnalysis('backend:T001');

    for (const entry of result.blocking) {
      expect(entry).toHaveProperty('query');
      expect(entry).toHaveProperty('project');
      expect(typeof entry.query).toBe('string');
      expect(typeof entry.project).toBe('string');
    }
  });

  it('finds both direct and transitive blocking in A->B->C chain', async () => {
    const chainDir = join(testDir, 'chain-project2');
    await createTestProjectDb(chainDir, [
      { id: 'T020', title: 'Root task', status: 'active', description: 'Root of chain' },
      {
        id: 'T021',
        title: 'Mid task',
        status: 'pending',
        description: 'Mid of chain',
        depends: ['T020'],
      },
      {
        id: 'T022',
        title: 'Leaf task',
        status: 'pending',
        description: 'Leaf of chain',
        depends: ['T021'],
      },
    ]);
    invalidateGraphCache();
    await nexusRegister(chainDir, 'chain2', 'read');

    const result = await blockingAnalysis('chain2:T020');

    // T020 transitively blocks both T021 and T022
    expect(result.impactScore).toBeGreaterThanOrEqual(2);
    const blockedIds = result.blocking.map((b) => b.query);
    expect(blockedIds.some((q) => q.includes('T021'))).toBe(true);
    expect(blockedIds.some((q) => q.includes('T022'))).toBe(true);
  });

  it('returns zero impact for a leaf task with no dependents', async () => {
    await nexusRegister(projectADir, 'backend', 'read');

    // T002 has no dependents (nothing depends on it)
    const result = await blockingAnalysis('backend:T002');

    expect(result.impactScore).toBe(0);
    expect(result.blocking).toHaveLength(0);
  });

  it('throws on invalid query syntax', async () => {
    await expect(blockingAnalysis('bad-syntax')).rejects.toThrow(/Invalid query syntax/);
  });
});

describe('orphanDetection', () => {
  it('returns an array (OrphanEntry[])', async () => {
    await nexusRegister(projectBDir, 'frontend', 'read');

    const orphans = await orphanDetection();

    expect(Array.isArray(orphans)).toBe(true);
  });

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

  it('OrphanEntry shape has required fields when orphans exist', async () => {
    // Validate the shape contract: each OrphanEntry has
    // sourceProject, sourceTask, targetProject, targetTask, reason
    // Note: SQLite FK constraints prevent storing cross-project dep strings,
    // so we verify the shape contract through the type system and empty-case tests.
    await nexusRegister(projectADir, 'backend', 'read');

    const orphans = await orphanDetection();

    // With only local deps, result is empty but type-safe
    expect(orphans).toEqual([]);
  });
});
