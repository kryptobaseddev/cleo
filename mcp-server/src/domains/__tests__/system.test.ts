/**
 * System Domain Handler Tests
 *
 * Tests all 12 system operations:
 * - Query (7): context, metrics, health, config, diagnostics, version, help
 * - Mutate (5): backup, restore, migrate, cleanup, audit
 *
 * @task T2935
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { SystemHandler } from '../system.js';
import type { CLIExecutor } from '../../lib/executor.js';
import { createMockExecutor } from '../../__tests__/utils.js';

describe('SystemHandler', () => {
  let handler: SystemHandler;
  let mockExecutor: CLIExecutor;

  beforeEach(() => {
    mockExecutor = createMockExecutor();
    handler = new SystemHandler(mockExecutor);
  });

  describe('getSupportedOperations', () => {
    it('should return all supported operations', () => {
      const operations = handler.getSupportedOperations();

      expect(operations.query).toEqual([
        'context',
        'metrics',
        'health',
        'config',
        'diagnostics',
        'version',
        'help',
        'doctor',
        'config.get',
        'stats',
        'job.status',
        'job.list',
        'dash',
        'roadmap',
        'labels',
        'compliance',
        'log',
        'archive-stats',
        'sequence',
      ]);

      expect(operations.mutate).toEqual([
        'backup',
        'restore',
        'migrate',
        'cleanup',
        'audit',
        'init',
        'config.set',
        'sync',
        'job.cancel',
        'safestop',
        'uncancel',
      ]);
    });
  });

  /**
   * QUERY OPERATIONS
   */

  describe('query: context', () => {
    it('should get context window usage', async () => {
      (mockExecutor.execute as jest.Mock<any>).mockResolvedValueOnce({
        success: true,
        data: {
          tokens: { used: 5000, available: 200000, percentage: 2.5 },
          files: 10,
          status: 'ok',
        },
      });

      const response = await handler.query('context');

      expect(response.success).toBe(true);
      expect(response.data).toHaveProperty('tokens');
      expect(response.data).toHaveProperty('files');
      expect(response.data).toHaveProperty('status');
      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({ domain: 'system', operation: 'context' })
      );
    });

    it('should handle context errors', async () => {
      (mockExecutor.execute as jest.Mock<any>).mockResolvedValueOnce({
        success: false,
        error: { code: 'E_FILE_ERROR', message: 'Cannot read context', exitCode: 3 },
      });

      const response = await handler.query('context');

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('E_FILE_ERROR');
    });
  });

  describe('query: metrics', () => {
    it('should get system metrics with default scope', async () => {
      (mockExecutor.execute as jest.Mock<any>).mockResolvedValueOnce({
        success: true,
        data: {
          tokens: { input: 10000, output: 5000, cache: 2000, total: 17000 },
          compliance: { total: 50, passed: 45, failed: 5, score: 0.9 },
          sessions: { total: 10, active: 2, completed: 8 },
        },
      });

      const response = await handler.query('metrics');

      expect(response.success).toBe(true);
      expect(response.data).toHaveProperty('tokens');
      expect(response.data).toHaveProperty('compliance');
      expect(response.data).toHaveProperty('sessions');
      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({ domain: 'metrics', operation: 'show' })
      );
    });

    it('should get metrics with scope and since parameters', async () => {
      (mockExecutor.execute as jest.Mock<any>).mockResolvedValueOnce({
        success: true,
        data: { tokens: {}, compliance: {}, sessions: {} },
      });

      await handler.query('metrics', { scope: 'session', since: '2026-01-01' });

      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: 'metrics',
          operation: 'show',
          flags: expect.objectContaining({ scope: 'session', since: '2026-01-01' }),
        })
      );
    });
  });

  describe('query: health', () => {
    it('should check system health', async () => {
      (mockExecutor.execute as jest.Mock<any>).mockResolvedValueOnce({
        success: true,
        data: {
          overall: 'healthy',
          checks: [
            { name: 'schema', status: 'pass' },
            { name: 'files', status: 'pass' },
          ],
          version: '0.80.1',
          installation: 'ok',
        },
      });

      const response = await handler.query('health');

      expect(response.success).toBe(true);
      expect(response.data).toHaveProperty('overall');
      expect(response.data).toHaveProperty('checks');
      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({ domain: 'cleo', operation: '--validate' })
      );
    });

    it('should check health with detailed flag', async () => {
      (mockExecutor.execute as jest.Mock<any>).mockResolvedValueOnce({
        success: true,
        data: { overall: 'healthy', checks: [], version: '0.80.1', installation: 'ok' },
      });

      await handler.query('health', { detailed: true });

      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: 'cleo',
          operation: '--validate',
          flags: expect.objectContaining({ detailed: true }),
        })
      );
    });
  });

  describe('query: config', () => {
    it('should get full config', async () => {
      const mockConfig = {
        lifecycleEnforcement: { mode: 'strict' },
        mcp: { enabled: true },
      };

      (mockExecutor.execute as jest.Mock<any>).mockResolvedValueOnce({
        success: true,
        data: mockConfig,
      });

      const response = await handler.query('config');

      expect(response.success).toBe(true);
      expect(response.data).toEqual(mockConfig);
      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({ domain: 'system', operation: 'config' })
      );
    });

    it('should get specific config key', async () => {
      const mockConfig = {
        lifecycleEnforcement: { mode: 'strict' },
        mcp: { enabled: true },
      };

      (mockExecutor.execute as jest.Mock<any>).mockResolvedValueOnce({
        success: true,
        data: mockConfig,
      });

      const response = await handler.query('config', { key: 'lifecycleEnforcement.mode' });

      expect(response.success).toBe(true);
      expect(response.data).toEqual({ 'lifecycleEnforcement.mode': 'strict' });
    });

    it('should handle missing config key', async () => {
      (mockExecutor.execute as jest.Mock<any>).mockResolvedValueOnce({
        success: true,
        data: { foo: 'bar' },
      });

      const response = await handler.query('config', { key: 'nonexistent.key' });

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('E_NOT_FOUND');
    });

    it('should handle invalid JSON', async () => {
      (mockExecutor.execute as jest.Mock<any>).mockResolvedValueOnce({
        success: true,
        data: 'invalid json',
      });

      const response = await handler.query('config');

      // Config handler returns whatever data the executor provides
      // Since the executor already parsed it, it just wraps it
      expect(response.success).toBe(true);
    });
  });

  describe('query: diagnostics', () => {
    it('should run full diagnostics', async () => {
      (mockExecutor.execute as jest.Mock<any>).mockResolvedValueOnce({
        success: true,
        data: {
          timestamp: '2026-02-04T00:00:00Z',
          checks: [
            { name: 'schema', status: 'pass' },
            { name: 'integrity', status: 'pass' },
          ],
          summary: { total: 2, passed: 2, warned: 0, failed: 0 },
        },
      });

      const response = await handler.query('diagnostics');

      expect(response.success).toBe(true);
      expect(response.data).toHaveProperty('checks');
      expect(response.data).toHaveProperty('summary');
      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({ domain: 'validate', operation: 'all' })
      );
    });

    it('should run specific diagnostic checks', async () => {
      (mockExecutor.execute as jest.Mock<any>).mockResolvedValueOnce({
        success: true,
        data: { timestamp: '2026-02-04T00:00:00Z', checks: [], summary: {} },
      });

      await handler.query('diagnostics', { checks: ['schema', 'integrity'] });

      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: 'validate',
          operation: 'all',
          args: ['--checks', 'schema,integrity'],
        })
      );
    });
  });

  describe('query: version', () => {
    it('should get CLEO version', async () => {
      (mockExecutor.execute as jest.Mock<any>).mockResolvedValueOnce({
        success: true,
        data: {
          version: '0.80.1',
          schema: {
            todo: '2.6.0',
            config: '1.2.0',
            archive: '2.0.0',
            log: '1.1.0',
          },
        },
      });

      const response = await handler.query('version');

      expect(response.success).toBe(true);
      expect(response.data).toHaveProperty('version');
      expect(response.data).toHaveProperty('schema');
      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({ domain: 'system', operation: 'version' })
      );
    });
  });

  describe('query: help', () => {
    it('should get general help', async () => {
      (mockExecutor.execute as jest.Mock<any>).mockResolvedValueOnce({
        success: true,
        data: {
          content: 'CLEO help text...',
          relatedCommands: ['add', 'list', 'show'],
        },
      });

      const response = await handler.query('help');

      expect(response.success).toBe(true);
      expect(response.data).toHaveProperty('content');
      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({ domain: 'help', operation: 'show' })
      );
    });

    it('should get help for specific topic', async () => {
      (mockExecutor.execute as jest.Mock<any>).mockResolvedValueOnce({
        success: true,
        data: {
          topic: 'session',
          content: 'Session management help...',
          relatedCommands: ['session start', 'session end'],
        },
      });

      await handler.query('help', { topic: 'session' });

      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: 'help',
          operation: 'show',
          args: ['session'],
        })
      );
    });
  });

  /**
   * MUTATE OPERATIONS
   */

  describe('mutate: backup', () => {
    it('should create snapshot backup', async () => {
      (mockExecutor.execute as jest.Mock<any>).mockResolvedValueOnce({
        success: true,
        data: {
          backupId: 'backup-20260204-000000',
          path: '.cleo/backups/snapshot/backup-20260204-000000',
          timestamp: '2026-02-04T00:00:00Z',
          type: 'snapshot',
          size: 1024000,
        },
      });

      const response = await handler.mutate('backup', { type: 'snapshot', note: 'Test backup' });

      expect(response.success).toBe(true);
      expect(response.data).toHaveProperty('backupId');
      expect(response.data).toHaveProperty('path');
      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: 'backup',
          operation: 'create',
          args: ['snapshot'],
          flags: expect.objectContaining({ note: 'Test backup' }),
        })
      );
    });

    it('should create backup with default type', async () => {
      (mockExecutor.execute as jest.Mock<any>).mockResolvedValueOnce({
        success: true,
        data: { backupId: 'backup-id', path: '/path', timestamp: '2026-02-04T00:00:00Z', type: 'snapshot' },
      });

      await handler.mutate('backup');

      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: 'backup',
          operation: 'create',
          args: ['snapshot'],
        })
      );
    });
  });

  describe('mutate: restore', () => {
    it('should restore backup', async () => {
      (mockExecutor.execute as jest.Mock<any>).mockResolvedValueOnce({
        success: true,
        data: {
          restored: true,
          backupId: 'backup-20260204-000000',
          timestamp: '2026-02-04T00:00:00Z',
          filesRestored: ['todo.json', 'config.json'],
        },
      });

      const response = await handler.mutate('restore', { backupId: 'backup-20260204-000000' });

      expect(response.success).toBe(true);
      expect(response.data).toHaveProperty('restored');
      expect(response.data).toHaveProperty('filesRestored');
      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: 'backup',
          operation: 'restore',
          args: ['backup-20260204-000000'],
        })
      );
    });

    it('should restore backup with force flag', async () => {
      (mockExecutor.execute as jest.Mock<any>).mockResolvedValueOnce({
        success: true,
        data: { restored: true, backupId: 'backup-id', timestamp: '2026-02-04T00:00:00Z', filesRestored: [] },
      });

      await handler.mutate('restore', { backupId: 'backup-id', force: true });

      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: 'backup',
          operation: 'restore',
          args: ['backup-id'],
          flags: expect.objectContaining({ force: true }),
        })
      );
    });

    it('should require backupId parameter', async () => {
      const response = await handler.mutate('restore', {});

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('E_INVALID_INPUT');
    });
  });

  describe('mutate: migrate', () => {
    it('should run migrations to latest', async () => {
      (mockExecutor.execute as jest.Mock<any>).mockResolvedValueOnce({
        success: true,
        data: {
          from: '2.5.0',
          to: '2.6.0',
          migrations: [{ name: 'add_field', applied: true, timestamp: '2026-02-04T00:00:00Z' }],
          dryRun: false,
        },
      });

      const response = await handler.mutate('migrate');

      expect(response.success).toBe(true);
      expect(response.data).toHaveProperty('from');
      expect(response.data).toHaveProperty('to');
      expect(response.data).toHaveProperty('migrations');
      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: 'migrate',
          operation: 'run',
          args: ['up'],
        })
      );
    });

    it('should migrate to specific version', async () => {
      (mockExecutor.execute as jest.Mock<any>).mockResolvedValueOnce({
        success: true,
        data: { from: '2.5.0', to: '2.6.0', migrations: [], dryRun: false },
      });

      await handler.mutate('migrate', { target: '2.6.0' });

      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: 'migrate',
          operation: 'run',
          args: ['to', '2.6.0'],
        })
      );
    });

    it('should run migration dry-run', async () => {
      (mockExecutor.execute as jest.Mock<any>).mockResolvedValueOnce({
        success: true,
        data: { from: '2.5.0', to: '2.6.0', migrations: [], dryRun: true },
      });

      await handler.mutate('migrate', { dryRun: true });

      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: 'migrate',
          operation: 'run',
          args: ['up'],
          flags: expect.objectContaining({ 'dry-run': true }),
        })
      );
    });
  });

  describe('mutate: cleanup', () => {
    it('should cleanup archive', async () => {
      (mockExecutor.execute as jest.Mock<any>).mockResolvedValueOnce({
        success: true,
        data: {
          target: 'archive',
          deleted: 5,
          freedBytes: 10240,
          items: ['T001', 'T002', 'T003', 'T004', 'T005'],
          dryRun: false,
        },
      });

      const response = await handler.mutate('cleanup', { target: 'archive', olderThan: '2025-01-01' });

      expect(response.success).toBe(true);
      expect(response.data).toHaveProperty('deleted');
      expect(response.data).toHaveProperty('items');
      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: 'archive',
          operation: 'cleanup',
          flags: expect.objectContaining({ 'older-than': '2025-01-01' }),
        })
      );
    });

    it('should cleanup sessions', async () => {
      (mockExecutor.execute as jest.Mock<any>).mockResolvedValueOnce({
        success: true,
        data: { target: 'sessions', deleted: 3, items: [], dryRun: false },
      });

      await handler.mutate('cleanup', { target: 'sessions', olderThan: '30d' });

      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: 'session',
          operation: 'gc',
          flags: expect.objectContaining({ 'older-than': '30d' }),
        })
      );
    });

    it('should cleanup backups', async () => {
      (mockExecutor.execute as jest.Mock<any>).mockResolvedValueOnce({
        success: true,
        data: { target: 'backups', deleted: 10, items: [], dryRun: false },
      });

      await handler.mutate('cleanup', { target: 'backups' });

      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: 'backup',
          operation: 'cleanup',
        })
      );
    });

    it('should cleanup logs', async () => {
      (mockExecutor.execute as jest.Mock<any>).mockResolvedValueOnce({
        success: true,
        data: { target: 'logs', deleted: 2, items: [], dryRun: false },
      });

      await handler.mutate('cleanup', { target: 'logs' });

      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: 'log',
          operation: 'cleanup',
        })
      );
    });

    it('should require target parameter', async () => {
      const response = await handler.mutate('cleanup', {});

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('E_INVALID_INPUT');
    });

    it('should validate target parameter', async () => {
      const response = await handler.mutate('cleanup', { target: 'invalid' });

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('E_INVALID_INPUT');
    });

    it('should support dry-run flag', async () => {
      (mockExecutor.execute as jest.Mock<any>).mockResolvedValueOnce({
        success: true,
        data: { target: 'archive', deleted: 0, items: [], dryRun: true },
      });

      await handler.mutate('cleanup', { target: 'archive', dryRun: true });

      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: 'archive',
          operation: 'cleanup',
          flags: expect.objectContaining({ 'dry-run': true }),
        })
      );
    });
  });

  describe('mutate: audit', () => {
    it('should run full audit', async () => {
      (mockExecutor.execute as jest.Mock<any>).mockResolvedValueOnce({
        success: true,
        data: {
          scope: 'all',
          issues: [
            { severity: 'warning', category: 'integrity', message: 'Minor issue' },
          ],
          summary: { errors: 0, warnings: 1, fixed: 0 },
        },
      });

      const response = await handler.mutate('audit');

      expect(response.success).toBe(true);
      expect(response.data).toHaveProperty('issues');
      expect(response.data).toHaveProperty('summary');
      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: 'validate',
          operation: 'audit',
          args: ['all'],
        })
      );
    });

    it('should run audit for specific scope', async () => {
      (mockExecutor.execute as jest.Mock<any>).mockResolvedValueOnce({
        success: true,
        data: { scope: 'tasks', issues: [], summary: { errors: 0, warnings: 0, fixed: 0 } },
      });

      await handler.mutate('audit', { scope: 'tasks' });

      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: 'validate',
          operation: 'audit',
          args: ['tasks'],
        })
      );
    });

    it('should run audit with auto-fix', async () => {
      (mockExecutor.execute as jest.Mock<any>).mockResolvedValueOnce({
        success: true,
        data: { scope: 'all', issues: [], summary: { errors: 0, warnings: 0, fixed: 3 } },
      });

      await handler.mutate('audit', { fix: true });

      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: 'validate',
          operation: 'audit',
          args: ['all'],
          flags: expect.objectContaining({ fix: true }),
        })
      );
    });
  });

  /**
   * ERROR HANDLING
   */

  describe('error handling', () => {
    it('should handle invalid query operation', async () => {
      const response = await handler.query('invalid');

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('E_INVALID_OPERATION');
    });

    it('should handle invalid mutate operation', async () => {
      const response = await handler.mutate('invalid');

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('E_INVALID_OPERATION');
    });

    it('should handle executor not provided', async () => {
      const handlerWithoutExecutor = new SystemHandler();
      const response = await handlerWithoutExecutor.query('version');

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('E_NOT_INITIALIZED');
    });
  });
});
