/**
 * Research Domain Handler Tests
 *
 * Tests all 10 research operations with proper mocking of CLIExecutor.
 *
 * @task T2931
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { ResearchHandler } from '../research.js';
import { CLIExecutor } from '../../lib/executor.js';
import { createMockExecutor } from '../../__tests__/utils.js';

// Mock CLIExecutor
jest.mock('../../lib/executor.js');

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
      it('should list research entries', async () => {
        const mockEntries: ResearchEntry[] = [
          {
            id: 'T2931-research',
            file: 'research_2931.md',
            title: 'Research on MCP',
            date: '2026-02-03',
            status: 'complete',
            agent_type: 'research',
            topics: ['mcp', 'server', 'typescript'],
            key_findings: ['Finding 1', 'Finding 2'],
            actionable: true,
            linked_tasks: ['T2908'],
          },
        ];

        jest.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: mockEntries,
          exitCode: 0,
          stdout: JSON.stringify(mockEntries),
          stderr: '',
          duration: 50,
        });

        const result = await handler.query('list', { taskId: 'T2908', limit: 10 });

        expect(result.success).toBe(true);
        expect(result.data).toEqual(mockEntries);
        expect(result._meta.operation).toBe('list');
        expect(mockExecutor.execute).toHaveBeenCalledWith(
          expect.objectContaining({
            domain: 'research',
            operation: 'list',
            flags: expect.objectContaining({ task: 'T2908', limit: 10 }),
          })
        );
      });

      it('should list with filters', async () => {
        jest.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: [],
          exitCode: 0,
          stdout: '[]',
          stderr: '',
          duration: 50,
        });

        await handler.query('list', {
          status: 'complete',
          type: 'research',
          topic: 'mcp',
          actionable: true,
        });

        expect(mockExecutor.execute).toHaveBeenCalledWith(
          expect.objectContaining({
            flags: expect.objectContaining({
              status: 'complete',
              type: 'research',
              topic: 'mcp',
              actionable: true,
            }),
          })
        );
      });
    });

    describe('stats', () => {
      it('should get research statistics', async () => {
        const mockStats: ResearchStats = {
          total: 10,
          byStatus: { complete: 8, partial: 2 },
          byType: { research: 5, implementation: 5 },
          actionable: 8,
          needsFollowup: 2,
          averageFindings: 4.5,
        };

        jest.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: mockStats,
          exitCode: 0,
          stdout: JSON.stringify(mockStats),
          stderr: '',
          duration: 50,
        });

        const result = await handler.query('stats', { epicId: 'T2908' });

        expect(result.success).toBe(true);
        expect(result.data).toEqual(mockStats);
        expect(mockExecutor.execute).toHaveBeenCalledWith(
          expect.objectContaining({
            domain: 'research',
            operation: 'stats',
            flags: expect.objectContaining({ epic: 'T2908' }),
          })
        );
      });

      it('should get stats without epic filter', async () => {
        jest.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: { total: 0 },
          exitCode: 0,
          stdout: '{}',
          stderr: '',
          duration: 50,
        });

        await handler.query('stats', {});

        expect(mockExecutor.execute).toHaveBeenCalledWith(
          expect.objectContaining({
            flags: { json: true },
          })
        );
      });
    });

    describe('validate', () => {
      it('should validate research links', async () => {
        const mockValidation = {
          valid: true,
          taskId: 'T2931',
          linkedResearch: ['research-001', 'research-002'],
        };

        jest.mocked(mockExecutor.execute).mockResolvedValue({
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

        jest.mocked(mockExecutor.execute).mockResolvedValue({
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

        jest.mocked(mockExecutor.execute).mockResolvedValue({
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
        jest.mocked(mockExecutor.execute).mockResolvedValue({
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

        jest.mocked(mockExecutor.execute).mockResolvedValue({
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

        jest.mocked(mockExecutor.execute).mockResolvedValue({
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

        jest.mocked(mockExecutor.execute).mockResolvedValue({
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

        jest.mocked(mockExecutor.execute).mockResolvedValue({
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

        jest.mocked(mockExecutor.execute).mockResolvedValue({
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
        jest.mocked(mockExecutor.execute).mockResolvedValue({
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
        jest.mocked(mockExecutor.execute).mockResolvedValue({
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

      expect(operations.query).toEqual(['list', 'stats', 'validate', 'search', 'export', 'manifest.read', 'manifest.validate', 'manifest.summary', 'show', 'pending', 'query']);
      expect(operations.mutate).toEqual(['link', 'unlink', 'import', 'aggregate', 'report', 'inject', 'manifest.append', 'manifest.archive']);
    });
  });

  describe('Error Handling', () => {
    it('should handle executor errors in query', async () => {
      jest.mocked(mockExecutor.execute).mockRejectedValue(new Error('Network error'));

      const result = await handler.query('list', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INTERNAL_ERROR');
      expect(result.error?.message).toContain('Network error');
    });

    it('should handle executor errors in mutate', async () => {
      jest.mocked(mockExecutor.execute).mockRejectedValue(new Error('Permission denied'));

      const result = await handler.mutate('link', { taskId: 'T1', researchId: 'R1' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INTERNAL_ERROR');
      expect(result.error?.message).toContain('Permission denied');
    });
  });
});
