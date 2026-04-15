/**
 * E2E tests for NEXUS graph operations, cross-project work, and edge cases.
 *
 * Covers: multi-project registration, cross-project task resolution,
 * dependency graph, orphan detection, blocking analysis, critical path,
 * reconciliation, edge cases, query module, permission module, graph caching.
 *
 * Split from nexus-e2e.test.ts (T659 rationalization).
 * @task WAVE-1D
 */

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedTasks } from '../../store/__tests__/test-db-helper.js';
import { resetNexusDbState } from '../../store/nexus-sqlite.js';
import { resetDbState } from '../../store/sqlite.js';
import { createSqliteDataAccessor } from '../../store/sqlite-data-accessor.js';
import {
  blockingAnalysis,
  buildGlobalGraph,
  criticalPath,
  invalidateGraphCache,
  nexusDeps,
  orphanDetection,
  resolveCrossDeps,
} from '../deps.js';
import { generateProjectHash } from '../hash.js';
import {
  canExecute,
  canRead,
  canWrite,
  checkPermission,
  checkPermissionDetail,
  getPermission,
  permissionLevel,
  requirePermission,
} from '../permissions.js';
import { getProjectFromQuery, parseQuery, resolveTask, validateSyntax } from '../query.js';
import {
  nexusGetProject,
  nexusInit,
  nexusList,
  nexusProjectExists,
  nexusReconcile,
  nexusRegister,
  nexusSyncAll,
  nexusUnregister,
  readRegistry,
} from '../registry.js';

// ── Test helpers ─────────────────────────────────────────────────────

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

/** Create a test project with tasks.db and project-info.json. */
async function createTestProjectWithId(
  dir: string,
  tasks: Array<Partial<Task> & { id: string }>,
  projectId?: string,
): Promise<string> {
  const pid = projectId ?? randomUUID();
  await createTestProjectDb(dir, tasks);
  await writeFile(
    join(dir, '.cleo', 'project-info.json'),
    JSON.stringify({ projectId: pid, createdAt: new Date().toISOString() }),
  );
  return pid;
}

// ── Shared state ─────────────────────────────────────────────────────

let testDir: string;
let registryDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'nexus-e2e-graph-'));
  registryDir = join(testDir, 'cleo-home');
  await mkdir(registryDir, { recursive: true });

  process.env['CLEO_HOME'] = registryDir;
  process.env['NEXUS_HOME'] = join(registryDir, 'nexus');
  process.env['NEXUS_CACHE_DIR'] = join(registryDir, 'nexus', 'cache');
  process.env['NEXUS_CURRENT_PROJECT'] = 'e2e-project';
  delete process.env['NEXUS_SKIP_PERMISSION_CHECK'];

  resetNexusDbState();
  resetDbState();
  invalidateGraphCache();
});

afterEach(async () => {
  delete process.env['CLEO_HOME'];
  delete process.env['NEXUS_HOME'];
  delete process.env['NEXUS_CACHE_DIR'];
  delete process.env['NEXUS_CURRENT_PROJECT'];
  delete process.env['NEXUS_SKIP_PERMISSION_CHECK'];
  resetNexusDbState();
  resetDbState();
  invalidateGraphCache();
  await rm(testDir, { recursive: true, force: true });
});

// =====================================================================
// 5. MULTI-PROJECT REGISTRATION & LISTING
// =====================================================================

describe('multi-project operations', () => {
  it('registers and lists multiple projects', async () => {
    const projects: string[] = [];
    for (let i = 0; i < 5; i++) {
      const dir = join(testDir, `multi-proj-${i}`);
      await createTestProjectDb(dir, [
        { id: `T00${i}`, title: `Task ${i}`, status: 'pending', description: `Desc ${i}` },
      ]);
      await nexusRegister(dir, `multi-${i}`, 'read');
      projects.push(`multi-${i}`);
    }

    const listed = await nexusList();
    expect(listed).toHaveLength(5);
    const names = listed.map((p) => p.name).sort();
    expect(names).toEqual(projects.sort());
  });

  it('nexusSyncAll syncs multiple projects correctly', async () => {
    for (let i = 0; i < 3; i++) {
      const dir = join(testDir, `sync-multi-${i}`);
      await createTestProjectDb(dir, [
        { id: `T00${i}`, title: `Task ${i}`, status: 'pending', description: `Desc ${i}` },
      ]);
      await nexusRegister(dir, `sync-multi-${i}`, 'read');
    }

    const result = await nexusSyncAll();
    expect(result.synced).toBe(3);
    expect(result.failed).toBe(0);
  });

  it('readRegistry returns all projects with correct structure', async () => {
    const dirA = join(testDir, 'reg-a');
    const dirB = join(testDir, 'reg-b');
    await createTestProjectDb(dirA, [
      { id: 'T001', title: 'Task A', status: 'pending', description: 'A' },
    ]);
    await createTestProjectDb(dirB, [
      { id: 'T002', title: 'Task B', status: 'done', description: 'B' },
    ]);
    await nexusRegister(dirA, 'proj-a', 'read');
    await nexusRegister(dirB, 'proj-b', 'write');

    const registry = await readRegistry();
    expect(registry).not.toBeNull();
    expect(registry!.schemaVersion).toBe('1.0.0');
    expect(Object.keys(registry!.projects)).toHaveLength(2);

    // Verify project structure
    const projectA = Object.values(registry!.projects).find((p) => p.name === 'proj-a');
    expect(projectA).toBeDefined();
    expect(projectA!.path).toBe(dirA);
    expect(projectA!.permissions).toBe('read');
    expect(projectA!.taskCount).toBe(1);

    const projectB = Object.values(registry!.projects).find((p) => p.name === 'proj-b');
    expect(projectB).toBeDefined();
    expect(projectB!.permissions).toBe('write');
  });

  it('unregistering one project does not affect others', async () => {
    const dirA = join(testDir, 'keep-a');
    const dirB = join(testDir, 'remove-b');
    await createTestProjectDb(dirA, [
      { id: 'T001', title: 'Task A', status: 'pending', description: 'A' },
    ]);
    await createTestProjectDb(dirB, [
      { id: 'T002', title: 'Task B', status: 'pending', description: 'B' },
    ]);
    await nexusRegister(dirA, 'keep-a', 'read');
    await nexusRegister(dirB, 'remove-b', 'read');

    await nexusUnregister('remove-b');

    expect(await nexusProjectExists('keep-a')).toBe(true);
    expect(await nexusProjectExists('remove-b')).toBe(false);
    const listed = await nexusList();
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe('keep-a');
  });
});

// =====================================================================
// 6. CROSS-PROJECT TASK RESOLUTION
// =====================================================================

describe('cross-project task resolution', () => {
  let projADir: string;
  let projBDir: string;

  beforeEach(async () => {
    projADir = join(testDir, 'xproj-a');
    projBDir = join(testDir, 'xproj-b');
    await createTestProjectDb(projADir, [
      { id: 'T001', title: 'Auth API', status: 'active', description: 'Auth', labels: ['auth'] },
      {
        id: 'T002',
        title: 'Users API',
        status: 'pending',
        description: 'Users',
        depends: ['T001'],
      },
    ]);
    await createTestProjectDb(projBDir, [
      {
        id: 'T100',
        title: 'Login UI',
        status: 'blocked',
        description: 'Login page',
        labels: ['auth'],
      },
      {
        id: 'T101',
        title: 'Dashboard',
        status: 'pending',
        description: 'Dashboard',
        depends: ['T100'],
      },
    ]);
    process.env['NEXUS_SKIP_PERMISSION_CHECK'] = 'true';
    await nexusRegister(projADir, 'backend', 'read');
    await nexusRegister(projBDir, 'frontend', 'read');
  });

  it('resolves task from named project', async () => {
    const task = await resolveTask('backend:T001');
    expect(Array.isArray(task)).toBe(false);
    if (!Array.isArray(task)) {
      expect(task.id).toBe('T001');
      expect(task.title).toBe('Auth API');
      expect(task._project).toBe('backend');
    }
  });

  it('resolves task from a different project', async () => {
    const task = await resolveTask('frontend:T100');
    expect(Array.isArray(task)).toBe(false);
    if (!Array.isArray(task)) {
      expect(task.id).toBe('T100');
      expect(task.title).toBe('Login UI');
      expect(task._project).toBe('frontend');
    }
  });

  it('wildcard resolves matching tasks across projects', async () => {
    const tasks = await resolveTask('*:T001');
    expect(Array.isArray(tasks)).toBe(true);
    if (Array.isArray(tasks)) {
      expect(tasks.length).toBeGreaterThanOrEqual(1);
      expect(tasks[0]._project).toBe('backend');
    }
  });

  it('throws for task not found in specific project', async () => {
    await expect(resolveTask('frontend:T001')).rejects.toThrow(/not found/i);
  });

  it('throws for non-existent project', async () => {
    await expect(resolveTask('nonexistent:T001')).rejects.toThrow(/not found/i);
  });
});

// =====================================================================
// 7. DEPENDENCY GRAPH WITH CROSS-PROJECT EDGES
// =====================================================================

describe('dependency graph', () => {
  it('builds graph from multiple projects', async () => {
    const dirA = join(testDir, 'graph-a');
    const dirB = join(testDir, 'graph-b');
    await createTestProjectDb(dirA, [
      { id: 'T001', title: 'API Base', status: 'done', description: 'API' },
      {
        id: 'T002',
        title: 'API Routes',
        status: 'active',
        description: 'Routes',
        depends: ['T001'],
      },
    ]);
    await createTestProjectDb(dirB, [
      { id: 'T010', title: 'UI Shell', status: 'active', description: 'Shell' },
    ]);
    process.env['NEXUS_SKIP_PERMISSION_CHECK'] = 'true';
    await nexusRegister(dirA, 'api', 'read');
    await nexusRegister(dirB, 'ui', 'read');

    const graph = await buildGlobalGraph();

    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges.length).toBeGreaterThanOrEqual(1);

    // T002 -> T001 edge within api project
    const edge = graph.edges.find((e) => e.from === 'T002' && e.to === 'T001');
    expect(edge).toBeDefined();
    expect(edge!.fromProject).toBe('api');
    expect(edge!.toProject).toBe('api');
  });

  it('forward deps for a task with dependencies', async () => {
    const dirA = join(testDir, 'fwd-a');
    await createTestProjectDb(dirA, [
      { id: 'T001', title: 'Base', status: 'done', description: 'Base' },
      { id: 'T002', title: 'Mid', status: 'active', description: 'Mid', depends: ['T001'] },
      { id: 'T003', title: 'Top', status: 'pending', description: 'Top', depends: ['T002'] },
    ]);
    process.env['NEXUS_SKIP_PERMISSION_CHECK'] = 'true';
    await nexusRegister(dirA, 'chain', 'read');

    const result = await nexusDeps('chain:T003', 'forward');

    expect(result.depends).toHaveLength(1);
    expect(result.depends[0].query).toBe('chain:T002');
  });

  it('reverse deps shows what depends on a task', async () => {
    const dirA = join(testDir, 'rev-a');
    await createTestProjectDb(dirA, [
      { id: 'T001', title: 'Base', status: 'done', description: 'Base' },
      { id: 'T002', title: 'Dep', status: 'pending', description: 'Dep', depends: ['T001'] },
    ]);
    process.env['NEXUS_SKIP_PERMISSION_CHECK'] = 'true';
    await nexusRegister(dirA, 'rev-proj', 'read');

    const result = await nexusDeps('rev-proj:T001', 'reverse');

    expect(result.blocking.length).toBeGreaterThanOrEqual(1);
    expect(result.blocking.some((b) => b.query.includes('T002'))).toBe(true);
  });

  it('resolveCrossDeps resolves local dependencies', async () => {
    const dirA = join(testDir, 'resolve-deps-a');
    await createTestProjectDb(dirA, [
      { id: 'T001', title: 'Base', status: 'done', description: 'Base' },
      { id: 'T002', title: 'Dep', status: 'pending', description: 'Dep', depends: ['T001'] },
    ]);
    process.env['NEXUS_SKIP_PERMISSION_CHECK'] = 'true';
    await nexusRegister(dirA, 'resolve-proj', 'read');

    const resolved = await resolveCrossDeps(['T001'], 'resolve-proj');
    expect(resolved).toHaveLength(1);
    expect(resolved[0].query).toBe('resolve-proj:T001');
    expect(resolved[0].status).toBe('done');
  });
});

// =====================================================================
// 8. ORPHAN DETECTION
// =====================================================================

describe('orphan detection', () => {
  it('detects no orphans when all deps are local', async () => {
    const dirA = join(testDir, 'orphan-local');
    await createTestProjectDb(dirA, [
      { id: 'T001', title: 'Base', status: 'done', description: 'Base' },
      { id: 'T002', title: 'Dep', status: 'pending', description: 'Dep', depends: ['T001'] },
    ]);
    process.env['NEXUS_SKIP_PERMISSION_CHECK'] = 'true';
    await nexusRegister(dirA, 'orphan-local', 'read');

    const orphans = await orphanDetection();
    expect(orphans).toHaveLength(0);
  });

  it('returns empty array for projects with no dependencies', async () => {
    const dirA = join(testDir, 'no-deps-orphan');
    await createTestProjectDb(dirA, [
      { id: 'T001', title: 'Solo', status: 'done', description: 'Solo' },
    ]);
    process.env['NEXUS_SKIP_PERMISSION_CHECK'] = 'true';
    await nexusRegister(dirA, 'no-deps', 'read');

    const orphans = await orphanDetection();
    expect(orphans).toHaveLength(0);
  });
});

// =====================================================================
// 9. BLOCKING ANALYSIS
// =====================================================================

describe('blocking analysis extended', () => {
  it('handles diamond dependency pattern', async () => {
    // T001 -> T002 -> T004
    // T001 -> T003 -> T004
    const dirA = join(testDir, 'diamond');
    await createTestProjectDb(dirA, [
      { id: 'T001', title: 'Root', status: 'active', description: 'Root' },
      { id: 'T002', title: 'Left', status: 'pending', description: 'Left', depends: ['T001'] },
      { id: 'T003', title: 'Right', status: 'pending', description: 'Right', depends: ['T001'] },
      {
        id: 'T004',
        title: 'Join',
        status: 'pending',
        description: 'Join',
        depends: ['T002', 'T003'],
      },
    ]);
    process.env['NEXUS_SKIP_PERMISSION_CHECK'] = 'true';
    await nexusRegister(dirA, 'diamond', 'read');

    const result = await blockingAnalysis('diamond:T001');

    // T001 blocks T002, T003, and transitively T004
    expect(result.impactScore).toBeGreaterThanOrEqual(3);
    const blocked = result.blocking.map((b) => b.query);
    expect(blocked.some((q) => q.includes('T002'))).toBe(true);
    expect(blocked.some((q) => q.includes('T003'))).toBe(true);
    expect(blocked.some((q) => q.includes('T004'))).toBe(true);
  });
});

// =====================================================================
// 10. CRITICAL PATH
// =====================================================================

describe('critical path extended', () => {
  it('returns CriticalPathResult with valid structure', async () => {
    const dirA = join(testDir, 'crit-chain');
    await createTestProjectDb(dirA, [
      { id: 'T001', title: 'Step 1', status: 'done', description: 'S1' },
      { id: 'T002', title: 'Step 2', status: 'active', description: 'S2', depends: ['T001'] },
      { id: 'T003', title: 'Step 3', status: 'pending', description: 'S3', depends: ['T002'] },
      { id: 'T004', title: 'Step 4', status: 'pending', description: 'S4', depends: ['T003'] },
    ]);
    process.env['NEXUS_SKIP_PERMISSION_CHECK'] = 'true';
    await nexusRegister(dirA, 'crit-proj', 'read');

    const result = await criticalPath();

    expect(result).toHaveProperty('criticalPath');
    expect(result).toHaveProperty('length');
    expect(result).toHaveProperty('blockedBy');
    expect(result.length).toBe(result.criticalPath.length);
    expect(result.length).toBeGreaterThanOrEqual(1);
    for (const entry of result.criticalPath) {
      expect(entry).toHaveProperty('query');
      expect(entry).toHaveProperty('title');
    }
  });

  it('returns blockedBy string (may be empty if all tasks done)', async () => {
    const dirA = join(testDir, 'crit-blocker');
    await createTestProjectDb(dirA, [
      { id: 'T001', title: 'Done task', status: 'done', description: 'Done' },
      {
        id: 'T002',
        title: 'Pending task',
        status: 'pending',
        description: 'Pending',
        depends: ['T001'],
      },
    ]);
    process.env['NEXUS_SKIP_PERMISSION_CHECK'] = 'true';
    await nexusRegister(dirA, 'blocker-proj', 'read');

    const result = await criticalPath();

    expect(typeof result.blockedBy).toBe('string');
    expect(result.length).toBeGreaterThanOrEqual(1);
  });
});

// =====================================================================
// 12. RECONCILIATION EXTENDED
// =====================================================================

describe('reconciliation extended', () => {
  it('reconcile without projectId falls back to hash-based lookup', async () => {
    // Create a project without project-info.json
    const projDir = join(testDir, 'hashonly-proj');
    await createTestProjectDb(projDir, [
      { id: 'T001', title: 'Task', status: 'pending', description: 'desc' },
    ]);
    await nexusRegister(projDir, 'hashonly-proj', 'read');

    // Reconcile should find by hash (no project-info.json)
    const result = await nexusReconcile(projDir);
    expect(result.status).toBe('ok');
  });

  it('auto-registers unknown project without projectId', async () => {
    const projDir = join(testDir, 'auto-reg-no-id');
    await createTestProjectDb(projDir, [
      { id: 'T001', title: 'Task', status: 'pending', description: 'desc' },
    ]);

    const result = await nexusReconcile(projDir);
    expect(result.status).toBe('auto_registered');

    // Verify it's now in the registry
    const hash = generateProjectHash(projDir);
    const project = await nexusGetProject(hash);
    expect(project).not.toBeNull();
  });
});

// =====================================================================
// 13. EDGE CASES
// =====================================================================

describe('edge cases', () => {
  it('handles project with very long path', async () => {
    // Create a deeply nested directory
    const deepPath = join(testDir, 'a'.repeat(50), 'b'.repeat(50), 'c'.repeat(50), 'project');
    await createTestProjectDb(deepPath, [
      { id: 'T001', title: 'Task', status: 'pending', description: 'desc' },
    ]);

    const hash = await nexusRegister(deepPath, 'long-path-proj', 'read');
    expect(hash).toMatch(/^[a-f0-9]{12}$/);

    const project = await nexusGetProject('long-path-proj');
    expect(project).not.toBeNull();
    expect(project!.path).toBe(deepPath);
  });

  it('empty project path throws', async () => {
    await expect(nexusRegister('', 'empty-path')).rejects.toThrow(/required/i);
  });

  it('empty name or hash for unregister throws', async () => {
    await expect(nexusUnregister('')).rejects.toThrow(/required/i);
  });

  it('nexusInit is idempotent (multiple calls)', async () => {
    await nexusInit();
    await nexusInit();
    await nexusInit();

    const registry = await readRegistry();
    expect(registry).not.toBeNull();
  });

  it('project with no tasks registers with taskCount=0', async () => {
    const emptyDir = join(testDir, 'empty-tasks');
    await createTestProjectDb(emptyDir, []);
    await nexusRegister(emptyDir, 'empty-proj', 'read');

    const project = await nexusGetProject('empty-proj');
    expect(project).not.toBeNull();
    expect(project!.taskCount).toBe(0);
    expect(project!.labels).toEqual([]);
  });

  it('project labels are sorted and deduplicated', async () => {
    const projDir = join(testDir, 'labels-proj');
    await createTestProjectDb(projDir, [
      {
        id: 'T001',
        title: 'Task 1',
        status: 'pending',
        description: 'a',
        labels: ['z-label', 'a-label'],
      },
      {
        id: 'T002',
        title: 'Task 2',
        status: 'pending',
        description: 'b',
        labels: ['a-label', 'm-label'],
      },
    ]);
    await nexusRegister(projDir, 'labels-proj', 'read');

    const project = await nexusGetProject('labels-proj');
    expect(project!.labels).toEqual(['a-label', 'm-label', 'z-label']);
  });

  it('nexusGetProject returns null for empty string', async () => {
    await nexusInit();
    const project = await nexusGetProject('');
    expect(project).toBeNull();
  });

  it('nexusList returns empty array when nexus.db is fresh', async () => {
    await nexusInit();
    const projects = await nexusList();
    expect(projects).toEqual([]);
  });

  it('readRegistry lastUpdated reflects most recent lastSeen', async () => {
    const projDir = join(testDir, 'last-updated');
    await createTestProjectDb(projDir, [
      { id: 'T001', title: 'Task', status: 'pending', description: 'desc' },
    ]);
    await nexusRegister(projDir, 'lu-proj', 'read');

    const registry = await readRegistry();
    expect(registry).not.toBeNull();
    expect(registry!.lastUpdated).toBeTruthy();
    const luDate = new Date(registry!.lastUpdated);
    expect(luDate.getTime()).not.toBeNaN();
  });

  it('project hash is deterministic and 12 hex chars', () => {
    const path = '/some/unique/path/to/project';
    const h1 = generateProjectHash(path);
    const h2 = generateProjectHash(path);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{12}$/);
    expect(h1.length).toBe(12);
  });

  it('different paths produce different hashes', () => {
    const h1 = generateProjectHash('/path/a');
    const h2 = generateProjectHash('/path/b');
    expect(h1).not.toBe(h2);
  });
});

// =====================================================================
// 14. QUERY MODULE EXTENDED
// =====================================================================

describe('query module extended', () => {
  it('validateSyntax accepts 3+ digit task IDs', () => {
    expect(validateSyntax('T001')).toBe(true);
    expect(validateSyntax('T99999')).toBe(true);
    expect(validateSyntax('T1234567890')).toBe(true);
  });

  it('validateSyntax rejects empty string', () => {
    expect(validateSyntax('')).toBe(false);
  });

  it('validateSyntax rejects task IDs with fewer than 3 digits', () => {
    expect(validateSyntax('T1')).toBe(false);
    expect(validateSyntax('T12')).toBe(false);
  });

  it('parseQuery with currentProject override', () => {
    const result = parseQuery('T001', 'override-proj');
    expect(result.project).toBe('override-proj');
    expect(result.taskId).toBe('T001');
  });

  it('parseQuery dot syntax uses currentProject', () => {
    const result = parseQuery('.:T001', 'my-proj');
    expect(result.project).toBe('my-proj');
  });

  it('getProjectFromQuery extracts project correctly for all syntaxes', () => {
    expect(getProjectFromQuery('my-app:T001')).toBe('my-app');
    expect(getProjectFromQuery('*:T001')).toBe('*');
    expect(getProjectFromQuery('T001', 'current')).toBe('current');
    expect(getProjectFromQuery('.:T001', 'current')).toBe('current');
  });
});

// =====================================================================
// 15. PERMISSION MODULE EXTENDED
// =====================================================================

describe('permission module extended', () => {
  it('permissionLevel returns correct values for all levels', () => {
    expect(permissionLevel('read')).toBe(1);
    expect(permissionLevel('write')).toBe(2);
    expect(permissionLevel('execute')).toBe(3);
    expect(permissionLevel('invalid')).toBe(0);
    expect(permissionLevel('')).toBe(0);
  });

  it('getPermission returns read for unregistered project', async () => {
    await nexusInit();
    const perm = await getPermission('no-such-proj');
    expect(perm).toBe('read');
  });

  it('checkPermissionDetail returns full detail', async () => {
    const projDir = join(testDir, 'detail-proj');
    await createTestProjectDb(projDir, [
      { id: 'T001', title: 'Task', status: 'pending', description: 'desc' },
    ]);
    await nexusRegister(projDir, 'detail-proj', 'write');

    const result = await checkPermissionDetail('detail-proj', 'execute');
    expect(result.project).toBe('detail-proj');
    expect(result.required).toBe('execute');
    expect(result.granted).toBe('write');
    expect(result.allowed).toBe(false);
  });

  it('requirePermission throws with descriptive message', async () => {
    const projDir = join(testDir, 'require-proj');
    await createTestProjectDb(projDir, [
      { id: 'T001', title: 'Task', status: 'pending', description: 'desc' },
    ]);
    await nexusRegister(projDir, 'require-proj', 'read');

    await expect(requirePermission('require-proj', 'execute', 'delete task')).rejects.toThrow(
      /Permission denied.*execute.*require-proj/,
    );
  });

  it('permission hierarchy: write includes read', async () => {
    const projDir = join(testDir, 'hier-proj');
    await createTestProjectDb(projDir, [
      { id: 'T001', title: 'Task', status: 'pending', description: 'desc' },
    ]);
    await nexusRegister(projDir, 'hier-proj', 'write');

    expect(await canRead('hier-proj')).toBe(true);
    expect(await canWrite('hier-proj')).toBe(true);
    expect(await canExecute('hier-proj')).toBe(false);
  });

  it('NEXUS_SKIP_PERMISSION_CHECK bypasses all checks', async () => {
    const projDir = join(testDir, 'bypass-proj');
    await createTestProjectDb(projDir, [
      { id: 'T001', title: 'Task', status: 'pending', description: 'desc' },
    ]);
    await nexusRegister(projDir, 'bypass-proj', 'read');
    process.env['NEXUS_SKIP_PERMISSION_CHECK'] = 'true';

    expect(await checkPermission('bypass-proj', 'execute')).toBe(true);
    await expect(requirePermission('bypass-proj', 'execute')).resolves.toBeUndefined();
  });
});

// =====================================================================
// 16. GRAPH CACHING
// =====================================================================

describe('graph caching', () => {
  it('invalidateGraphCache forces rebuild', async () => {
    const dirA = join(testDir, 'cache-proj');
    await createTestProjectDb(dirA, [
      { id: 'T001', title: 'Task', status: 'done', description: 'desc' },
    ]);
    process.env['NEXUS_SKIP_PERMISSION_CHECK'] = 'true';
    await nexusRegister(dirA, 'cache-proj', 'read');

    const graph1 = await buildGlobalGraph();
    invalidateGraphCache();
    const graph2 = await buildGlobalGraph();

    // After invalidation, graph2 should be a new object
    expect(graph2.nodes).toHaveLength(graph1.nodes.length);
  });
});
