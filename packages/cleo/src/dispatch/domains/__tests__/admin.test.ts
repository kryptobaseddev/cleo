import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock engine barrel — only config/init/hooks functions remain from engine.js post-T1571
vi.mock('../../lib/engine.js', () => ({
  configGet: vi.fn(),
  configSet: vi.fn(),
  configListPresets: vi.fn(),
  configSetPreset: vi.fn(),
  getVersion: vi.fn(),
  initProject: vi.fn(),
  sessionContextInject: vi.fn(),
  systemHooksMatrix: vi.fn(),
}));

// Mock core/internal — system functions moved here in T1571
vi.mock('@cleocode/core/internal', async () => {
  const actual = await vi.importActual<typeof import('@cleocode/core/internal')>(
    '@cleocode/core/internal',
  );
  return {
    ...actual,
    getSystemHealth: vi.fn(),
    getProjectStatsExtended: vi.fn(),
    getContextWindow: vi.fn(),
    getRuntimeDiagnostics: vi.fn(),
    getSystemPaths: vi.fn(),
    getDashboard: vi.fn(),
    getAccessor: vi.fn(),
    queryAuditLog: vi.fn(),
    showSequence: vi.fn(),
    checkSequence: vi.fn(),
    listSystemBackups: vi.fn(),
    getRoadmap: vi.fn(),
    ensureCleoOsHub: vi.fn(),
    coreDoctorReport: vi.fn(),
    runDoctorFixes: vi.fn(),
    restoreBackup: vi.fn(),
    fileRestore: vi.fn(),
    systemCreateBackup: vi.fn(),
    getMigrationStatus: vi.fn(),
    cleanupSystem: vi.fn(),
    safestop: vi.fn(),
    generateInjection: vi.fn(),
  };
});

// Mock getProjectRoot
vi.mock('../../../../../core/src/paths.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../../core/src/paths.js')>(
    '../../../../../core/src/paths.js',
  );
  return {
    ...actual,
    getProjectRoot: vi.fn(() => '/mock/project'),
  };
});

// Mock scaffold for admin.detect
vi.mock('../../../../../core/src/scaffold.js', () => ({
  ensureProjectContext: vi
    .fn()
    .mockResolvedValue({ action: 'repaired', path: '/mock/project/.cleo/project-context.json' }),
  ensureContributorMcp: vi.fn().mockResolvedValue({
    action: 'skipped',
    path: '/mock/project',
    details: 'Removed (Phase 2 production readiness)',
  }),
}));

vi.mock('../../lib/job-manager-accessor.js', () => ({
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

import {
  cleanupSystem,
  coreDoctorReport,
  fileRestore,
  generateInjection,
  getAccessor,
  getContextWindow,
  getDashboard,
  getMigrationStatus,
  getProjectStatsExtended,
  getRoadmap,
  getRuntimeDiagnostics,
  getSystemHealth,
  getSystemPaths,
  listSystemBackups,
  queryAuditLog,
  restoreBackup,
  runDoctorFixes,
  safestop,
  showSequence,
  checkSequence,
  systemCreateBackup,
} from '@cleocode/core/internal';
import {
  configSet,
  getVersion,
  initProject,
} from '../../lib/engine.js';
import { getJobManager } from '../../lib/job-manager-accessor.js';
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
      // v2026.4.6 added 'paths' (admin.paths — CleoOS Phase 1)
      // FIX: added 'roadmap' — wired admin.roadmap that existed in system-engine but was unregistered
      expect(ops.query).toEqual([
        'version',
        'health',
        'config.show',
        'config.presets',
        'stats',
        'context',
        'context.pull',
        'runtime',
        'paths',
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
        'roadmap',
        'smoke',
        'smoke.provider',
        'hooks.matrix',
      ]);
    });

    it('should list all mutate operations', () => {
      const ops = handler.getSupportedOperations();
      // v2026.4.6 added 'scaffold-hub' (admin.scaffold-hub — CleoOS Phase 1)
      expect(ops.mutate).toEqual([
        'init',
        'scaffold-hub',
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
      expect(res.meta.gateway).toBe('query');
      expect(res.meta.domain).toBe('admin');
      expect(res.meta.operation).toBe('version');
      expect(getVersion).toHaveBeenCalledWith('/mock/project');
    });

    it('should call getSystemHealth for health', async () => {
      vi.mocked(getSystemHealth).mockResolvedValue(
        { overall: 'healthy', checks: [], version: '1.0.0', installation: 'ok' } as any,
      );

      const res = await handler.query('health', { detailed: true });

      expect(res.success).toBe(true);
      expect(getSystemHealth).toHaveBeenCalledWith('/mock/project', { detailed: true });
    });

    it('should call getProjectStatsExtended for stats', async () => {
      vi.mocked(getProjectStatsExtended).mockResolvedValue({
        currentState: {
          pending: 0, active: 0, done: 10, blocked: 0, cancelled: 0,
          totalActive: 0, archived: 0, grandTotal: 10,
        },
        byPriority: {}, byType: {}, byPhase: {},
        completionMetrics: { periodDays: 7, completedInPeriod: 0, createdInPeriod: 0, completionRate: 0 },
        activityMetrics: { createdInPeriod: 0, completedInPeriod: 0, archivedInPeriod: 0 },
        allTime: { totalCreated: 0, totalCompleted: 0, totalCancelled: 0, totalArchived: 0, archivedCompleted: 0 },
        cycleTimes: { averageDays: null, samples: 0 },
      });

      const res = await handler.query('stats', { period: 7 });

      expect(res.success).toBe(true);
      expect(getProjectStatsExtended).toHaveBeenCalledWith('/mock/project', { period: 7 });
    });

    it('should call getContextWindow for context', async () => {
      vi.mocked(getContextWindow).mockReturnValue({
        available: true, status: 'ok', percentage: 50,
        currentTokens: 500, maxTokens: 1000, timestamp: null,
        stale: false, sessions: [],
      });

      const res = await handler.query('context');

      expect(res.success).toBe(true);
      expect(getContextWindow).toHaveBeenCalledWith('/mock/project', undefined);
    });

    it('should call getRuntimeDiagnostics for runtime', async () => {
      vi.mocked(getRuntimeDiagnostics).mockResolvedValue({
        channel: 'dev', mode: 'dev', source: 'local', version: '1.0.0',
        installed: '/usr/local', dataRoot: '/tmp',
        invocation: { executable: 'node', script: 'cleo', args: [] },
        naming: { cli: 'cleo', server: 'cleo-server' },
        node: '20.0.0', platform: 'linux', arch: 'x64', warnings: [],
      } as any);

      const res = await handler.query('runtime', { detailed: true });

      expect(res.success).toBe(true);
      expect(getRuntimeDiagnostics).toHaveBeenCalledWith({ detailed: true });
    });

    it('should call getDashboard for dash', async () => {
      vi.mocked(getAccessor).mockResolvedValue({} as any);
      vi.mocked(getDashboard).mockResolvedValue({
        project: '/test', currentPhase: null,
        summary: { pending: 0, active: 0, blocked: 0, done: 5, cancelled: 0, total: 5, archived: 0, grandTotal: 5 },
        focus: { currentTask: null, task: null },
        activeSession: null,
        highPriority: { count: 0, tasks: [] },
        blockedTasks: { count: 0, limit: 5, tasks: [] },
        recentCompletions: [], topLabels: [],
      } as any);

      const res = await handler.query('dash');

      expect(res.success).toBe(true);
      expect(getDashboard).toHaveBeenCalled();
    });

    it('should call queryAuditLog for log', async () => {
      vi.mocked(queryAuditLog).mockResolvedValue({
        entries: [], pagination: { total: 0, offset: 0, limit: 10, hasMore: false },
      });

      const res = await handler.query('log', { limit: 10, taskId: 'T001' });

      expect(res.success).toBe(true);
      expect(queryAuditLog).toHaveBeenCalledWith('/mock/project', expect.objectContaining({ limit: 10, taskId: 'T001' }));
    });

    it('should call showSequence for sequence', async () => {
      vi.mocked(showSequence).mockResolvedValue({ counter: 42, lastId: 'T042', checksum: 'abc', nextId: 'T043' } as any);

      const res = await handler.query('sequence');

      expect(res.success).toBe(true);
      expect(showSequence).toHaveBeenCalledWith('/mock/project');
    });

    it('should call checkSequence for sequence check action', async () => {
      vi.mocked(checkSequence).mockResolvedValue({ valid: true } as any);

      const res = await handler.query('sequence', { action: 'check' });

      expect(res.success).toBe(true);
      expect(checkSequence).toHaveBeenCalledWith('/mock/project');
    });

    it('should reject invalid sequence query action', async () => {
      const res = await handler.query('sequence', { action: 'repair' });

      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('E_INVALID_INPUT');
      expect(showSequence).not.toHaveBeenCalled();
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
      vi.mocked(getAccessor).mockRejectedValue(new Error('disk failure'));

      const res = await handler.query('dash');

      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('E_NOT_INITIALIZED');
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

    it('should call systemCreateBackup for backup', async () => {
      // T5158: systemCreateBackup is async so tasks.db + brain.db can be opened
      // via drizzle accessors before VACUUM INTO runs. T1571: moved to core.
      vi.mocked(systemCreateBackup).mockResolvedValue({
        backupId: 'snap-1',
        path: '/mock/backup',
        timestamp: '2026-01-01',
        type: 'snapshot',
        files: ['todo.json'],
      } as any);

      const res = await handler.mutate('backup', { type: 'snapshot' });

      expect(res.success).toBe(true);
      expect(systemCreateBackup).toHaveBeenCalledWith('/mock/project', { type: 'snapshot', note: undefined });
    });

    it('should call getMigrationStatus for migrate', async () => {
      vi.mocked(getMigrationStatus).mockResolvedValue(
        { from: '1.0.0', to: '2.0.0', migrations: [], dryRun: true } as any,
      );

      const res = await handler.mutate('migrate', { dryRun: true });

      expect(res.success).toBe(true);
      expect(getMigrationStatus).toHaveBeenCalledWith('/mock/project', { dryRun: true, target: undefined });
    });

    it('should call cleanupSystem for cleanup with target validation', async () => {
      vi.mocked(cleanupSystem).mockResolvedValue(
        { target: 'backups', deleted: 3, items: [], dryRun: true } as any,
      );

      const res = await handler.mutate('cleanup', { target: 'backups', dryRun: true });

      expect(res.success).toBe(true);
      expect(cleanupSystem).toHaveBeenCalledWith('/mock/project', {
        target: 'backups',
        olderThan: undefined,
        dryRun: true,
      });
    });

    it('should return error for cleanup without target', async () => {
      const res = await handler.mutate('cleanup', {});

      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('E_INVALID_INPUT');
      expect(cleanupSystem).not.toHaveBeenCalled();
    });

    it('should return E_NOT_AVAILABLE for job.cancel when no job manager', async () => {
      vi.mocked(getJobManager).mockReturnValue(undefined as never);

      const res = await handler.mutate('job.cancel', { jobId: 'job-1' });

      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('E_NOT_AVAILABLE');
    });

    it('should call safestop for safestop', async () => {
      vi.mocked(safestop).mockResolvedValue(
        { stopped: true, reason: 'test', sessionEnded: false, dryRun: true } as any,
      );

      const res = await handler.mutate('safestop', { reason: 'test', dryRun: true });

      expect(res.success).toBe(true);
      expect(safestop).toHaveBeenCalledWith('/mock/project', expect.objectContaining({ reason: 'test', dryRun: true }));
    });

    it('should call generateInjection for inject.generate', async () => {
      vi.mocked(getAccessor).mockResolvedValue({} as any);
      vi.mocked(generateInjection).mockResolvedValue(
        { injection: '...', sizeBytes: 100, version: '1.0.0' } as any,
      );

      const res = await handler.mutate('inject.generate');

      expect(res.success).toBe(true);
      expect(generateInjection).toHaveBeenCalled();
    });

    it('should return E_INVALID_OPERATION for sequence mutate (removed from admin)', async () => {
      const res = await handler.mutate('sequence', { action: 'repair' });

      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('E_INVALID_OPERATION');
    });

    it('admin.detect refreshes project-context.json and dev channel', async () => {
      const res = await handler.mutate('detect', {});
      expect(res.success).toBe(true);
      expect(res.data).toMatchObject({
        context: { action: expect.stringMatching(/created|repaired|skipped/) },
        devChannel: { action: expect.stringMatching(/created|repaired|skipped/) },
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

      expect(res.meta).toBeDefined();
      expect(res.meta.gateway).toBe('query');
      expect(res.meta.domain).toBe('admin');
      expect(res.meta.operation).toBe('version');
      expect(res.meta.timestamp).toBeDefined();
      expect(typeof res.meta.duration_ms).toBe('number');
      expect(res.meta.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('should include correct _meta fields on error', async () => {
      const res = await handler.query('nonexistent');

      expect(res.meta.gateway).toBe('query');
      expect(res.meta.domain).toBe('admin');
      expect(res.meta.operation).toBe('nonexistent');
    });

    it('should include correct _meta on mutate', async () => {
      // T5158 / T1571: systemCreateBackup moved from engine to core.
      vi.mocked(systemCreateBackup).mockResolvedValue({
        backupId: 'snap-2',
        path: '/mock/backup',
        timestamp: '2026-01-01',
        type: 'snapshot',
        files: [],
      } as any);

      const res = await handler.mutate('backup');

      expect(res.meta.gateway).toBe('mutate');
      expect(res.meta.domain).toBe('admin');
      expect(res.meta.operation).toBe('backup');
    });
  });
});
