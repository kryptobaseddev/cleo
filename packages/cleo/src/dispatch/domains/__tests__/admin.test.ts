import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock engine functions before importing the handler
vi.mock('../../lib/engine.js', () => ({
  systemDash: vi.fn(),
  systemStats: vi.fn(),
  systemLog: vi.fn(),
  systemContext: vi.fn(),
  systemRuntime: vi.fn(),
  systemSequence: vi.fn(),
  systemSequenceRepair: vi.fn(),
  systemHealth: vi.fn(),
  systemInjectGenerate: vi.fn(),
  systemBackup: vi.fn(),
  systemRestore: vi.fn(),
  systemMigrate: vi.fn(),
  systemCleanup: vi.fn(),
  systemSync: vi.fn(),
  systemSafestop: vi.fn(),
  configGet: vi.fn(),
  configSet: vi.fn(),
  getVersion: vi.fn(),
  initProject: vi.fn(),
}));

// Mock getProjectRoot
vi.mock('../../../../../core/src/paths.js', () => ({
  getProjectRoot: vi.fn(() => '/mock/project'),
}));

// Mock scaffold for admin.detect
vi.mock('../../../../../core/src/scaffold.js', () => ({
  ensureProjectContext: vi
    .fn()
    .mockResolvedValue({ action: 'repaired', path: '/mock/project/.cleo/project-context.json' }),
  ensureContributorMcp: vi.fn().mockResolvedValue({
    action: 'skipped',
    path: '/mock/project/.mcp.json',
    details: 'Not a contributor project',
  }),
}));

vi.mock('../../../mcp/lib/job-manager-accessor.js', () => ({
  getJobManager: vi.fn(),
}));

vi.mock('../../../../../core/src/adrs/index.js', () => ({
  listAdrs: vi.fn(),
  showAdr: vi.fn(),
  syncAdrsToDb: vi.fn(),
  validateAllAdrs: vi.fn(),
  findAdrs: vi.fn(),
}));

vi.mock('../../../../../core/src/sessions/session-grade.js', () => ({
  readGrades: vi.fn(),
  gradeSession: vi.fn(),
}));

// Mock registry OPERATIONS for help tests
vi.mock('../../registry.js', () => ({
  OPERATIONS: [
    {
      gateway: 'query',
      domain: 'tasks',
      operation: 'show',
      description: 'Show task',
      tier: 0,
      idempotent: true,
      sessionRequired: false,
      requiredParams: ['taskId'],
    },
    {
      gateway: 'query',
      domain: 'tasks',
      operation: 'list',
      description: 'List tasks',
      tier: 0,
      idempotent: true,
      sessionRequired: false,
      requiredParams: [],
    },
    {
      gateway: 'query',
      domain: 'tasks',
      operation: 'find',
      description: 'Find tasks',
      tier: 0,
      idempotent: true,
      sessionRequired: false,
      requiredParams: ['query'],
    },
    {
      gateway: 'query',
      domain: 'admin',
      operation: 'dash',
      description: 'Dashboard',
      tier: 0,
      idempotent: true,
      sessionRequired: false,
      requiredParams: [],
    },
    {
      gateway: 'query',
      domain: 'admin',
      operation: 'health',
      description: 'Health check',
      tier: 0,
      idempotent: true,
      sessionRequired: false,
      requiredParams: [],
    },
    {
      gateway: 'query',
      domain: 'memory',
      operation: 'show',
      description: 'Show research',
      tier: 1,
      idempotent: true,
      sessionRequired: false,
      requiredParams: ['id'],
    },
    {
      gateway: 'query',
      domain: 'orchestrate',
      operation: 'status',
      description: 'Orch status',
      tier: 2,
      idempotent: true,
      sessionRequired: false,
      requiredParams: [],
    },
  ],
}));

import { getJobManager } from '../../../mcp/lib/job-manager-accessor.js';
import {
  configSet,
  getVersion,
  initProject,
  systemBackup,
  systemCleanup,
  systemContext,
  systemDash,
  systemHealth,
  systemInjectGenerate,
  systemLog,
  systemMigrate,
  systemRuntime,
  systemSafestop,
  systemSequence,
  systemStats,
} from '../../lib/engine.js';
import { AdminHandler } from '../admin.js';

describe('AdminHandler', () => {
  let handler: AdminHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new AdminHandler();
  });

  // -----------------------------------------------------------------------
  // getSupportedOperations
  // -----------------------------------------------------------------------

  describe('getSupportedOperations', () => {
    it('should list all query operations', () => {
      const ops = handler.getSupportedOperations();
      expect(ops.query).toEqual([
        'version',
        'health',
        'config.show',
        'config.presets',
        'stats',
        'context',
        'runtime',
        'job',
        'dash',
        'log',
        'sequence',
        'help',
        'token',
        'adr.show',
        'adr.find',
        'backup',
        'export',
        'map',
        'smoke',
        'hooks.matrix',
      ]);
    });

    it('should list all mutate operations', () => {
      const ops = handler.getSupportedOperations();
      expect(ops.mutate).toEqual([
        'init',
        'config.set',
        'config.set-preset',
        'backup',
        'migrate',
        'cleanup',
        'job.cancel',
        'safestop',
        'inject.generate',
        'install.global',
        'token',
        'adr.sync',
        'health',
        'context.inject',
        'import',
        'detect',
        'map',
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // Query operations
  // -----------------------------------------------------------------------

  describe('query', () => {
    it('should call getVersion for version', async () => {
      vi.mocked(getVersion).mockResolvedValue({ success: true, data: { version: '1.2.3' } });

      const res = await handler.query('version');

      expect(res.success).toBe(true);
      expect(res.data).toEqual({ version: '1.2.3' });
      expect(res._meta.gateway).toBe('query');
      expect(res._meta.domain).toBe('admin');
      expect(res._meta.operation).toBe('version');
      expect(getVersion).toHaveBeenCalledWith('/mock/project');
    });

    it('should call systemHealth for health', async () => {
      vi.mocked(systemHealth).mockReturnValue({
        success: true,
        data: { overall: 'healthy', checks: [], version: '1.0.0', installation: 'ok' },
      });

      const res = await handler.query('health', { detailed: true });

      expect(res.success).toBe(true);
      expect(systemHealth).toHaveBeenCalledWith('/mock/project', { detailed: true });
    });

    it('should call systemStats for stats', async () => {
      vi.mocked(systemStats).mockResolvedValue({
        success: true,
        data: {
          currentState: {
            pending: 0,
            active: 0,
            done: 10,
            blocked: 0,
            cancelled: 0,
            totalActive: 0,
            archived: 0,
            grandTotal: 10,
          },
          byPriority: {},
          byType: {},
          byPhase: {},
          completionMetrics: {
            periodDays: 7,
            completedInPeriod: 0,
            createdInPeriod: 0,
            completionRate: 0,
          },
          activityMetrics: {},
        } as any,
      });

      const res = await handler.query('stats', { period: 7 });

      expect(res.success).toBe(true);
      expect(systemStats).toHaveBeenCalledWith('/mock/project', { period: 7 });
    });

    it('should call systemContext for context', async () => {
      vi.mocked(systemContext).mockReturnValue({
        success: true,
        data: {
          available: true,
          status: 'ok',
          percentage: 50,
          currentTokens: 500,
          maxTokens: 1000,
          timestamp: null,
          stale: false,
          sessions: [],
        },
      });

      const res = await handler.query('context');

      expect(res.success).toBe(true);
      expect(systemContext).toHaveBeenCalledWith('/mock/project', undefined);
    });

    it('should call systemRuntime for runtime', async () => {
      vi.mocked(systemRuntime).mockResolvedValue({
        success: true,
        data: {
          channel: 'dev',
          mode: 'dev',
          source: 'local',
          version: '1.0.0',
          installed: '/usr/local',
          dataRoot: '/tmp',
          invocation: { executable: 'node', script: 'cleo', args: [] },
          naming: { cli: 'cleo', mcp: 'cleo-mcp', server: 'cleo-server' },
          node: '20.0.0',
          platform: 'linux',
          arch: 'x64',
          warnings: [],
        },
      });

      const res = await handler.query('runtime', { detailed: true });

      expect(res.success).toBe(true);
      expect(systemRuntime).toHaveBeenCalledWith('/mock/project', { detailed: true });
    });

    it('should call systemDash for dash', async () => {
      vi.mocked(systemDash).mockResolvedValue({
        success: true,
        data: {
          project: '/test',
          currentPhase: null,
          summary: {
            pending: 0,
            active: 0,
            blocked: 0,
            done: 5,
            cancelled: 0,
            total: 5,
            archived: 0,
            grandTotal: 5,
          },
          taskWork: { currentTask: null, task: null },
          activeSession: null,
          highPriority: { count: 0, tasks: [] },
          blockedTasks: { count: 0, limit: 5, tasks: [] },
          recentCompletions: [],
          topLabels: [],
        },
      });

      const res = await handler.query('dash');

      expect(res.success).toBe(true);
      expect(systemDash).toHaveBeenCalledWith('/mock/project', expect.any(Object));
    });

    it('should call systemLog for log', async () => {
      vi.mocked(systemLog).mockResolvedValue({
        success: true,
        data: { entries: [], pagination: { total: 0, offset: 0, limit: 10, hasMore: false } },
      });

      const res = await handler.query('log', { limit: 10, taskId: 'T001' });

      expect(res.success).toBe(true);
      expect(systemLog).toHaveBeenCalledWith('/mock/project', { limit: 10, taskId: 'T001' });
    });

    it('should call systemSequence for sequence', async () => {
      vi.mocked(systemSequence).mockResolvedValue({ success: true, data: { next: 42 } });

      const res = await handler.query('sequence');

      expect(res.success).toBe(true);
      expect(systemSequence).toHaveBeenCalledWith('/mock/project', { action: undefined });
    });

    it('should call systemSequence for sequence check action', async () => {
      vi.mocked(systemSequence).mockResolvedValue({ success: true, data: { valid: true } });

      const res = await handler.query('sequence', { action: 'check' });

      expect(res.success).toBe(true);
      expect(systemSequence).toHaveBeenCalledWith('/mock/project', { action: 'check' });
    });

    it('should reject invalid sequence query action', async () => {
      const res = await handler.query('sequence', { action: 'repair' });

      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('E_INVALID_INPUT');
      expect(systemSequence).not.toHaveBeenCalled();
    });

    it('should return help with quickStart and compact grouped operations at tier 0', async () => {
      const res = await handler.query('help', { tier: 0 });

      expect(res.success).toBe(true);
      const data = res.data as Record<string, unknown>;
      expect(data.tier).toBe(0);
      expect(data.quickStart).toBeDefined();
      expect(Array.isArray(data.quickStart)).toBe(true);
      expect((data.quickStart as string[]).length).toBeGreaterThan(0);
      // Compact format: grouped by domain (not an array)
      const ops = data.operations as Record<string, { query: string[]; mutate: string[] }>;
      expect(Array.isArray(ops)).toBe(false);
      expect(typeof ops).toBe('object');
      // operationCount still reflects the real count
      expect(typeof data.operationCount).toBe('number');
    });

    it('should not include quickStart at tier 1', async () => {
      const res = await handler.query('help', { tier: 1 });

      expect(res.success).toBe(true);
      const data = res.data as Record<string, unknown>;
      expect(data.tier).toBe(1);
      expect(data.quickStart).toBeUndefined();
      // operationCount reflects tier 0 + tier 1 ops
      expect(typeof data.operationCount).toBe('number');
    });

    it('should classify cost hints correctly when verbose:true', async () => {
      const res = await handler.query('help', { tier: 0, verbose: true });

      const data = res.data as Record<string, unknown>;
      const ops = data.operations as Array<{ domain: string; operation: string; costHint: string }>;
      expect(Array.isArray(ops)).toBe(true);

      const listOp = ops.find((o) => o.domain === 'tasks' && o.operation === 'list');
      expect(listOp?.costHint).toBe('heavy');

      const showOp = ops.find((o) => o.domain === 'tasks' && o.operation === 'show');
      expect(showOp?.costHint).toBe('moderate');

      const findOp = ops.find((o) => o.domain === 'tasks' && o.operation === 'find');
      expect(findOp?.costHint).toBe('minimal');
    });

    it('should return E_INVALID_OPERATION for grade.list (moved to check domain)', async () => {
      const res = await handler.query('grade.list', { sessionId: 'ses-1', limit: 1, offset: 1 });

      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('E_INVALID_OPERATION');
    });

    it('should return E_INVALID_OPERATION for unknown query', async () => {
      const res = await handler.query('nonexistent');

      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('E_INVALID_OPERATION');
      expect(res.error?.message).toContain('nonexistent');
    });

    it('should handle engine errors gracefully', async () => {
      vi.mocked(getVersion).mockResolvedValue({
        success: false,
        error: { code: 'E_NOT_INITIALIZED', message: 'No project found' },
      });

      const res = await handler.query('version');

      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('E_NOT_INITIALIZED');
      expect(res.error?.message).toBe('No project found');
    });

    it('should handle thrown exceptions', async () => {
      vi.mocked(systemDash).mockRejectedValue(new Error('disk failure'));

      const res = await handler.query('dash');

      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('E_INTERNAL');
      expect(res.error?.message).toBe('disk failure');
    });
  });

  // -----------------------------------------------------------------------
  // Mutate operations
  // -----------------------------------------------------------------------

  describe('mutate', () => {
    it('should call initProject for init', async () => {
      vi.mocked(initProject).mockResolvedValue({
        success: true,
        data: { initialized: true, projectRoot: '/mock/project', filesCreated: ['todo.json'] },
      });

      const res = await handler.mutate('init', { projectName: 'test' });

      expect(res.success).toBe(true);
      expect(initProject).toHaveBeenCalledWith('/mock/project', { projectName: 'test' });
    });

    it('should call configSet for config.set with key validation', async () => {
      vi.mocked(configSet).mockResolvedValue({ success: true, data: { key: 'a', value: 'b' } });

      const res = await handler.mutate('config.set', { key: 'some.key', value: 'some.value' });

      expect(res.success).toBe(true);
      expect(configSet).toHaveBeenCalledWith('/mock/project', 'some.key', 'some.value');
    });

    it('should return error for config.set without key', async () => {
      const res = await handler.mutate('config.set', { value: 'test' });

      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('E_INVALID_INPUT');
      expect(configSet).not.toHaveBeenCalled();
    });

    it('should call systemBackup for backup', async () => {
      vi.mocked(systemBackup).mockReturnValue({
        success: true,
        data: {
          backupId: 'snap-1',
          path: '/mock/backup',
          timestamp: '2026-01-01',
          type: 'snapshot',
          files: ['todo.json'],
        },
      });

      const res = await handler.mutate('backup', { type: 'snapshot' });

      expect(res.success).toBe(true);
      expect(systemBackup).toHaveBeenCalledWith('/mock/project', { type: 'snapshot' });
    });

    it('should call systemMigrate for migrate', async () => {
      vi.mocked(systemMigrate).mockResolvedValue({
        success: true,
        data: { from: '1.0.0', to: '2.0.0', migrations: [], dryRun: true },
      });

      const res = await handler.mutate('migrate', { dryRun: true });

      expect(res.success).toBe(true);
      expect(systemMigrate).toHaveBeenCalledWith('/mock/project', { dryRun: true });
    });

    it('should call systemCleanup for cleanup with target validation', async () => {
      vi.mocked(systemCleanup).mockResolvedValue({
        success: true,
        data: { target: 'backups', deleted: 3, items: [], dryRun: true },
      });

      const res = await handler.mutate('cleanup', { target: 'backups', dryRun: true });

      expect(res.success).toBe(true);
      expect(systemCleanup).toHaveBeenCalledWith('/mock/project', {
        target: 'backups',
        olderThan: undefined,
        dryRun: true,
      });
    });

    it('should return error for cleanup without target', async () => {
      const res = await handler.mutate('cleanup', {});

      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('E_INVALID_INPUT');
      expect(systemCleanup).not.toHaveBeenCalled();
    });

    it('should return E_NOT_AVAILABLE for job.cancel when no job manager', async () => {
      vi.mocked(getJobManager).mockReturnValue(undefined as never);

      const res = await handler.mutate('job.cancel', { jobId: 'job-1' });

      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('E_NOT_AVAILABLE');
    });

    it('should call systemSafestop for safestop', async () => {
      vi.mocked(systemSafestop).mockReturnValue({
        success: true,
        data: { stopped: true, reason: 'test', sessionEnded: false, dryRun: true },
      });

      const res = await handler.mutate('safestop', { reason: 'test', dryRun: true });

      expect(res.success).toBe(true);
      expect(systemSafestop).toHaveBeenCalledWith('/mock/project', {
        reason: 'test',
        dryRun: true,
      });
    });

    it('should call systemInjectGenerate for inject.generate', async () => {
      vi.mocked(systemInjectGenerate).mockResolvedValue({
        success: true,
        data: { injection: '...', sizeBytes: 100, version: '1.0.0' },
      });

      const res = await handler.mutate('inject.generate');

      expect(res.success).toBe(true);
      expect(systemInjectGenerate).toHaveBeenCalledWith('/mock/project');
    });

    it('should return E_INVALID_OPERATION for sequence mutate (removed from admin)', async () => {
      const res = await handler.mutate('sequence', { action: 'repair' });

      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('E_INVALID_OPERATION');
    });

    it('admin.detect refreshes project-context.json and contributor MCP', async () => {
      const res = await handler.mutate('detect', {});
      expect(res.success).toBe(true);
      expect(res.data).toMatchObject({
        context: { action: expect.stringMatching(/created|repaired|skipped/) },
        mcp: { action: expect.stringMatching(/created|repaired|skipped/) },
      });
    });

    it('should return E_INVALID_OPERATION for unknown mutate', async () => {
      const res = await handler.mutate('nonexistent');

      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('E_INVALID_OPERATION');
    });

    it('should handle thrown exceptions in mutate', async () => {
      vi.mocked(initProject).mockRejectedValue(new Error('init failed'));

      const res = await handler.mutate('init');

      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('E_INTERNAL');
      expect(res.error?.message).toBe('init failed');
    });
  });

  // -----------------------------------------------------------------------
  // Metadata validation
  // -----------------------------------------------------------------------

  describe('response metadata', () => {
    it('should include correct _meta fields on success', async () => {
      vi.mocked(getVersion).mockResolvedValue({ success: true, data: { version: '1.0.0' } });

      const res = await handler.query('version');

      expect(res._meta).toBeDefined();
      expect(res._meta.gateway).toBe('query');
      expect(res._meta.domain).toBe('admin');
      expect(res._meta.operation).toBe('version');
      expect(res._meta.timestamp).toBeDefined();
      expect(typeof res._meta.duration_ms).toBe('number');
      expect(res._meta.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('should include correct _meta fields on error', async () => {
      const res = await handler.query('nonexistent');

      expect(res._meta.gateway).toBe('query');
      expect(res._meta.domain).toBe('admin');
      expect(res._meta.operation).toBe('nonexistent');
    });

    it('should include correct _meta on mutate', async () => {
      vi.mocked(systemBackup).mockReturnValue({
        success: true,
        data: {
          backupId: 'snap-2',
          path: '/mock/backup',
          timestamp: '2026-01-01',
          type: 'snapshot',
          files: [],
        },
      });

      const res = await handler.mutate('backup');

      expect(res._meta.gateway).toBe('mutate');
      expect(res._meta.domain).toBe('admin');
      expect(res._meta.operation).toBe('backup');
    });
  });
});
