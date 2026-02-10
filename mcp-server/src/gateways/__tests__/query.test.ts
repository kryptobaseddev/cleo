/**
 * Tests for cleo_query gateway
 *
 * Validates:
 * - All 56 query operations across 7 domains
 * - Parameter validation
 * - Error handling
 * - Read-only enforcement
 *
 * @task T2915
 */

import { describe, it, expect } from '@jest/globals';
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
    it('should have exactly 56 query operations', () => {
      const total = getQueryOperationCount();
      expect(total).toBe(56);
    });

    it('should have 7 query domains', () => {
      const domains = getQueryDomains();
      expect(domains).toHaveLength(7);
      expect(domains).toEqual([
        'tasks',
        'session',
        'orchestrate',
        'research',
        'lifecycle',
        'validate',
        'system',
      ]);
    });

    it('should not include release domain (mutate-only)', () => {
      const domains = getQueryDomains();
      expect(domains).not.toContain('release');
    });
  });

  describe('Domain Operation Counts', () => {
    it('tasks domain should have 10 operations', () => {
      expect(getQueryOperationCount('tasks')).toBe(10);
    });

    it('session domain should have 5 operations', () => {
      expect(getQueryOperationCount('session')).toBe(5);
    });

    it('orchestrate domain should have 7 operations', () => {
      expect(getQueryOperationCount('orchestrate')).toBe(7);
    });

    it('research domain should have 6 operations', () => {
      expect(getQueryOperationCount('research')).toBe(6);
    });

    it('lifecycle domain should have 5 operations', () => {
      expect(getQueryOperationCount('lifecycle')).toBe(5);
    });

    it('validate domain should have 9 operations', () => {
      expect(getQueryOperationCount('validate')).toBe(9);
    });

    it('system domain should have 14 operations', () => {
      expect(getQueryOperationCount('system')).toBe(14);
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
        operation: 'create', // Mutate operation, not query
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
      expect(enumValues).toHaveLength(7);
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
      expect(isQueryOperation('tasks', 'create')).toBe(false);
      expect(isQueryOperation('tasks', 'update')).toBe(false);
      expect(isQueryOperation('session', 'start')).toBe(false);
    });

    it('should return false for unknown operations', () => {
      expect(isQueryOperation('tasks', 'invalid')).toBe(false);
      expect(isQueryOperation('unknown', 'list')).toBe(false);
    });

    it('should return all operations for domain', () => {
      const tasksOps = getQueryOperations('tasks');
      expect(tasksOps).toHaveLength(10);
      expect(tasksOps).toContain('get');
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

    it('should support get operation', () => {
      expect(tasksOps).toContain('get');
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

    it('should support deps operation', () => {
      expect(tasksOps).toContain('deps');
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

    it('should support focus.get operation', () => {
      expect(sessionOps).toContain('focus.get');
    });

    it('should support history operation', () => {
      expect(sessionOps).toContain('history');
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

    it('should support skill.list operation', () => {
      expect(orchOps).toContain('skill.list');
    });
  });

  describe('Research Domain Operations', () => {
    const researchOps = QUERY_OPERATIONS.research;

    it('should support show operation', () => {
      expect(researchOps).toContain('show');
    });

    it('should support list operation', () => {
      expect(researchOps).toContain('list');
    });

    it('should support query operation', () => {
      expect(researchOps).toContain('query');
    });

    it('should support pending operation', () => {
      expect(researchOps).toContain('pending');
    });

    it('should support stats operation', () => {
      expect(researchOps).toContain('stats');
    });

    it('should support manifest.read operation', () => {
      expect(researchOps).toContain('manifest.read');
    });
  });

  describe('Lifecycle Domain Operations', () => {
    const lifecycleOps = QUERY_OPERATIONS.lifecycle;

    it('should support check operation', () => {
      expect(lifecycleOps).toContain('check');
    });

    it('should support status operation', () => {
      expect(lifecycleOps).toContain('status');
    });

    it('should support history operation', () => {
      expect(lifecycleOps).toContain('history');
    });

    it('should support gates operation', () => {
      expect(lifecycleOps).toContain('gates');
    });

    it('should support prerequisites operation', () => {
      expect(lifecycleOps).toContain('prerequisites');
    });
  });

  describe('Validate Domain Operations', () => {
    const validateOps = QUERY_OPERATIONS.validate;

    it('should support schema operation', () => {
      expect(validateOps).toContain('schema');
    });

    it('should support protocol operation', () => {
      expect(validateOps).toContain('protocol');
    });

    it('should support task operation', () => {
      expect(validateOps).toContain('task');
    });

    it('should support manifest operation', () => {
      expect(validateOps).toContain('manifest');
    });

    it('should support output operation', () => {
      expect(validateOps).toContain('output');
    });

    it('should support compliance.summary operation', () => {
      expect(validateOps).toContain('compliance.summary');
    });

    it('should support compliance.violations operation', () => {
      expect(validateOps).toContain('compliance.violations');
    });

    it('should support test.status operation', () => {
      expect(validateOps).toContain('test.status');
    });

    it('should support test.coverage operation', () => {
      expect(validateOps).toContain('test.coverage');
    });
  });

  describe('System Domain Operations', () => {
    const systemOps = QUERY_OPERATIONS.system;

    it('should support version operation', () => {
      expect(systemOps).toContain('version');
    });

    it('should support doctor operation', () => {
      expect(systemOps).toContain('doctor');
    });

    it('should support config.get operation', () => {
      expect(systemOps).toContain('config.get');
    });

    it('should support stats operation', () => {
      expect(systemOps).toContain('stats');
    });

    it('should support context operation', () => {
      expect(systemOps).toContain('context');
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
