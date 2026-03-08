import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock core nexus modules before importing the handler
vi.mock('../../../core/nexus/registry.js', () => ({
  nexusInit: vi.fn(),
  nexusRegister: vi.fn(),
  nexusUnregister: vi.fn(),
  nexusList: vi.fn(),
  nexusSync: vi.fn(),
  nexusSyncAll: vi.fn(),
  nexusGetProject: vi.fn(),
  readRegistry: vi.fn(),
  getNexusHome: vi.fn(() => '/mock/.cleo/nexus'),
}));

vi.mock('../../../core/nexus/query.js', () => ({
  resolveTask: vi.fn(),
  validateSyntax: vi.fn(),
}));

vi.mock('../../../core/nexus/deps.js', () => ({
  nexusDeps: vi.fn(),
  buildGlobalGraph: vi.fn(),
  criticalPath: vi.fn(),
  blockingAnalysis: vi.fn(),
  orphanDetection: vi.fn(),
}));

vi.mock('../../../core/nexus/permissions.js', () => ({
  setPermission: vi.fn(),
}));

vi.mock('../../../core/logger.js', () => ({
  getLogger: vi.fn(() => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  })),
}));

import {
  blockingAnalysis,
  buildGlobalGraph,
  criticalPath,
  nexusDeps,
  orphanDetection,
} from '../../../core/nexus/deps.js';
import { setPermission } from '../../../core/nexus/permissions.js';
import { resolveTask, validateSyntax } from '../../../core/nexus/query.js';
import {
  nexusGetProject,
  nexusInit,
  nexusList,
  nexusRegister,
  nexusSync,
  nexusSyncAll,
  nexusUnregister,
  readRegistry,
} from '../../../core/nexus/registry.js';
import { NexusHandler } from '../nexus.js';

describe('NexusHandler', () => {
  let handler: NexusHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new NexusHandler();
  });

  // -----------------------------------------------------------------------
  // Query operations
  // -----------------------------------------------------------------------

  describe('query: status', () => {
    it('returns initialized=false when registry does not exist', async () => {
      vi.mocked(readRegistry).mockResolvedValue(null);

      const result = await handler.query('status');

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        initialized: false,
        projectCount: 0,
        lastUpdated: null,
      });
    });

    it('returns initialized=true with project count when registry exists', async () => {
      vi.mocked(readRegistry).mockResolvedValue({
        schemaVersion: '1.0.0',
        lastUpdated: '2026-03-01T00:00:00.000Z',
        projects: {
          abc123def456: {
            hash: 'abc123def456',
            projectId: 'project-a',
            path: '/projects/a',
            name: 'project-a',
            registeredAt: '2026-03-01T00:00:00.000Z',
            lastSeen: '2026-03-01T00:00:00.000Z',
            healthStatus: 'unknown',
            healthLastCheck: null,
            permissions: 'read',
            lastSync: '2026-03-01T00:00:00.000Z',
            taskCount: 5,
            labels: [],
          },
        },
      });

      const result = await handler.query('status');

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        initialized: true,
        projectCount: 1,
        lastUpdated: '2026-03-01T00:00:00.000Z',
      });
    });
  });

  describe('query: list', () => {
    it('returns empty list when no projects registered', async () => {
      vi.mocked(nexusList).mockResolvedValue([]);

      const result = await handler.query('list');

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ projects: [], count: 0, total: 0, filtered: 0 });
      expect(result.page).toEqual({ mode: 'none' });
    });

    it('returns registered projects', async () => {
      const projects = [
        {
          hash: 'abc123def456',
          projectId: 'project-a',
          path: '/projects/a',
          name: 'project-a',
          registeredAt: '2026-03-01T00:00:00.000Z',
          lastSeen: '2026-03-01T00:00:00.000Z',
          healthStatus: 'unknown' as const,
          healthLastCheck: null,
          permissions: 'read' as const,
          lastSync: '2026-03-01T00:00:00.000Z',
          taskCount: 5,
          labels: ['bug'],
        },
      ];
      vi.mocked(nexusList).mockResolvedValue(projects);

      const result = await handler.query('list', { limit: 1, offset: 0 });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        projects: [projects[0]],
        count: 1,
        total: 1,
        filtered: 1,
      });
      expect(result.page).toEqual({
        mode: 'offset',
        limit: 1,
        offset: 0,
        hasMore: false,
        total: 1,
      });
    });
  });

  describe('query: show', () => {
    it('returns error when name is missing', async () => {
      const result = await handler.query('show', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('returns error when project not found', async () => {
      vi.mocked(nexusGetProject).mockResolvedValue(null);

      const result = await handler.query('show', { name: 'nonexistent' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_NOT_FOUND');
    });

    it('returns project when found', async () => {
      const project = {
        hash: 'abc123def456',
        projectId: 'project-a',
        path: '/projects/a',
        name: 'project-a',
        registeredAt: '2026-03-01T00:00:00.000Z',
        lastSeen: '2026-03-01T00:00:00.000Z',
        healthStatus: 'unknown' as const,
        healthLastCheck: null,
        permissions: 'read' as const,
        lastSync: '2026-03-01T00:00:00.000Z',
        taskCount: 5,
        labels: [],
      };
      vi.mocked(nexusGetProject).mockResolvedValue(project);

      const result = await handler.query('show', { name: 'project-a' });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(project);
    });
  });

  describe('query: query', () => {
    it('returns error when query param is missing', async () => {
      const result = await handler.query('query', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('returns error for invalid query syntax', async () => {
      vi.mocked(validateSyntax).mockReturnValue(false);

      const result = await handler.query('query', { query: 'bad-query' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('resolves a valid query', async () => {
      vi.mocked(validateSyntax).mockReturnValue(true);
      vi.mocked(resolveTask).mockResolvedValue({
        id: 'T001',
        title: 'Test task',
        status: 'pending',
        _project: 'my-project',
      } as Awaited<ReturnType<typeof resolveTask>>);

      const result = await handler.query('query', { query: 'my-project:T001' });

      expect(result.success).toBe(true);
    });
  });

  describe('query: deps', () => {
    it('returns error when query param is missing', async () => {
      const result = await handler.query('deps', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('returns dependency analysis', async () => {
      vi.mocked(nexusDeps).mockResolvedValue({
        task: 'project-a:T001',
        project: 'project-a',
        depends: [],
        blocking: [],
      });

      const result = await handler.query('deps', { query: 'project-a:T001' });

      expect(result.success).toBe(true);
      expect(nexusDeps).toHaveBeenCalledWith('project-a:T001', 'forward');
    });
  });

  describe('query: graph', () => {
    it('returns global dependency graph', async () => {
      vi.mocked(buildGlobalGraph).mockResolvedValue({
        nodes: [],
        edges: [],
      });

      const result = await handler.query('graph');

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ nodes: [], edges: [] });
    });
  });

  describe('query: path.show', () => {
    it('returns critical path analysis', async () => {
      vi.mocked(criticalPath).mockResolvedValue({
        criticalPath: [{ query: 'project-a:T001', title: 'Task 1' }],
        length: 1,
        blockedBy: 'project-a:T001',
      });

      const result = await handler.query('path.show');

      expect(result.success).toBe(true);
      expect(criticalPath).toHaveBeenCalled();
    });
  });

  describe('query: blockers.show', () => {
    it('returns error when query param is missing', async () => {
      const result = await handler.query('blockers.show', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('returns blocking impact analysis', async () => {
      vi.mocked(blockingAnalysis).mockResolvedValue({
        task: 'project-a:T001',
        blocking: [{ query: 'project-b:T002', project: 'project-b' }],
        impactScore: 1,
      });

      const result = await handler.query('blockers.show', { query: 'project-a:T001' });

      expect(result.success).toBe(true);
      expect(blockingAnalysis).toHaveBeenCalledWith('project-a:T001');
    });
  });

  describe('query: orphans.list', () => {
    it('returns orphaned dependency list', async () => {
      vi.mocked(orphanDetection).mockResolvedValue([
        {
          sourceProject: 'project-a',
          sourceTask: 'T001',
          targetProject: 'project-b',
          targetTask: 'T999',
          reason: 'task_not_found',
        },
      ]);

      const result = await handler.query('orphans.list');

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        orphans: [
          {
            sourceProject: 'project-a',
            sourceTask: 'T001',
            targetProject: 'project-b',
            targetTask: 'T999',
            reason: 'task_not_found',
          },
        ],
        count: 1,
        total: 1,
        filtered: 1,
      });
      expect(result.page).toEqual({ mode: 'none' });
    });
  });

  // -----------------------------------------------------------------------
  // Mutate operations
  // -----------------------------------------------------------------------

  describe('mutate: init', () => {
    it('initializes NEXUS successfully', async () => {
      vi.mocked(nexusInit).mockResolvedValue(undefined);

      const result = await handler.mutate('init');

      expect(result.success).toBe(true);
      expect(nexusInit).toHaveBeenCalled();
    });
  });

  describe('mutate: register', () => {
    it('returns error when path is missing', async () => {
      const result = await handler.mutate('register', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('registers a project successfully', async () => {
      vi.mocked(nexusRegister).mockResolvedValue('abc123def456');

      const result = await handler.mutate('register', { path: '/projects/a', name: 'project-a' });

      expect(result.success).toBe(true);
      expect(nexusRegister).toHaveBeenCalledWith('/projects/a', 'project-a', 'read');
      expect((result.data as { hash: string }).hash).toBe('abc123def456');
    });
  });

  describe('mutate: unregister', () => {
    it('returns error when name is missing', async () => {
      const result = await handler.mutate('unregister', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('unregisters a project successfully', async () => {
      vi.mocked(nexusUnregister).mockResolvedValue(undefined);

      const result = await handler.mutate('unregister', { name: 'project-a' });

      expect(result.success).toBe(true);
      expect(nexusUnregister).toHaveBeenCalledWith('project-a');
    });
  });

  describe('mutate: sync', () => {
    it('syncs all projects when name is omitted', async () => {
      vi.mocked(nexusSyncAll).mockResolvedValue({ synced: 3, failed: 0 });

      const result = await handler.mutate('sync', {});

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ synced: 3, failed: 0 });
    });

    it('syncs a project successfully when name is provided', async () => {
      vi.mocked(nexusSync).mockResolvedValue(undefined);

      const result = await handler.mutate('sync', { name: 'project-a' });

      expect(result.success).toBe(true);
      expect(nexusSync).toHaveBeenCalledWith('project-a');
    });
  });

  describe('mutate: permission.set', () => {
    it('returns error when name is missing', async () => {
      const result = await handler.mutate('permission.set', { level: 'write' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('returns error when level is missing', async () => {
      const result = await handler.mutate('permission.set', { name: 'project-a' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('returns error for invalid permission level', async () => {
      const result = await handler.mutate('permission.set', { name: 'project-a', level: 'admin' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('sets permission successfully', async () => {
      vi.mocked(setPermission).mockResolvedValue(undefined);

      const result = await handler.mutate('permission.set', { name: 'project-a', level: 'write' });

      expect(result.success).toBe(true);
      expect(setPermission).toHaveBeenCalledWith('project-a', 'write');
    });
  });

  // -----------------------------------------------------------------------
  // Unsupported operations
  // -----------------------------------------------------------------------

  describe('unsupported operations', () => {
    it('returns error for unknown query operation', async () => {
      const result = await handler.query('nonexistent');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
    });

    it('returns error for unknown mutate operation', async () => {
      const result = await handler.mutate('nonexistent');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
    });
  });

  // -----------------------------------------------------------------------
  // getSupportedOperations
  // -----------------------------------------------------------------------

  describe('getSupportedOperations', () => {
    it('returns all supported operations', () => {
      const ops = handler.getSupportedOperations();

      expect(ops.query).toEqual([
        'status',
        'list',
        'show',
        'resolve',
        'deps',
        'graph',
        'path.show',
        'blockers.show',
        'orphans.list',
        'discover',
        'search',
        'share.status',
      ]);
      expect(ops.mutate).toEqual([
        'init',
        'register',
        'unregister',
        'sync',
        'permission.set',
        'reconcile',
        'share.snapshot.export',
        'share.snapshot.import',
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  describe('error handling', () => {
    it('catches and wraps errors from core functions', async () => {
      vi.mocked(nexusList).mockRejectedValue(new Error('Database connection failed'));

      const result = await handler.query('list');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INTERNAL');
      expect(result.error?.message).toBe('Database connection failed');
    });
  });
});
