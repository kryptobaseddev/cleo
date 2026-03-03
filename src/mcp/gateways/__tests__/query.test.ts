/**
 * Tests for cleo_query gateway
 *
 * Validates:
 * - Query operations across all domains (canonical + legacy)
 * - Parameter validation
 * - Error handling
 * - Read-only enforcement
 *
 * @task T2915
 */

import { describe, it, expect } from 'vitest';
import {
  validateQueryParams,
  registerQueryTool,
  getQueryOperationCount,
  isQueryOperation,
  getQueryDomains,
  getQueryOperations,
  QUERY_OPERATIONS,
  type QueryRequest,
} from '../query.js';

describe('Query Gateway', () => {
  describe('Operation Matrix', () => {
    it('should derive query operation total dynamically from registry', () => {
      const total = getQueryOperationCount();
      expect(total).toBe(Object.values(QUERY_OPERATIONS).flat().length);
      expect(total).toBeGreaterThan(0);
    });

    it('should have 10 canonical query domains', () => {
      const domains = getQueryDomains();
      expect(domains).toHaveLength(10);
      // Derived from registry — order follows OPERATIONS definition order
      expect(domains).toEqual([
        // Canonical domains (order from OPERATIONS array)
        'tasks',
        'session',
        'orchestrate',
        'memory',
        'pipeline',
        'check',
        'admin',
        'tools',
        'sharing',
        'nexus',
      ]);
    });

    it('should not include release domain (mutate-only)', () => {
      const domains = getQueryDomains();
      expect(domains).not.toContain('release');
    });
  });

  describe('Domain Operation Counts', () => {
    it('tasks domain should have 15 operations', () => {
      expect(getQueryOperationCount('tasks')).toBe(15);
    });

    it('session domain should have 11 query operations', () => {
      expect(getQueryOperationCount('session')).toBe(11);
    });

    it('orchestrate domain should have 9 operations', () => {
      expect(getQueryOperationCount('orchestrate')).toBe(9);
    });

    it('memory domain should have 12 operations', () => {
      expect(getQueryOperationCount('memory')).toBe(12);
    });

    it('pipeline domain should have 10 operations', () => {
      expect(getQueryOperationCount('pipeline')).toBe(10);
    });

    it('check domain should have 10 operations', () => {
      expect(getQueryOperationCount('check')).toBe(10);
    });

    it('admin domain should have 20 operations', () => {
      expect(getQueryOperationCount('admin')).toBe(20);
    });
  });

  describe('Parameter Validation', () => {
    it('should accept valid tasks query', () => {
      const request: QueryRequest = {
        domain: 'tasks',
        operation: 'list',
        params: { status: 'pending' },
      };
      const result = validateQueryParams(request);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should reject invalid domain', () => {
      const request = {
        domain: 'invalid' as any,
        operation: 'list',
      };
      const result = validateQueryParams(request);
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.error?.code).toBe('E_INVALID_DOMAIN');
      expect(result.error?.error?.exitCode).toBe(2);
    });

    it('should reject invalid operation for valid domain', () => {
      const request: QueryRequest = {
        domain: 'tasks',
        operation: 'add', // Mutate operation, not query
      };
      const result = validateQueryParams(request);
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.error?.code).toBe('E_INVALID_OPERATION');
    });

    it('should reject release domain (mutate-only)', () => {
      const request = {
        domain: 'release' as any,
        operation: 'version',
      };
      const result = validateQueryParams(request);
      expect(result.valid).toBe(false);
      expect(result.error?.error?.code).toBe('E_INVALID_DOMAIN');
    });

    it('should provide fix suggestions on error', () => {
      const request = {
        domain: 'invalid' as any,
        operation: 'list',
      };
      const result = validateQueryParams(request);
      expect(result.error?.error?.fix).toBeDefined();
      expect(result.error?.error?.alternatives).toBeDefined();
      expect(result.error?.error?.alternatives?.length).toBeGreaterThan(0);
    });
  });

  describe('Tool Registration', () => {
    it('should return valid MCP tool definition', () => {
      const tool = registerQueryTool();
      expect(tool.name).toBe('cleo_query');
      expect(tool.description).toContain('read operations');
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.required).toContain('domain');
      expect(tool.inputSchema.required).toContain('operation');
    });

    it('should have all query domains in enum', () => {
      const tool = registerQueryTool();
      const enumValues = tool.inputSchema.properties.domain.enum;
      expect(enumValues).toEqual(getQueryDomains());
    });

    it('should mark params as optional', () => {
      const tool = registerQueryTool();
      expect(tool.inputSchema.required).not.toContain('params');
    });
  });

  describe('Operation Lookup', () => {
    it('should correctly identify query operations', () => {
      expect(isQueryOperation('tasks', 'list')).toBe(true);
      expect(isQueryOperation('tasks', 'find')).toBe(true);
      expect(isQueryOperation('session', 'status')).toBe(true);
    });

    it('should reject mutate operations', () => {
      expect(isQueryOperation('tasks', 'add')).toBe(false);
      expect(isQueryOperation('tasks', 'update')).toBe(false);
      expect(isQueryOperation('session', 'start')).toBe(false);
    });

    it('should return false for unknown operations', () => {
      expect(isQueryOperation('tasks', 'invalid')).toBe(false);
      expect(isQueryOperation('unknown', 'list')).toBe(false);
    });

    it('should return all operations for domain', () => {
      const tasksOps = getQueryOperations('tasks');
      expect(tasksOps).toHaveLength(15);
      expect(tasksOps).toContain('show');
      expect(tasksOps).toContain('list');
      expect(tasksOps).toContain('find');
      expect(tasksOps).toContain('relates');
    });

    it('should return empty array for unknown domain', () => {
      const ops = getQueryOperations('unknown');
      expect(ops).toEqual([]);
    });
  });

  describe('Tasks Domain Operations', () => {
    const tasksOps = QUERY_OPERATIONS.tasks;

    it('should support show operation', () => {
      expect(tasksOps).toContain('show');
    });

    it('should support list operation', () => {
      expect(tasksOps).toContain('list');
    });

    it('should support find operation', () => {
      expect(tasksOps).toContain('find');
    });

    it('should support exists operation', () => {
      expect(tasksOps).toContain('exists');
    });

    it('should support tree operation', () => {
      expect(tasksOps).toContain('tree');
    });

    it('should support blockers operation', () => {
      expect(tasksOps).toContain('blockers');
    });

    it('should support depends operation', () => {
      expect(tasksOps).toContain('depends');
    });

    it('should support analyze operation', () => {
      expect(tasksOps).toContain('analyze');
    });

    it('should support next operation', () => {
      expect(tasksOps).toContain('next');
    });
  });

  describe('Session Domain Operations', () => {
    const sessionOps = QUERY_OPERATIONS.session;

    it('should support status operation', () => {
      expect(sessionOps).toContain('status');
    });

    it('should support list operation', () => {
      expect(sessionOps).toContain('list');
    });

    it('should support show operation', () => {
      expect(sessionOps).toContain('show');
    });

    it('should support history operation', () => {
      expect(sessionOps).toContain('history');
    });

    it('should support briefing.show operation', () => {
      expect(sessionOps).toContain('briefing.show');
    });
  });

  describe('Orchestrate Domain Operations', () => {
    const orchOps = QUERY_OPERATIONS.orchestrate;

    it('should support status operation', () => {
      expect(orchOps).toContain('status');
    });

    it('should support next operation', () => {
      expect(orchOps).toContain('next');
    });

    it('should support ready operation', () => {
      expect(orchOps).toContain('ready');
    });

    it('should support analyze operation', () => {
      expect(orchOps).toContain('analyze');
    });

    it('should support context operation', () => {
      expect(orchOps).toContain('context');
    });

    it('should support waves operation', () => {
      expect(orchOps).toContain('waves');
    });

  });

  describe('Memory Domain Operations', () => {
    const memoryOps = QUERY_OPERATIONS.memory;

    it('should support show operation', () => {
      expect(memoryOps).toContain('show');
    });

    it('should support find operation (brain.db search)', () => {
      expect(memoryOps).toContain('find');
    });

    it('should support timeline operation (brain.db context)', () => {
      expect(memoryOps).toContain('timeline');
    });

    it('should support fetch operation (brain.db batch fetch)', () => {
      expect(memoryOps).toContain('fetch');
    });

    it('should support stats operation', () => {
      expect(memoryOps).toContain('stats');
    });

    it('should support decision.find operation', () => {
      expect(memoryOps).toContain('decision.find');
    });

    it('should not contain manifest.read (moved to pipeline)', () => {
      expect(memoryOps).not.toContain('manifest.read');
    });
  });

  describe('Pipeline Domain Operations', () => {
    const pipelineOps = QUERY_OPERATIONS.pipeline;

    it('should support stage.validate operation', () => {
      expect(pipelineOps).toContain('stage.validate');
    });

    it('should support stage.status operation', () => {
      expect(pipelineOps).toContain('stage.status');
    });

    it('should support stage.history operation', () => {
      expect(pipelineOps).toContain('stage.history');
    });

    it('should support stage.gates operation', () => {
      expect(pipelineOps).toContain('stage.gates');
    });

    it('should support stage.prerequisites operation', () => {
      expect(pipelineOps).toContain('stage.prerequisites');
    });

    it('should support manifest.show operation', () => {
      expect(pipelineOps).toContain('manifest.show');
    });

    it('should support manifest.list operation', () => {
      expect(pipelineOps).toContain('manifest.list');
    });

    it('should support manifest.find operation', () => {
      expect(pipelineOps).toContain('manifest.find');
    });

    it('should support manifest.pending operation', () => {
      expect(pipelineOps).toContain('manifest.pending');
    });

    it('should support manifest.stats operation', () => {
      expect(pipelineOps).toContain('manifest.stats');
    });
  });

  describe('Check Domain Operations', () => {
    const checkOps = QUERY_OPERATIONS.check;

    it('should support schema operation', () => {
      expect(checkOps).toContain('schema');
    });

    it('should support protocol operation', () => {
      expect(checkOps).toContain('protocol');
    });

    it('should support task operation', () => {
      expect(checkOps).toContain('task');
    });

    it('should support manifest operation', () => {
      expect(checkOps).toContain('manifest');
    });

    it('should support output operation', () => {
      expect(checkOps).toContain('output');
    });

    it('should support compliance.summary operation', () => {
      expect(checkOps).toContain('compliance.summary');
    });

    it('should support compliance.violations operation', () => {
      expect(checkOps).toContain('compliance.violations');
    });

    it('should support test.status operation', () => {
      expect(checkOps).toContain('test.status');
    });

    it('should support test.coverage operation', () => {
      expect(checkOps).toContain('test.coverage');
    });

    it('should support coherence.check operation', () => {
      expect(checkOps).toContain('coherence.check');
    });
  });

  describe('Admin Domain Operations', () => {
    const adminOps = QUERY_OPERATIONS.admin;

    it('should support version operation', () => {
      expect(adminOps).toContain('version');
    });

    it('should support health operation', () => {
      expect(adminOps).toContain('health');
    });

    it('should support config.show operation', () => {
      expect(adminOps).toContain('config.show');
    });

    it('should support config.get alias', () => {
      expect(adminOps).toContain('config.get');
    });

    it('should support stats operation', () => {
      expect(adminOps).toContain('stats');
    });

    it('should support context operation', () => {
      expect(adminOps).toContain('context');
    });

    it('should support runtime operation', () => {
      expect(adminOps).toContain('runtime');
    });

    it('should support job.status operation', () => {
      expect(adminOps).toContain('job.status');
    });

    it('should support job.list operation', () => {
      expect(adminOps).toContain('job.list');
    });

    it('should support dash operation', () => {
      expect(adminOps).toContain('dash');
    });

    it('should support log operation', () => {
      expect(adminOps).toContain('log');
    });

    it('should support sequence operation', () => {
      expect(adminOps).toContain('sequence');
    });

    it('should support help operation', () => {
      expect(adminOps).toContain('help');
    });

    it('should support grade operation', () => {
      expect(adminOps).toContain('grade');
    });

    it('should support grade.list operation', () => {
      expect(adminOps).toContain('grade.list');
    });

    it('should support archive.stats operation', () => {
      expect(adminOps).toContain('archive.stats');
    });
  });

  describe('Error Response Format', () => {
    it('should include _meta in error response', () => {
      const request = {
        domain: 'invalid' as any,
        operation: 'list',
      };
      const result = validateQueryParams(request);
      expect(result.error?._meta).toBeDefined();
      expect(result.error?._meta.gateway).toBe('cleo_query');
      expect(result.error?._meta.domain).toBe('invalid');
      expect(result.error?._meta.operation).toBe('list');
      expect(result.error?._meta.version).toBeDefined();
      expect(result.error?._meta.timestamp).toBeDefined();
    });

    it('should include error details', () => {
      const request: QueryRequest = {
        domain: 'tasks',
        operation: 'invalid',
      };
      const result = validateQueryParams(request);
      expect(result.error?.error).toBeDefined();
      expect(result.error?.error?.code).toBeDefined();
      expect(result.error?.error?.exitCode).toBe(2);
      expect(result.error?.error?.message).toBeDefined();
    });
  });
});
