/**
 * Tests for Lifecycle Domain Handler
 *
 * Tests all 10 lifecycle operations:
 * - Query (5): stages, status, validate, report, export
 * - Mutate (5): record, enforce, skip, unskip, import
 *
 * @task T2932
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LifecycleHandler } from '../lifecycle';
import { CLIExecutor } from '../../lib/executor';
import { createMockExecutor } from '../../__tests__/utils.js';

describe('LifecycleHandler', () => {
  let handler: LifecycleHandler;
  let mockExecutor: CLIExecutor;

  beforeEach(() => {
    mockExecutor = createMockExecutor();

    handler = new LifecycleHandler(mockExecutor);
  });

  describe('getSupportedOperations', () => {
    it('should return correct operation lists', () => {
      const ops = handler.getSupportedOperations();

      expect(ops.query).toEqual([
        'stages', 'status', 'validate', 'report', 'export',
        'history', 'gates', 'prerequisites',
      ]);
      expect(ops.mutate).toEqual([
        'record', 'enforce', 'skip', 'unskip', 'import',
        'reset', 'gate.pass', 'gate.fail',
      ]);
    });
  });

  // ===== Query Operations =====

  describe('query: stages', () => {
    it('should list all lifecycle stages', async () => {
      const mockResult = {
        success: true,
        data: {
          stages: [
            { stage: 'research', name: 'Research', exitCode: 60, order: 0 },
            { stage: 'consensus', name: 'Consensus', exitCode: 61, order: 1 },
          ],
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult);

      const result = await handler.query('stages', {});

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockResult.data);
      expect(mockExecutor.execute).toHaveBeenCalledWith({
        domain: 'lifecycle',
        operation: 'stages',
        flags: { json: true },
      });
    });

    it('should filter by pipeline', async () => {
      const mockResult = {
        success: true,
        data: {
          stages: [
            { stage: 'research', name: 'Research', exitCode: 60, order: 0 },
          ],
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult);

      await handler.query('stages', { pipeline: 'rcsd' });

      expect(mockExecutor.execute).toHaveBeenCalledWith({
        domain: 'lifecycle',
        operation: 'stages',
        flags: { json: true, pipeline: 'rcsd' },
      });
    });
  });

  describe('query: status', () => {
    it('should get lifecycle status for epic', async () => {
      const mockResult = {
        success: true,
        data: {
          epicId: 'T2908',
          currentStage: 'implementation',
          stages: [
            { stage: 'research', status: 'completed' },
            { stage: 'implementation', status: 'pending' },
          ],
          nextStage: 'validation',
          blockedOn: [],
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult);

      const result = await handler.query('status', { epicId: 'T2908' });

      expect(result.success).toBe(true);
      expect((result.data as any).epicId).toBe('T2908');
      expect(mockExecutor.execute).toHaveBeenCalledWith({
        domain: 'lifecycle',
        operation: 'status',
        args: ['T2908'],
        flags: { json: true },
      });
    });

    it('should require epicId', async () => {
      const result = await handler.query('status', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
      expect(result.error?.message).toContain('epicId is required');
    });
  });

  describe('query: validate', () => {
    it('should validate lifecycle progression', async () => {
      const mockResult = {
        success: true,
        data: {
          valid: true,
          canProgress: true,
          missingPrerequisites: [],
          issues: [],
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult);

      const result = await handler.query('validate', {
        epicId: 'T2908',
        targetStage: 'implementation',
      });

      expect(result.success).toBe(true);
      expect((result.data as any).valid).toBe(true);
      expect(mockExecutor.execute).toHaveBeenCalledWith({
        domain: 'lifecycle',
        operation: 'validate',
        args: ['T2908', 'implementation'],
        flags: { json: true },
      });
    });

    it('should require epicId and targetStage', async () => {
      const result = await handler.query('validate', { epicId: 'T2908' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });
  });

  describe('query: report', () => {
    it('should generate lifecycle report', async () => {
      const mockResult = {
        success: true,
        data: {
          totalEpics: 10,
          byStage: [
            { stage: 'research', count: 3, averageDuration: 120 },
          ],
          completionRate: 0.75,
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult);

      const result = await handler.query('report', {});

      expect(result.success).toBe(true);
      expect((result.data as any).totalEpics).toBe(10);
    });

    it('should filter report by epic', async () => {
      const mockResult = {
        success: true,
        data: { totalEpics: 1, byStage: [], completionRate: 1.0 },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult);

      await handler.query('report', { epicId: 'T2908', format: 'detailed' });

      expect(mockExecutor.execute).toHaveBeenCalledWith({
        domain: 'lifecycle',
        operation: 'report',
        flags: { json: true, epic: 'T2908', format: 'detailed' },
      });
    });
  });

  describe('query: export', () => {
    it('should export lifecycle data', async () => {
      const mockResult = {
        success: true,
        data: {
          format: 'json',
          data: { epics: [] },
          timestamp: '2026-02-04T00:00:00Z',
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult);

      const result = await handler.query('export', { format: 'json' });

      expect(result.success).toBe(true);
      expect((result.data as any).format).toBe('json');
    });

    it('should include history if requested', async () => {
      const mockResult = {
        success: true,
        data: { format: 'csv', data: '', timestamp: '2026-02-04T00:00:00Z' },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult);

      await handler.query('export', { includeHistory: true, format: 'csv' });

      expect(mockExecutor.execute).toHaveBeenCalledWith({
        domain: 'lifecycle',
        operation: 'export',
        flags: { json: true, format: 'csv', history: true },
      });
    });
  });

  describe('query: unknown operation', () => {
    it('should return error for unknown operation', async () => {
      const result = await handler.query('unknown', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
      expect(result.error?.message).toContain('unknown');
    });
  });

  // ===== Mutate Operations =====

  describe('mutate: record', () => {
    it('should record stage completion', async () => {
      const mockResult = {
        success: true,
        data: {
          epicId: 'T2908',
          stage: 'research',
          status: 'completed',
          recorded: true,
          timestamp: '2026-02-04T00:00:00Z',
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult);

      const result = await handler.mutate('record', {
        epicId: 'T2908',
        stage: 'research',
        status: 'completed',
      });

      expect(result.success).toBe(true);
      expect((result.data as any).recorded).toBe(true);
      expect(mockExecutor.execute).toHaveBeenCalledWith({
        domain: 'lifecycle',
        operation: 'record',
        args: ['T2908', 'research', 'completed'],
        flags: { json: true },
      });
    });

    it('should include notes', async () => {
      const mockResult = {
        success: true,
        data: {
          epicId: 'T2908',
          stage: 'research',
          status: 'completed',
          recorded: true,
          timestamp: '2026-02-04T00:00:00Z',
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult);

      await handler.mutate('record', {
        epicId: 'T2908',
        stage: 'research',
        status: 'completed',
        notes: 'Research complete',
      });

      expect(mockExecutor.execute).toHaveBeenCalledWith({
        domain: 'lifecycle',
        operation: 'record',
        args: ['T2908', 'research', 'completed'],
        flags: { json: true, notes: 'Research complete' },
      });
    });

    it('should require epicId, stage, and status', async () => {
      const result = await handler.mutate('record', { epicId: 'T2908' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });
  });

  describe('mutate: enforce', () => {
    it('should enforce lifecycle gates', async () => {
      const mockResult = {
        success: true,
        data: {
          epicId: 'T2908',
          stage: 'implementation',
          allowed: true,
          gatesPassed: ['research', 'consensus'],
          gatesFailed: [],
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult);

      const result = await handler.mutate('enforce', {
        epicId: 'T2908',
        stage: 'implementation',
      });

      expect(result.success).toBe(true);
      expect((result.data as any).allowed).toBe(true);
    });

    it('should support strict mode', async () => {
      const mockResult = {
        success: true,
        data: {
          epicId: 'T2908',
          stage: 'implementation',
          allowed: false,
          gatesPassed: [],
          gatesFailed: ['research'],
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult);

      await handler.mutate('enforce', {
        epicId: 'T2908',
        stage: 'implementation',
        strict: true,
      });

      expect(mockExecutor.execute).toHaveBeenCalledWith({
        domain: 'lifecycle',
        operation: 'enforce',
        args: ['T2908', 'implementation'],
        flags: { json: true, strict: true },
      });
    });
  });

  describe('mutate: skip', () => {
    it('should skip a stage', async () => {
      const mockResult = {
        success: true,
        data: {
          epicId: 'T2908',
          stage: 'consensus',
          skipped: true,
          reason: 'Single maintainer project',
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult);

      const result = await handler.mutate('skip', {
        epicId: 'T2908',
        stage: 'consensus',
        reason: 'Single maintainer project',
      });

      expect(result.success).toBe(true);
      expect((result.data as any).skipped).toBe(true);
      expect(mockExecutor.execute).toHaveBeenCalledWith({
        domain: 'lifecycle',
        operation: 'skip',
        args: ['T2908', 'consensus'],
        flags: { json: true, reason: 'Single maintainer project' },
      });
    });

    it('should require reason', async () => {
      const result = await handler.mutate('skip', {
        epicId: 'T2908',
        stage: 'consensus',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });
  });

  describe('mutate: unskip', () => {
    it('should unskip a stage', async () => {
      const mockResult = {
        success: true,
        data: {
          epicId: 'T2908',
          stage: 'consensus',
          unskipped: true,
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult);

      const result = await handler.mutate('unskip', {
        epicId: 'T2908',
        stage: 'consensus',
      });

      expect(result.success).toBe(true);
      expect((result.data as any).unskipped).toBe(true);
    });

    it('should require epicId and stage', async () => {
      const result = await handler.mutate('unskip', { epicId: 'T2908' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });
  });

  describe('mutate: import', () => {
    it('should import lifecycle data', async () => {
      const mockResult = {
        success: true,
        data: {
          imported: 5,
          skipped: 2,
          errors: [],
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult);

      const result = await handler.mutate('import', {
        source: './lifecycle.json',
      });

      expect(result.success).toBe(true);
      expect((result.data as any).imported).toBe(5);
    });

    it('should support epic filter and overwrite', async () => {
      const mockResult = {
        success: true,
        data: { imported: 1, skipped: 0, errors: [] },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult);

      await handler.mutate('import', {
        source: './lifecycle.json',
        epicId: 'T2908',
        overwrite: true,
      });

      expect(mockExecutor.execute).toHaveBeenCalledWith({
        domain: 'lifecycle',
        operation: 'import',
        args: ['./lifecycle.json'],
        flags: { json: true, epic: 'T2908', overwrite: true },
      });
    });

    it('should require source', async () => {
      const result = await handler.mutate('import', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });
  });

  describe('mutate: unknown operation', () => {
    it('should return error for unknown operation', async () => {
      const result = await handler.mutate('unknown', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
    });
  });

  // ===== Error Handling =====

  describe('error handling', () => {
    it('should handle executor errors', async () => {
      vi.mocked(mockExecutor.execute).mockRejectedValue(new Error('CLI error'));

      const result = await handler.query('stages', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INTERNAL_ERROR');
      expect(result.error?.message).toContain('CLI error');
    });

    it('should include duration in error response', async () => {
      const result = await handler.query('status', {});

      expect(result._meta.duration_ms).toBeGreaterThanOrEqual(0);
    });
  });
});
