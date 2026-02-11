/**
 * Validate Domain Handler Tests
 *
 * Tests all 11 validation operations with proper mocking of CLIExecutor.
 *
 * @task T2933
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { ValidateHandler } from '../validate.js';
import { CLIExecutor } from '../../lib/executor.js';
import { createMockExecutor } from '../../__tests__/utils.js';

// Mock CLIExecutor
jest.mock('../../lib/executor.js');

describe('ValidateHandler', () => {
  let handler: ValidateHandler;
  let mockExecutor: CLIExecutor;

  beforeEach(() => {
    mockExecutor = createMockExecutor();
    handler = new ValidateHandler(mockExecutor);
  });

  describe('Query Operations', () => {
    describe('report', () => {
      it('should get validation report', async () => {
        const mockReport = {
          success: true,
          errors: [],
          warnings: [],
          summary: { totalChecks: 10, passed: 10, failed: 0 },
        };

        jest.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: mockReport,
          exitCode: 0,
          stdout: JSON.stringify(mockReport),
          stderr: '',
          duration: 50,
        });

        const result = await handler.query('report', { scope: 'todo' });

        expect(result.success).toBe(true);
        expect(result.data).toEqual(mockReport);
        expect(result._meta.operation).toBe('report');
        expect(mockExecutor.execute).toHaveBeenCalledWith(
          expect.objectContaining({
            domain: 'validate',
            flags: expect.objectContaining({ scope: 'todo' }),
          })
        );
      });
    });

    describe('stats', () => {
      it('should get validation statistics', async () => {
        const mockStats = {
          totalValidations: 100,
          passed: 95,
          failed: 5,
          byType: { schema: 50, protocol: 50 },
        };

        jest.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: mockStats,
          exitCode: 0,
          stdout: JSON.stringify(mockStats),
          stderr: '',
          duration: 50,
        });

        const result = await handler.query('stats', { since: '2026-02-01' });

        expect(result.success).toBe(true);
        expect(result.data).toEqual(mockStats);
        expect(mockExecutor.execute).toHaveBeenCalledWith(
          expect.objectContaining({
            domain: 'validate',
            operation: 'stats',
            flags: expect.objectContaining({ since: '2026-02-01' }),
          })
        );
      });
    });

    describe('task', () => {
      // Fixed: validate.task now fetches task via 'cleo show' and runs
      // programmatic validation, not via 'cleo validate task'
      it('should validate single task via show + programmatic checks', async () => {
        const mockTask = {
          task: {
            id: 'T2933',
            title: 'Test task',
            description: 'Test description',
            status: 'active',
            createdAt: '2026-01-01T00:00:00Z',
            size: 'medium',
          },
        };

        jest.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: mockTask,
          exitCode: 0,
          stdout: JSON.stringify(mockTask),
          stderr: '',
          duration: 50,
        });

        const result = await handler.query('task', { taskId: 'T2933', checkMode: 'full' });

        expect(result.success).toBe(true);
        // Now calls 'show' instead of 'validate task'
        expect(mockExecutor.execute).toHaveBeenCalledWith(
          expect.objectContaining({
            domain: 'show',
            operation: 'T2933',
          })
        );
        // Result contains programmatic validation output
        expect(result.data).toHaveProperty('taskId', 'T2933');
        expect(result.data).toHaveProperty('valid');
        expect(result.data).toHaveProperty('errors');
        expect(result.data).toHaveProperty('warnings');
      });

      it('should return error when taskId missing', async () => {
        const result = await handler.query('task', {});

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_INPUT');
        expect(result.error?.message).toContain('taskId is required');
      });
    });

    describe('compliance', () => {
      it('should check protocol compliance', async () => {
        const mockCompliance = {
          compliant: true,
          score: 0.95,
          violations: [],
        };

        jest.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: mockCompliance,
          exitCode: 0,
          stdout: JSON.stringify(mockCompliance),
          stderr: '',
          duration: 50,
        });

        const result = await handler.query('compliance', {
          protocolType: 'implementation',
          severity: 'error',
        });

        expect(result.success).toBe(true);
        expect(result.data).toEqual(mockCompliance);
        expect(mockExecutor.execute).toHaveBeenCalledWith(
          expect.objectContaining({
            domain: 'validate',
            operation: 'compliance',
            flags: expect.objectContaining({
              protocol: 'implementation',
              severity: 'error',
            }),
          })
        );
      });
    });

    describe('all', () => {
      it('should validate entire system', async () => {
        const mockValidation = {
          success: true,
          errors: [],
          warnings: [],
          summary: { totalChecks: 50, passed: 48, failed: 2 },
        };

        jest.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: mockValidation,
          exitCode: 0,
          stdout: JSON.stringify(mockValidation),
          stderr: '',
          duration: 100,
        });

        const result = await handler.query('all', { strict: true, includeArchive: true });

        expect(result.success).toBe(true);
        expect(result.data).toEqual(mockValidation);
        expect(mockExecutor.execute).toHaveBeenCalledWith(
          expect.objectContaining({
            domain: 'validate',
            operation: 'all',
            flags: expect.objectContaining({ strict: true, includeArchive: true }),
          })
        );
      });
    });

    it('should return error for unknown query operation', async () => {
      const result = await handler.query('unknown', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
      expect(result.error?.message).toContain('unknown');
    });
  });

  describe('Mutate Operations', () => {
    describe('fix', () => {
      it('should auto-fix validation errors', async () => {
        const mockFix = {
          fixed: 5,
          skipped: 0,
          errors: [],
          changes: [
            { type: 'duplicate', description: 'Reassigned ID for task' },
          ],
        };

        jest.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: mockFix,
          exitCode: 0,
          stdout: JSON.stringify(mockFix),
          stderr: '',
          duration: 100,
        });

        const result = await handler.mutate('fix', {
          auto: true,
          dryRun: true,
          fixType: 'duplicates',
        });

        expect(result.success).toBe(true);
        expect(result.data).toEqual(mockFix);
        expect(mockExecutor.execute).toHaveBeenCalledWith(
          expect.objectContaining({
            domain: 'validate',
            flags: expect.objectContaining({
              fix: true,
              auto: true,
              dryRun: true,
              fixDuplicates: true,
            }),
          })
        );
      });

      it('should handle fix all types', async () => {
        jest.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: { fixed: 10, skipped: 0, errors: [], changes: [] },
          exitCode: 0,
          stdout: '{}',
          stderr: '',
          duration: 100,
        });

        await handler.mutate('fix', { fixType: 'all' });

        expect(mockExecutor.execute).toHaveBeenCalledWith(
          expect.objectContaining({
            flags: expect.objectContaining({
              fixDuplicates: true,
              fixOrphans: 'unlink',
              fixMissingSizes: true,
            }),
          })
        );
      });
    });

    describe('schema', () => {
      it('should validate against schema', async () => {
        const mockValidation = {
          success: true,
          errors: [],
          warnings: [],
          summary: { totalChecks: 3, passed: 3, failed: 0 },
        };

        jest.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: mockValidation,
          exitCode: 0,
          stdout: JSON.stringify(mockValidation),
          stderr: '',
          duration: 50,
        });

        const result = await handler.mutate('schema', {
          fileType: 'todo',
          filePath: '.cleo/todo.json',
        });

        expect(result.success).toBe(true);
        expect(result.data).toEqual(mockValidation);
        expect(mockExecutor.execute).toHaveBeenCalledWith(
          expect.objectContaining({
            domain: 'validate',
            operation: 'schema',
            args: ['todo', '.cleo/todo.json'],
          })
        );
      });

      it('should return error when fileType missing', async () => {
        const result = await handler.mutate('schema', {});

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_INPUT');
        expect(result.error?.message).toContain('fileType is required');
      });
    });

    describe('protocol', () => {
      it('should validate protocol compliance', async () => {
        const mockCompliance = {
          compliant: true,
          score: 1.0,
          violations: [],
        };

        jest.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: mockCompliance,
          exitCode: 0,
          stdout: JSON.stringify(mockCompliance),
          stderr: '',
          duration: 50,
        });

        const result = await handler.mutate('protocol', {
          taskId: 'T2933',
          protocolType: 'implementation',
          strict: true,
        });

        expect(result.success).toBe(true);
        expect(result.data).toEqual(mockCompliance);
        expect(mockExecutor.execute).toHaveBeenCalledWith(
          expect.objectContaining({
            domain: 'validate',
            operation: 'protocol',
            args: ['T2933', 'implementation'],
            flags: expect.objectContaining({ strict: true }),
          })
        );
      });

      it('should return error when required params missing', async () => {
        const result = await handler.mutate('protocol', { taskId: 'T2933' });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_INPUT');
        expect(result.error?.message).toContain('taskId and protocolType are required');
      });
    });

    describe('session', () => {
      it('should validate session state', async () => {
        const mockValidation = {
          success: true,
          errors: [],
          warnings: [],
          summary: { totalChecks: 4, passed: 4, failed: 0 },
        };

        jest.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: mockValidation,
          exitCode: 0,
          stdout: JSON.stringify(mockValidation),
          stderr: '',
          duration: 50,
        });

        const result = await handler.mutate('session', {
          sessionId: 'session_123',
          checkFocus: true,
        });

        expect(result.success).toBe(true);
        expect(result.data).toEqual(mockValidation);
        expect(mockExecutor.execute).toHaveBeenCalledWith(
          expect.objectContaining({
            domain: 'validate',
            operation: 'session',
            args: ['session_123'],
            flags: expect.objectContaining({ checkFocus: true }),
          })
        );
      });
    });

    describe('research', () => {
      it('should validate research links', async () => {
        const mockValidation = {
          success: true,
          errors: [],
          warnings: [],
          summary: { totalChecks: 2, passed: 2, failed: 0 },
        };

        jest.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: mockValidation,
          exitCode: 0,
          stdout: JSON.stringify(mockValidation),
          stderr: '',
          duration: 50,
        });

        const result = await handler.mutate('research', {
          taskId: 'T2933',
          checkLinks: true,
        });

        expect(result.success).toBe(true);
        expect(result.data).toEqual(mockValidation);
        expect(mockExecutor.execute).toHaveBeenCalledWith(
          expect.objectContaining({
            domain: 'validate',
            operation: 'research',
            args: ['T2933'],
            flags: expect.objectContaining({ checkLinks: true }),
          })
        );
      });

      it('should return error when taskId missing', async () => {
        const result = await handler.mutate('research', {});

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_INPUT');
        expect(result.error?.message).toContain('taskId is required');
      });
    });

    describe('lifecycle', () => {
      it('should validate lifecycle gates', async () => {
        const mockValidation = {
          success: true,
          errors: [],
          warnings: [],
          summary: { totalChecks: 8, passed: 8, failed: 0 },
        };

        jest.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: mockValidation,
          exitCode: 0,
          stdout: JSON.stringify(mockValidation),
          stderr: '',
          duration: 50,
        });

        const result = await handler.mutate('lifecycle', {
          taskId: 'T2933',
          targetStage: 'implementation',
        });

        expect(result.success).toBe(true);
        expect(result.data).toEqual(mockValidation);
        expect(mockExecutor.execute).toHaveBeenCalledWith(
          expect.objectContaining({
            domain: 'validate',
            operation: 'lifecycle',
            args: ['T2933', 'implementation'],
          })
        );
      });

      it('should return error when taskId missing', async () => {
        const result = await handler.mutate('lifecycle', {});

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_INPUT');
        expect(result.error?.message).toContain('taskId is required');
      });
    });

    it('should return error for unknown mutate operation', async () => {
      const result = await handler.mutate('unknown', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
      expect(result.error?.message).toContain('unknown');
    });
  });

  // ===== Regression Tests (T4317 fixes) =====

  describe('Regression Tests', () => {
    // Regression: T4317 - validate.task was running full system validation
    // instead of scoping to the specific task. Now uses 'cleo show' to fetch
    // the task, then runs programmatic validation checks on it.
    it('should validate only the specified task, not run full validate (T4317)', async () => {
      const mockTask = {
        task: {
          id: 'T001',
          title: 'Test task',
          description: 'Test description',
          status: 'active',
          createdAt: '2026-01-01T00:00:00Z',
          size: 'medium',
        },
      };

      jest.mocked(mockExecutor.execute).mockResolvedValue({
        success: true,
        data: mockTask,
        exitCode: 0,
        stdout: JSON.stringify(mockTask),
        stderr: '',
        duration: 50,
      });

      const result = await handler.query('task', { taskId: 'T001' });

      expect(result.success).toBe(true);
      // Should call 'show' to fetch the task, NOT 'validate task'
      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: 'show',
          operation: 'T001',
        })
      );
      // Result should contain task-specific validation data
      expect(result.data).toHaveProperty('taskId', 'T001');
      expect(result.data).toHaveProperty('valid');
      expect(result.data).toHaveProperty('errors');
      expect(result.data).toHaveProperty('warnings');
    });

    // Regression: T4317 - validate.task should detect validation issues in task data
    it('should detect missing required fields on task validation (T4317)', async () => {
      const mockTask = {
        task: {
          id: 'T002',
          // Missing title, missing createdAt
          status: 'active',
        },
      };

      jest.mocked(mockExecutor.execute).mockResolvedValue({
        success: true,
        data: mockTask,
        exitCode: 0,
        stdout: JSON.stringify(mockTask),
        stderr: '',
        duration: 50,
      });

      const result = await handler.query('task', { taskId: 'T002' });

      expect(result.success).toBe(true);
      const data = result.data as { valid: boolean; errors: unknown[] };
      expect(data.valid).toBe(false);
      expect(data.errors.length).toBeGreaterThan(0);
    });

    // Regression: T4317 - validate.manifest was not scoping to specific entries.
    // Now uses 'cleo research list' and filters by taskId/entry.
    it('should scope manifest validation to specific task entries (T4317)', async () => {
      const mockManifestEntries = {
        entries: [
          {
            id: 'T001-research',
            file: 'research.md',
            title: 'Research on T001',
            date: '2026-02-01',
            status: 'complete',
            agent_type: 'research',
          },
        ],
      };

      jest.mocked(mockExecutor.execute).mockResolvedValue({
        success: true,
        data: mockManifestEntries,
        exitCode: 0,
        stdout: JSON.stringify(mockManifestEntries),
        stderr: '',
        duration: 50,
      });

      const result = await handler.query('manifest', { taskId: 'T001' });

      expect(result.success).toBe(true);
      // Should call research list with task filter
      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: 'research',
          operation: 'list',
          flags: expect.objectContaining({ task: 'T001' }),
        })
      );
      // Result should include validation data
      expect(result.data).toHaveProperty('valid');
      expect(result.data).toHaveProperty('entriesChecked');
    });

    // Regression: T4317 - validate.manifest should properly validate status enum
    // for manifest entries without throwing
    it('should validate manifest entries with valid status enum (T4317)', async () => {
      const mockManifestEntries = {
        entries: [
          {
            id: 'T001-spec',
            file: 'spec.md',
            title: 'Spec',
            date: '2026-02-01',
            status: 'complete',  // Valid manifest status
            agent_type: 'specification',
          },
        ],
      };

      jest.mocked(mockExecutor.execute).mockResolvedValue({
        success: true,
        data: mockManifestEntries,
        exitCode: 0,
        stdout: JSON.stringify(mockManifestEntries),
        stderr: '',
        duration: 50,
      });

      const result = await handler.query('manifest', {});

      expect(result.success).toBe(true);
      const data = result.data as { valid: boolean; errors: unknown[] };
      expect(data.valid).toBe(true);
      expect(data.errors).toHaveLength(0);
    });
  });

  describe('getSupportedOperations', () => {
    it('should return all supported operations', () => {
      const operations = handler.getSupportedOperations();

      expect(operations.query).toEqual([
        'report', 'stats', 'task', 'compliance', 'all',
        'schema', 'protocol', 'manifest', 'output',
        'compliance.summary', 'compliance.violations',
        'test.status', 'test.coverage',
      ]);
      expect(operations.mutate).toEqual([
        'fix', 'schema', 'protocol', 'session', 'research', 'lifecycle',
        'compliance.record', 'test.run',
      ]);
    });
  });
});
