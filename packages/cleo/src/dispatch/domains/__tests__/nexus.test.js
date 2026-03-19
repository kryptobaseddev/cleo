import { beforeEach, describe, expect, it, vi } from 'vitest';
// Mock getProjectRoot and getLogger used by the handler constructor/error paths
vi.mock('@cleocode/core/internal', () => ({
    getProjectRoot: vi.fn(() => '/mock/project'),
    getLogger: vi.fn(() => ({
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
    })),
}));
// Mock the nexus-engine (used by the handler)
vi.mock('../../engines/nexus-engine.js', () => ({
    nexusStatus: vi.fn(),
    nexusListProjects: vi.fn(),
    nexusShowProject: vi.fn(),
    nexusResolve: vi.fn(),
    nexusDepsQuery: vi.fn(),
    nexusGraph: vi.fn(),
    nexusCriticalPath: vi.fn(),
    nexusBlockers: vi.fn(),
    nexusOrphans: vi.fn(),
    nexusDiscover: vi.fn(),
    nexusSearch: vi.fn(),
    nexusInitialize: vi.fn(),
    nexusRegisterProject: vi.fn(),
    nexusUnregisterProject: vi.fn(),
    nexusSyncProject: vi.fn(),
    nexusSetPermission: vi.fn(),
    nexusReconcileProject: vi.fn(),
    nexusShareStatus: vi.fn(),
    nexusShareSnapshotExport: vi.fn(),
    nexusShareSnapshotImport: vi.fn(),
}));
import { nexusBlockers, nexusCriticalPath, nexusDepsQuery, nexusGraph, nexusInitialize, nexusListProjects, nexusOrphans, nexusRegisterProject, nexusResolve, nexusSetPermission, nexusShowProject, nexusStatus, nexusSyncProject, nexusUnregisterProject, } from '../../engines/nexus-engine.js';
import { NexusHandler } from '../nexus.js';
describe('NexusHandler', () => {
    let handler;
    beforeEach(() => {
        vi.clearAllMocks();
        handler = new NexusHandler();
    });
    // -----------------------------------------------------------------------
    // Query operations
    // -----------------------------------------------------------------------
    describe('query: status', () => {
        it('returns initialized=false when registry does not exist', async () => {
            vi.mocked(nexusStatus).mockResolvedValue({
                success: true,
                data: { initialized: false, projectCount: 0, lastUpdated: null },
            });
            const result = await handler.query('status');
            expect(result.success).toBe(true);
            expect(result.data).toEqual({
                initialized: false,
                projectCount: 0,
                lastUpdated: null,
            });
        });
        it('returns initialized=true with project count when registry exists', async () => {
            vi.mocked(nexusStatus).mockResolvedValue({
                success: true,
                data: { initialized: true, projectCount: 1, lastUpdated: '2026-03-01T00:00:00.000Z' },
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
            vi.mocked(nexusListProjects).mockResolvedValue({
                success: true,
                data: {
                    projects: [],
                    count: 0,
                    total: 0,
                    filtered: 0,
                    page: { mode: 'none' },
                },
                page: { mode: 'none' },
            });
            const result = await handler.query('list');
            expect(result.success).toBe(true);
            expect(result.data).toEqual({ projects: [], count: 0, total: 0, filtered: 0 });
            expect(result.page).toEqual({ mode: 'none' });
        });
        it('returns registered projects', async () => {
            const project = {
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
                labels: ['bug'],
            };
            vi.mocked(nexusListProjects).mockResolvedValue({
                success: true,
                data: {
                    projects: [project],
                    count: 1,
                    total: 1,
                    filtered: 1,
                    page: { mode: 'offset', limit: 1, offset: 0, hasMore: false, total: 1 },
                },
                page: { mode: 'offset', limit: 1, offset: 0, hasMore: false, total: 1 },
            });
            const result = await handler.query('list', { limit: 1, offset: 0 });
            expect(result.success).toBe(true);
            expect(result.data).toEqual({
                projects: [project],
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
            vi.mocked(nexusShowProject).mockResolvedValue({
                success: false,
                error: { code: 'E_NOT_FOUND', message: 'Project not found: nonexistent' },
            });
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
                healthStatus: 'unknown',
                healthLastCheck: null,
                permissions: 'read',
                lastSync: '2026-03-01T00:00:00.000Z',
                taskCount: 5,
                labels: [],
            };
            vi.mocked(nexusShowProject).mockResolvedValue({
                success: true,
                data: project,
            });
            const result = await handler.query('show', { name: 'project-a' });
            expect(result.success).toBe(true);
            expect(result.data).toEqual(project);
        });
    });
    describe('query: resolve', () => {
        it('returns error when query param is missing', async () => {
            const result = await handler.query('resolve', {});
            expect(result.success).toBe(false);
            expect(result.error?.code).toBe('E_INVALID_INPUT');
        });
        it('resolves a valid query', async () => {
            vi.mocked(nexusResolve).mockResolvedValue({
                success: true,
                data: {
                    id: 'T001',
                    title: 'Test task',
                    description: 'Test task description',
                    status: 'pending',
                    priority: 'medium',
                    createdAt: new Date().toISOString(),
                    _project: 'my-project',
                },
            });
            const result = await handler.query('resolve', { query: 'my-project:T001' });
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
            vi.mocked(nexusDepsQuery).mockResolvedValue({
                success: true,
                data: { task: 'project-a:T001', project: 'project-a', depends: [], blocking: [] },
            });
            const result = await handler.query('deps', { query: 'project-a:T001' });
            expect(result.success).toBe(true);
            expect(nexusDepsQuery).toHaveBeenCalledWith('project-a:T001', 'forward');
        });
    });
    describe('query: graph', () => {
        it('returns global dependency graph', async () => {
            vi.mocked(nexusGraph).mockResolvedValue({
                success: true,
                data: { nodes: [], edges: [] },
            });
            const result = await handler.query('graph');
            expect(result.success).toBe(true);
            expect(result.data).toEqual({ nodes: [], edges: [] });
        });
    });
    describe('query: path.show', () => {
        it('returns critical path analysis', async () => {
            vi.mocked(nexusCriticalPath).mockResolvedValue({
                success: true,
                data: {
                    criticalPath: [{ query: 'project-a:T001', title: 'Task 1' }],
                    length: 1,
                    blockedBy: 'project-a:T001',
                },
            });
            const result = await handler.query('path.show');
            expect(result.success).toBe(true);
            expect(nexusCriticalPath).toHaveBeenCalled();
        });
    });
    describe('query: blockers.show', () => {
        it('returns error when query param is missing', async () => {
            const result = await handler.query('blockers.show', {});
            expect(result.success).toBe(false);
            expect(result.error?.code).toBe('E_INVALID_INPUT');
        });
        it('returns blocking impact analysis', async () => {
            vi.mocked(nexusBlockers).mockResolvedValue({
                success: true,
                data: {
                    task: 'project-a:T001',
                    blocking: [{ query: 'project-b:T002', project: 'project-b' }],
                    impactScore: 1,
                },
            });
            const result = await handler.query('blockers.show', { query: 'project-a:T001' });
            expect(result.success).toBe(true);
            expect(nexusBlockers).toHaveBeenCalledWith('project-a:T001');
        });
    });
    describe('query: orphans.list', () => {
        it('returns orphaned dependency list', async () => {
            const orphanData = [
                {
                    sourceProject: 'project-a',
                    sourceTask: 'T001',
                    targetProject: 'project-b',
                    targetTask: 'T999',
                    reason: 'task_not_found',
                },
            ];
            vi.mocked(nexusOrphans).mockResolvedValue({
                success: true,
                data: {
                    orphans: orphanData,
                    count: 1,
                    total: 1,
                    filtered: 1,
                    page: { mode: 'none' },
                },
                page: { mode: 'none' },
            });
            const result = await handler.query('orphans.list');
            expect(result.success).toBe(true);
            expect(result.data).toEqual({
                orphans: orphanData,
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
            vi.mocked(nexusInitialize).mockResolvedValue({
                success: true,
                data: { message: 'NEXUS initialized successfully' },
            });
            const result = await handler.mutate('init');
            expect(result.success).toBe(true);
            expect(nexusInitialize).toHaveBeenCalled();
        });
    });
    describe('mutate: register', () => {
        it('returns error when path is missing', async () => {
            const result = await handler.mutate('register', {});
            expect(result.success).toBe(false);
            expect(result.error?.code).toBe('E_INVALID_INPUT');
        });
        it('registers a project successfully', async () => {
            vi.mocked(nexusRegisterProject).mockResolvedValue({
                success: true,
                data: { hash: 'abc123def456', message: 'Project registered with hash: abc123def456' },
            });
            const result = await handler.mutate('register', { path: '/projects/a', name: 'project-a' });
            expect(result.success).toBe(true);
            expect(nexusRegisterProject).toHaveBeenCalledWith('/projects/a', 'project-a', 'read');
            expect(result.data.hash).toBe('abc123def456');
        });
    });
    describe('mutate: unregister', () => {
        it('returns error when name is missing', async () => {
            const result = await handler.mutate('unregister', {});
            expect(result.success).toBe(false);
            expect(result.error?.code).toBe('E_INVALID_INPUT');
        });
        it('unregisters a project successfully', async () => {
            vi.mocked(nexusUnregisterProject).mockResolvedValue({
                success: true,
                data: { message: 'Project unregistered: project-a' },
            });
            const result = await handler.mutate('unregister', { name: 'project-a' });
            expect(result.success).toBe(true);
            expect(nexusUnregisterProject).toHaveBeenCalledWith('project-a');
        });
    });
    describe('mutate: sync', () => {
        it('syncs all projects when name is omitted', async () => {
            vi.mocked(nexusSyncProject).mockResolvedValue({
                success: true,
                data: { synced: 3, failed: 0 },
            });
            const result = await handler.mutate('sync', {});
            expect(result.success).toBe(true);
            expect(result.data).toEqual({ synced: 3, failed: 0 });
        });
        it('syncs a project successfully when name is provided', async () => {
            vi.mocked(nexusSyncProject).mockResolvedValue({
                success: true,
                data: { message: 'Project synced: project-a' },
            });
            const result = await handler.mutate('sync', { name: 'project-a' });
            expect(result.success).toBe(true);
            expect(nexusSyncProject).toHaveBeenCalledWith('project-a');
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
            vi.mocked(nexusSetPermission).mockResolvedValue({
                success: true,
                data: { message: "Permission for 'project-a' set to 'write'" },
            });
            const result = await handler.mutate('permission.set', { name: 'project-a', level: 'write' });
            expect(result.success).toBe(true);
            expect(nexusSetPermission).toHaveBeenCalledWith('project-a', 'write');
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
                'share.status',
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
            ]);
            expect(ops.mutate).toEqual([
                'share.snapshot.export',
                'share.snapshot.import',
                'init',
                'register',
                'unregister',
                'sync',
                'permission.set',
                'reconcile',
            ]);
        });
    });
    // -----------------------------------------------------------------------
    // Error handling
    // -----------------------------------------------------------------------
    describe('error handling', () => {
        it('catches and wraps errors from engine functions', async () => {
            vi.mocked(nexusListProjects).mockRejectedValue(new Error('Database connection failed'));
            const result = await handler.query('list');
            expect(result.success).toBe(false);
            expect(result.error?.code).toBe('E_INTERNAL');
            expect(result.error?.message).toBe('Database connection failed');
        });
    });
});
//# sourceMappingURL=nexus.test.js.map