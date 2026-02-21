import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock engine functions before importing the handler
vi.mock('../../../mcp/engine/index.js', () => ({
  systemDash: vi.fn(),
  systemStats: vi.fn(),
  systemLog: vi.fn(),
  systemContext: vi.fn(),
  systemSequence: vi.fn(),
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
vi.mock('../../../core/paths.js', () => ({
  getProjectRoot: vi.fn(() => '/mock/project'),
}));

import { AdminHandler } from '../admin.js';
import {
  systemDash,
  systemStats,
  systemLog,
  systemContext,
  systemSequence,
  systemHealth,
  systemInjectGenerate,
  systemBackup,
  systemRestore,
  systemMigrate,
  systemCleanup,
  systemSync,
  systemSafestop,
  configGet,
  configSet,
  getVersion,
  initProject,
} from '../../../mcp/engine/index.js';

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
        'version', 'health', 'config.get', 'stats', 'context',
        'job.status', 'job.list', 'dash', 'log', 'sequence',
      ]);
    });

    it('should list all mutate operations', () => {
      const ops = handler.getSupportedOperations();
      expect(ops.mutate).toEqual([
        'init', 'config.set', 'backup', 'restore', 'migrate',
        'sync', 'cleanup', 'job.cancel', 'safestop', 'inject.generate',
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // Query operations
  // -----------------------------------------------------------------------

  describe('query', () => {
    it('should call getVersion for version', async () => {
      vi.mocked(getVersion).mockReturnValue({ success: true, data: { version: '1.2.3' } });

      const res = await handler.query('version');

      expect(res.success).toBe(true);
      expect(res.data).toEqual({ version: '1.2.3' });
      expect(res._meta.gateway).toBe('query');
      expect(res._meta.domain).toBe('admin');
      expect(res._meta.operation).toBe('version');
      expect(getVersion).toHaveBeenCalledWith('/mock/project');
    });

    it('should call systemHealth for health', async () => {
      vi.mocked(systemHealth).mockReturnValue({ success: true, data: { status: 'healthy' } });

      const res = await handler.query('health', { detailed: true });

      expect(res.success).toBe(true);
      expect(systemHealth).toHaveBeenCalledWith('/mock/project', { detailed: true });
    });

    it('should call configGet for config.get', async () => {
      vi.mocked(configGet).mockReturnValue({ success: true, data: { key: 'val' } });

      const res = await handler.query('config.get', { key: 'some.key' });

      expect(res.success).toBe(true);
      expect(configGet).toHaveBeenCalledWith('/mock/project', 'some.key');
    });

    it('should call systemStats for stats', async () => {
      vi.mocked(systemStats).mockResolvedValue({ success: true, data: { total: 10 } });

      const res = await handler.query('stats', { period: 7 });

      expect(res.success).toBe(true);
      expect(systemStats).toHaveBeenCalledWith('/mock/project', { period: 7 });
    });

    it('should call systemContext for context', async () => {
      vi.mocked(systemContext).mockReturnValue({ success: true, data: { tokens: 500 } });

      const res = await handler.query('context');

      expect(res.success).toBe(true);
      expect(systemContext).toHaveBeenCalledWith('/mock/project', undefined);
    });

    it('should call systemDash for dash', async () => {
      vi.mocked(systemDash).mockResolvedValue({ success: true, data: { tasks: 5 } });

      const res = await handler.query('dash');

      expect(res.success).toBe(true);
      expect(systemDash).toHaveBeenCalledWith('/mock/project');
    });

    it('should call systemLog for log', async () => {
      vi.mocked(systemLog).mockReturnValue({ success: true, data: { entries: [] } });

      const res = await handler.query('log', { limit: 10, taskId: 'T001' });

      expect(res.success).toBe(true);
      expect(systemLog).toHaveBeenCalledWith('/mock/project', { limit: 10, taskId: 'T001' });
    });

    it('should call systemSequence for sequence', async () => {
      vi.mocked(systemSequence).mockReturnValue({ success: true, data: { next: 42 } });

      const res = await handler.query('sequence');

      expect(res.success).toBe(true);
      expect(systemSequence).toHaveBeenCalledWith('/mock/project');
    });

    it('should return E_NOT_IMPLEMENTED for job.status', async () => {
      const res = await handler.query('job.status');

      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('E_NOT_IMPLEMENTED');
    });

    it('should return E_NOT_IMPLEMENTED for job.list', async () => {
      const res = await handler.query('job.list');

      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('E_NOT_IMPLEMENTED');
    });

    it('should return E_INVALID_OPERATION for unknown query', async () => {
      const res = await handler.query('nonexistent');

      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('E_INVALID_OPERATION');
      expect(res.error?.message).toContain('nonexistent');
    });

    it('should handle engine errors gracefully', async () => {
      vi.mocked(getVersion).mockReturnValue({
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
      vi.mocked(initProject).mockReturnValue({
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
      vi.mocked(systemBackup).mockReturnValue({ success: true, data: { backupId: 'snap-1' } });

      const res = await handler.mutate('backup', { type: 'snapshot' });

      expect(res.success).toBe(true);
      expect(systemBackup).toHaveBeenCalledWith('/mock/project', { type: 'snapshot' });
    });

    it('should call systemRestore for restore with backupId validation', async () => {
      vi.mocked(systemRestore).mockReturnValue({ success: true, data: { restored: true } });

      const res = await handler.mutate('restore', { backupId: 'snap-1' });

      expect(res.success).toBe(true);
      expect(systemRestore).toHaveBeenCalledWith('/mock/project', { backupId: 'snap-1', force: undefined });
    });

    it('should return error for restore without backupId', async () => {
      const res = await handler.mutate('restore', {});

      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('E_INVALID_INPUT');
      expect(systemRestore).not.toHaveBeenCalled();
    });

    it('should call systemMigrate for migrate', async () => {
      vi.mocked(systemMigrate).mockReturnValue({ success: true, data: { migrated: true } });

      const res = await handler.mutate('migrate', { dryRun: true });

      expect(res.success).toBe(true);
      expect(systemMigrate).toHaveBeenCalledWith('/mock/project', { dryRun: true });
    });

    it('should call systemSync for sync', async () => {
      vi.mocked(systemSync).mockReturnValue({ success: true, data: { synced: 0 } });

      const res = await handler.mutate('sync', { direction: 'up' });

      expect(res.success).toBe(true);
      expect(systemSync).toHaveBeenCalledWith('/mock/project', { direction: 'up' });
    });

    it('should call systemCleanup for cleanup with target validation', async () => {
      vi.mocked(systemCleanup).mockReturnValue({ success: true, data: { removed: 3 } });

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

    it('should return E_NOT_IMPLEMENTED for job.cancel', async () => {
      const res = await handler.mutate('job.cancel');

      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('E_NOT_IMPLEMENTED');
    });

    it('should call systemSafestop for safestop', async () => {
      vi.mocked(systemSafestop).mockReturnValue({ success: true, data: { stopped: true } });

      const res = await handler.mutate('safestop', { reason: 'test', dryRun: true });

      expect(res.success).toBe(true);
      expect(systemSafestop).toHaveBeenCalledWith('/mock/project', { reason: 'test', dryRun: true });
    });

    it('should call systemInjectGenerate for inject.generate', async () => {
      vi.mocked(systemInjectGenerate).mockResolvedValue({ success: true, data: { generated: true } });

      const res = await handler.mutate('inject.generate');

      expect(res.success).toBe(true);
      expect(systemInjectGenerate).toHaveBeenCalledWith('/mock/project');
    });

    it('should return E_INVALID_OPERATION for unknown mutate', async () => {
      const res = await handler.mutate('nonexistent');

      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('E_INVALID_OPERATION');
    });

    it('should handle thrown exceptions in mutate', async () => {
      vi.mocked(initProject).mockImplementation(() => { throw new Error('init failed'); });

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
      vi.mocked(getVersion).mockReturnValue({ success: true, data: { version: '1.0.0' } });

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
      vi.mocked(systemBackup).mockReturnValue({ success: true, data: {} });

      const res = await handler.mutate('backup');

      expect(res._meta.gateway).toBe('mutate');
      expect(res._meta.domain).toBe('admin');
      expect(res._meta.operation).toBe('backup');
    });
  });
});
