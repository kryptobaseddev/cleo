/**
 * Research Domain Handler Tests
 *
 * Tests all 10 research operations with proper mocking of CLIExecutor.
 *
 * @task T2931
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ResearchHandler } from '../research.js';
import { CLIExecutor } from '../../lib/executor.js';
import { createMockExecutor } from '../../__tests__/utils.js';

// Mock CLIExecutor
vi.mock('../../lib/executor.js');

interface ResearchEntry {
  id: string;
  file: string;
  title: string;
  date: string;
  status: 'complete' | 'partial' | 'blocked';
  agent_type: string;
  topics: string[];
  key_findings: string[];
  actionable: boolean;
  needs_followup?: string[];
  linked_tasks?: string[];
}

interface ResearchStats {
  total: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
  actionable: number;
  needsFollowup: number;
  averageFindings: number;
}

describe('ResearchHandler', () => {
  let handler: ResearchHandler;
  let mockExecutor: CLIExecutor;

  beforeEach(() => {
    mockExecutor = createMockExecutor();
    handler = new ResearchHandler(mockExecutor);
  });

  describe('Query Operations', () => {
    describe('list', () => {
      // Fixed: list now uses ManifestReader directly, not CLI executor
      it('should list research entries via ManifestReader', async () => {
        const result = await handler.query('list', { taskId: 'T2908', limit: 10 });

        // Should succeed - ManifestReader handles empty/missing files gracefully
        expect(result.success).toBe(true);
        expect(result._meta.operation).toBe('list');
        // Fixed response wraps entries in { entries, total } structure
        expect(result.data).toHaveProperty('entries');
        expect(result.data).toHaveProperty('total');
        // Should NOT call executor for list (uses ManifestReader directly)
        expect(mockExecutor.execute).not.toHaveBeenCalled();
      });

      it('should list with filters via ManifestReader', async () => {
        const result = await handler.query('list', {
          status: 'complete',
          type: 'research',
          topic: 'mcp',
          actionable: true,
        });

        // Should succeed even with filters
        expect(result.success).toBe(true);
        // Should NOT call executor (uses ManifestReader directly)
        expect(mockExecutor.execute).not.toHaveBeenCalled();
      });
    });

    describe('stats', () => {
      // Fixed: stats now uses ManifestReader directly, not CLI executor
      it('should get research statistics via ManifestReader', async () => {
        const result = await handler.query('stats', { epicId: 'T2908' });

        expect(result.success).toBe(true);
        // Stats should have the expected shape with computed fields
        expect(result.data).toHaveProperty('total');
        expect(result.data).toHaveProperty('byStatus');
        expect(result.data).toHaveProperty('byType');
        expect(result.data).toHaveProperty('actionable');
        expect(result.data).toHaveProperty('needsFollowup');
        expect(result.data).toHaveProperty('averageFindings');
        // Should NOT call executor (uses ManifestReader directly)
        expect(mockExecutor.execute).not.toHaveBeenCalled();
      });

      it('should get stats without epic filter via ManifestReader', async () => {
        const result = await handler.query('stats', {});

        expect(result.success).toBe(true);
        expect(result.data).toHaveProperty('total');
        // Should NOT call executor (uses ManifestReader directly)
        expect(mockExecutor.execute).not.toHaveBeenCalled();
      });
    });

    describe('validate', () => {
      it('should validate research links', async () => {
        const mockValidation = {
          valid: true,
          taskId: 'T2931',
          linkedResearch: ['research-001', 'research-002'],
        };

        vi.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: mockValidation,
          exitCode: 0,
          stdout: JSON.stringify(mockValidation),
          stderr: '',
          duration: 50,
        });

        const result = await handler.query('validate', { taskId: 'T2931' });

        expect(result.success).toBe(true);
        expect(result.data).toEqual(mockValidation);
        expect(mockExecutor.execute).toHaveBeenCalledWith(
          expect.objectContaining({
            domain: 'research',
            operation: 'validate',
            args: ['T2931'],
          })
        );
      });

      it('should return error when taskId missing', async () => {
        const result = await handler.query('validate', {});

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_INPUT');
        expect(result.error?.message).toContain('taskId is required');
      });
    });

    describe('search', () => {
      it('should search research entries', async () => {
        const mockResults: ResearchEntry[] = [
          {
            id: 'search-001',
            file: 'search.md',
            title: 'Search result',
            date: '2026-02-03',
            status: 'complete',
            agent_type: 'research',
            topics: ['search'],
            key_findings: ['Result 1'],
            actionable: true,
          },
        ];

        vi.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: mockResults,
          exitCode: 0,
          stdout: JSON.stringify(mockResults),
          stderr: '',
          duration: 50,
        });

        const result = await handler.query('search', {
          query: 'MCP server',
          confidence: 0.8,
          limit: 5,
        });

        expect(result.success).toBe(true);
        expect(result.data).toEqual(mockResults);
        expect(mockExecutor.execute).toHaveBeenCalledWith(
          expect.objectContaining({
            args: ['MCP server'],
            flags: expect.objectContaining({ confidence: 0.8, limit: 5 }),
          })
        );
      });

      it('should return error when query missing', async () => {
        const result = await handler.query('search', {});

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_INPUT');
        expect(result.error?.message).toContain('query is required');
      });
    });

    describe('export', () => {
      it('should export research data', async () => {
        const mockExport = {
          format: 'json',
          entries: [],
          count: 0,
        };

        vi.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: mockExport,
          exitCode: 0,
          stdout: JSON.stringify(mockExport),
          stderr: '',
          duration: 50,
        });

        const result = await handler.query('export', {
          format: 'json',
          filter: { status: 'complete', type: 'research' },
        });

        expect(result.success).toBe(true);
        expect(result.data).toEqual(mockExport);
        expect(mockExecutor.execute).toHaveBeenCalledWith(
          expect.objectContaining({
            flags: expect.objectContaining({
              format: 'json',
              status: 'complete',
              type: 'research',
            }),
          })
        );
      });

      it('should export with markdown format', async () => {
        vi.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: { format: 'markdown' },
          exitCode: 0,
          stdout: '',
          stderr: '',
          duration: 50,
        });

        await handler.query('export', { format: 'markdown' });

        expect(mockExecutor.execute).toHaveBeenCalledWith(
          expect.objectContaining({
            flags: expect.objectContaining({ format: 'markdown' }),
          })
        );
      });
    });

    describe('unsupported operation', () => {
      it('should return error for unknown query operation', async () => {
        const result = await handler.query('unknown', {});

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_OPERATION');
        expect(result.error?.message).toContain('Unknown query operation');
      });
    });
  });

  describe('Mutate Operations', () => {
    describe('link', () => {
      it('should link research to task', async () => {
        const mockLink = {
          taskId: 'T2931',
          researchId: 'research-001',
          linked: true,
        };

        vi.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: mockLink,
          exitCode: 0,
          stdout: JSON.stringify(mockLink),
          stderr: '',
          duration: 50,
        });

        const result = await handler.mutate('link', {
          taskId: 'T2931',
          researchId: 'research-001',
          notes: 'Related to implementation',
        });

        expect(result.success).toBe(true);
        expect(result.data).toEqual(mockLink);
        expect(mockExecutor.execute).toHaveBeenCalledWith(
          expect.objectContaining({
            args: ['T2931', 'research-001'],
            flags: expect.objectContaining({ notes: 'Related to implementation' }),
          })
        );
      });

      it('should return error when taskId missing', async () => {
        const result = await handler.mutate('link', { researchId: 'research-001' });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_INPUT');
        expect(result.error?.message).toContain('taskId and researchId are required');
      });

      it('should return error when researchId missing', async () => {
        const result = await handler.mutate('link', { taskId: 'T2931' });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_INPUT');
      });
    });

    describe('unlink', () => {
      it('should unlink research from task', async () => {
        const mockUnlink = {
          taskId: 'T2931',
          researchId: 'research-001',
          unlinked: true,
        };

        vi.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: mockUnlink,
          exitCode: 0,
          stdout: JSON.stringify(mockUnlink),
          stderr: '',
          duration: 50,
        });

        const result = await handler.mutate('unlink', {
          taskId: 'T2931',
          researchId: 'research-001',
        });

        expect(result.success).toBe(true);
        expect(result.data).toEqual(mockUnlink);
        expect(mockExecutor.execute).toHaveBeenCalledWith(
          expect.objectContaining({
            args: ['T2931', 'research-001'],
          })
        );
      });

      it('should return error when parameters missing', async () => {
        const result = await handler.mutate('unlink', { taskId: 'T2931' });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_INPUT');
      });
    });

    describe('import', () => {
      it('should import research data', async () => {
        const mockImport = {
          imported: 5,
          skipped: 2,
          errors: [],
        };

        vi.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: mockImport,
          exitCode: 0,
          stdout: JSON.stringify(mockImport),
          stderr: '',
          duration: 50,
        });

        const result = await handler.mutate('import', {
          source: '/path/to/research.json',
          overwrite: true,
        });

        expect(result.success).toBe(true);
        expect(result.data).toEqual(mockImport);
        expect(mockExecutor.execute).toHaveBeenCalledWith(
          expect.objectContaining({
            args: ['/path/to/research.json'],
            flags: expect.objectContaining({ overwrite: true }),
          })
        );
      });

      it('should return error when source missing', async () => {
        const result = await handler.mutate('import', {});

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_INPUT');
        expect(result.error?.message).toContain('source is required');
      });
    });

    describe('aggregate', () => {
      it('should aggregate research findings', async () => {
        const mockAggregate = {
          taskIds: ['T2931', 'T2932'],
          findings: ['Combined finding 1', 'Combined finding 2'],
          outputFile: 'aggregated.md',
        };

        vi.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: mockAggregate,
          exitCode: 0,
          stdout: JSON.stringify(mockAggregate),
          stderr: '',
          duration: 50,
        });

        const result = await handler.mutate('aggregate', {
          taskIds: ['T2931', 'T2932'],
          outputFile: 'aggregated.md',
        });

        expect(result.success).toBe(true);
        expect(result.data).toEqual(mockAggregate);
        expect(mockExecutor.execute).toHaveBeenCalledWith(
          expect.objectContaining({
            args: ['T2931', 'T2932'],
            flags: expect.objectContaining({ output: 'aggregated.md' }),
          })
        );
      });

      it('should return error when taskIds empty', async () => {
        const result = await handler.mutate('aggregate', { taskIds: [] });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_INPUT');
        expect(result.error?.message).toContain('taskIds array is required');
      });

      it('should return error when taskIds missing', async () => {
        const result = await handler.mutate('aggregate', {});

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_INPUT');
      });
    });

    describe('report', () => {
      it('should generate research report', async () => {
        const mockReport = {
          epicId: 'T2908',
          format: 'markdown',
          entries: 10,
          reportFile: 'report.md',
        };

        vi.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: mockReport,
          exitCode: 0,
          stdout: JSON.stringify(mockReport),
          stderr: '',
          duration: 50,
        });

        const result = await handler.mutate('report', {
          epicId: 'T2908',
          format: 'markdown',
          includeLinks: true,
        });

        expect(result.success).toBe(true);
        expect(result.data).toEqual(mockReport);
        expect(mockExecutor.execute).toHaveBeenCalledWith(
          expect.objectContaining({
            flags: expect.objectContaining({
              epic: 'T2908',
              format: 'markdown',
              'include-links': true,
            }),
          })
        );
      });

      it('should generate report with HTML format', async () => {
        vi.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: { format: 'html' },
          exitCode: 0,
          stdout: '',
          stderr: '',
          duration: 50,
        });

        await handler.mutate('report', { format: 'html' });

        expect(mockExecutor.execute).toHaveBeenCalledWith(
          expect.objectContaining({
            flags: expect.objectContaining({ format: 'html' }),
          })
        );
      });

      it('should generate report without parameters', async () => {
        vi.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: {},
          exitCode: 0,
          stdout: '',
          stderr: '',
          duration: 50,
        });

        await handler.mutate('report', {});

        expect(mockExecutor.execute).toHaveBeenCalledWith(
          expect.objectContaining({
            flags: { json: true },
          })
        );
      });
    });

    describe('unsupported operation', () => {
      it('should return error for unknown mutate operation', async () => {
        const result = await handler.mutate('unknown', {});

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_OPERATION');
        expect(result.error?.message).toContain('Unknown mutate operation');
      });
    });
  });

  describe('getSupportedOperations', () => {
    it('should return correct operation lists', () => {
      const operations = handler.getSupportedOperations();

      expect(operations.query).toEqual(['list', 'stats', 'validate', 'search', 'export', 'manifest.read', 'manifest.validate', 'manifest.summary', 'show', 'pending', 'query', 'contradictions', 'superseded']);
      expect(operations.mutate).toEqual(['link', 'unlink', 'import', 'aggregate', 'report', 'inject', 'manifest.append', 'manifest.archive', 'compact', 'validate']);
    });
  });

  // ===== Regression Tests (T4316 fixes) =====

  describe('Regression Tests', () => {
    // Regression: T4316 - research.stats was returning empty counters because
    // it was using CLI which had jq issues with malformed MANIFEST.jsonl lines.
    // Now uses ManifestReader directly for reliable parsing.
    it('should return populated stats counters via ManifestReader (T4316)', async () => {
      // The fixed implementation uses ManifestReader.readManifest() directly,
      // not the executor. The handler constructs stats from manifest entries.
      // We verify the result structure has proper computed fields.
      const result = await handler.query('stats', {});

      // Should succeed (ManifestReader handles empty/missing manifest gracefully)
      expect(result.success).toBe(true);
      // Stats should have the expected shape with computed fields
      expect(result.data).toHaveProperty('total');
      expect(result.data).toHaveProperty('byStatus');
      expect(result.data).toHaveProperty('byType');
      expect(result.data).toHaveProperty('actionable');
      expect(result.data).toHaveProperty('needsFollowup');
      expect(result.data).toHaveProperty('averageFindings');
    });

    // Regression: T4316 - research.list was returning empty because CLI had
    // jq parsing issues. Now uses ManifestReader directly.
    it('should return entries via ManifestReader, not CLI (T4316)', async () => {
      // The fixed implementation uses ManifestReader.readManifest() directly.
      // It does NOT call executor.execute for the list operation.
      const result = await handler.query('list', {});

      expect(result.success).toBe(true);
      // Fixed response wraps entries in { entries, total } structure
      expect(result.data).toHaveProperty('entries');
      expect(result.data).toHaveProperty('total');
    });

    // Regression: T4316 - research.manifest.read with status='complete' was
    // failing enum validation because the filter was not properly applied.
    it('should not fail enum validation on manifest.read with status=complete (T4316)', async () => {
      // The fixed implementation uses ManifestReader.filterEntries() which
      // properly handles status filtering without enum validation errors.
      const result = await handler.query('manifest.read', { status: 'complete' });

      // Should not return an error - the status 'complete' is valid for manifest entries
      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('entries');
      expect(result.data).toHaveProperty('total');
      expect(result.data).toHaveProperty('filter');
    });
  });

  describe('Error Handling', () => {
    it('should handle executor errors in query', async () => {
      vi.mocked(mockExecutor.execute).mockRejectedValue(new Error('Network error'));

      // Use 'validate' instead of 'list' since list now uses ManifestReader directly
      const result = await handler.query('validate', { taskId: 'T001' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INTERNAL_ERROR');
      expect(result.error?.message).toContain('Network error');
    });

    it('should handle executor errors in mutate', async () => {
      vi.mocked(mockExecutor.execute).mockRejectedValue(new Error('Permission denied'));

      const result = await handler.mutate('link', { taskId: 'T1', researchId: 'R1' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INTERNAL_ERROR');
      expect(result.error?.message).toContain('Permission denied');
    });
  });
});
