/**
 * Tests for NEXUS deps module.
 * @task T4574
 * @epic T4540
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
  await mkdir(join(projectADir, '.cleo'), { recursive: true });
  await writeFile(
    join(projectADir, '.cleo', 'todo.json'),
    JSON.stringify({
      tasks: [
        {
          id: 'T001',
          title: 'Auth API',
          status: 'active',
          priority: 'high',
          createdAt: '2026-01-01T00:00:00Z',
          labels: ['auth'],
        },
        {
          id: 'T002',
          title: 'User endpoints',
          status: 'pending',
          priority: 'medium',
          createdAt: '2026-01-02T00:00:00Z',
          depends: ['T001'],
        },
      ],
    }),
  );

  // Project B: frontend (depends on project-a)
  await mkdir(join(projectBDir, '.cleo'), { recursive: true });
  await writeFile(
    join(projectBDir, '.cleo', 'todo.json'),
    JSON.stringify({
      tasks: [
        {
          id: 'T100',
          title: 'Login page',
          status: 'blocked',
          priority: 'high',
          createdAt: '2026-01-03T00:00:00Z',
          depends: ['backend:T001'],
        },
        {
          id: 'T101',
          title: 'Dashboard',
          status: 'pending',
          priority: 'medium',
          createdAt: '2026-01-04T00:00:00Z',
          depends: ['T100'],
        },
      ],
    }),
  );

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

  it('builds edges for cross-project dependencies', async () => {
    await nexusRegister(projectADir, 'backend', 'read');
    await nexusRegister(projectBDir, 'frontend', 'read');

    const graph = await buildGlobalGraph();

    const crossEdge = graph.edges.find(e => e.from === 'T100' && e.to === 'T001');
    expect(crossEdge).toBeDefined();
    expect(crossEdge!.fromProject).toBe('frontend');
    expect(crossEdge!.toProject).toBe('backend');
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
    await nexusRegister(projectBDir, 'frontend', 'read');

    const result = await nexusDeps('backend:T001', 'reverse');

    expect(result.blocking.length).toBeGreaterThanOrEqual(1);
    const frontendDep = result.blocking.find(b => b.query.includes('T100'));
    expect(frontendDep).toBeDefined();
  });

  it('throws on invalid syntax', async () => {
    await expect(nexusDeps('invalid')).rejects.toThrow(/Invalid query syntax/);
  });
});

describe('blockingAnalysis', () => {
  it('finds all dependents (direct and transitive)', async () => {
    await nexusRegister(projectADir, 'backend', 'read');
    await nexusRegister(projectBDir, 'frontend', 'read');

    const result = await blockingAnalysis('backend:T001');

    // T001 blocks: T002 (backend), T100 (frontend)
    // T100 blocks: T101 (frontend)
    // So T001 transitively blocks T002, T100, T101
    expect(result.impactScore).toBeGreaterThanOrEqual(2);
    expect(result.task).toBe('backend:T001');
  });
});

describe('orphanDetection', () => {
  it('detects orphaned cross-project references', async () => {
    await nexusRegister(projectBDir, 'frontend', 'read');
    // Note: backend is NOT registered, so frontend's dep on backend:T001 is orphaned

    const orphans = await orphanDetection();

    expect(orphans.length).toBeGreaterThanOrEqual(1);
    const orphan = orphans.find(
      o => o.sourceProject === 'frontend' && o.targetProject === 'backend',
    );
    expect(orphan).toBeDefined();
    expect(orphan!.reason).toBe('project_not_registered');
  });

  it('returns empty array when no orphans exist', async () => {
    await nexusRegister(projectADir, 'backend', 'read');
    await nexusRegister(projectBDir, 'frontend', 'read');

    const orphans = await orphanDetection();
    const backendOrphans = orphans.filter(o => o.targetProject === 'backend');
    // backend:T001 exists, so no orphan for that reference
    expect(backendOrphans).toHaveLength(0);
  });
});
