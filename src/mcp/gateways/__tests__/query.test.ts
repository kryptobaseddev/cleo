/**
 * Tests for query gateway
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
  handleQueryRequest,
  registerQueryTool,
  getQueryOperationCount,
  isQueryOperation,
  getQueryDomains,
  getQueryOperations,
  QUERY_OPERATIONS,
  type QueryRequest,
} from '../query.js';
import { resolve } from '../../../dispatch/registry.js';

const ADVANCED_MEMORY_QUERY_OPS = [
  'pattern.find',
  'learning.find',
] as const;

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
        'nexus',
        'sticky',
      ]);
    });

    it('should not include release domain (mutate-only)', () => {
      const domains = getQueryDomains();
      expect(domains).not.toContain('release');
    });
  });

  describe('Domain Operation Counts', () => {
    it('tasks domain should have 14 operations', () => {
      expect(getQueryOperationCount('tasks')).toBe(14);
    });

    it('session domain should have 8 query operations', () => {
      expect(getQueryOperationCount('session')).toBe(8);
    });

    it('orchestrate domain should have 9 operations', () => {
      expect(getQueryOperationCount('orchestrate')).toBe(9);
    });

    it('memory domain should have 6 operations', () => {
      expect(getQueryOperationCount('memory')).toBe(6);
    });

    it('pipeline domain should have 14 operations', () => {
      expect(getQueryOperationCount('pipeline')).toBe(14);
    });

    it('check domain should have 13 operations', () => {
      expect(getQueryOperationCount('check')).toBe(13);
    });

    it('admin domain should have 15 operations', () => {
      expect(getQueryOperationCount('admin')).toBe(15);
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

    it('should accept memory pattern.find operation', () => {
      const request: QueryRequest = {
        domain: 'memory',
        operation: 'pattern.find',
        params: { query: 'retry' },
      };
      const result = validateQueryParams(request);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept check chain.validate for fork-join payload', () => {
      const request: QueryRequest = {
        domain: 'check',
        operation: 'chain.validate',
        params: {
          chain: {
            id: 'fork-join-chain',
            name: 'Fork Join Chain',
            version: '1.0.0',
            description: 'Fork-join chain fixture',
            shape: {
              stages: [
                { id: 'start', name: 'start', category: 'custom', skippable: false },
                { id: 'left', name: 'left', category: 'custom', skippable: false },
                { id: 'right', name: 'right', category: 'custom', skippable: false },
                { id: 'join', name: 'join', category: 'custom', skippable: false },
                { id: 'finish', name: 'finish', category: 'custom', skippable: false },
              ],
              links: [
                { from: 'start', to: 'left', type: 'fork' },
                { from: 'start', to: 'right', type: 'fork' },
                { from: 'left', to: 'join', type: 'linear' },
                { from: 'right', to: 'join', type: 'linear' },
                { from: 'join', to: 'finish', type: 'linear' },
              ],
              entryPoint: 'start',
              exitPoints: ['finish'],
            },
            gates: [],
          },
        },
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

    it('should reject all legacy domain aliases with E_INVALID_DOMAIN', () => {
      const legacyDomains = [
        'research', 'validate', 'lifecycle',
        'release', 'system', 'issues', 'skills', 'providers', 'brain',
      ];

      for (const domain of legacyDomains) {
        const result = validateQueryParams({
          domain: domain as any,
          operation: 'list',
        });
        expect(result.valid).toBe(false);
        expect(result.error?.error?.code).toBe('E_INVALID_DOMAIN');
      }
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
      expect(tool.name).toBe('query');
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
      expect(tasksOps).toHaveLength(14);
      expect(tasksOps).toContain('show');
      expect(tasksOps).toContain('list');
      expect(tasksOps).toContain('find');
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

    it('should support tessera.list operation', () => {
      expect(orchOps).toContain('tessera.list');
    });

  });

  describe('Memory Domain Operations', () => {
    const memoryOps = QUERY_OPERATIONS.memory;

    it('should support find operation (brain.db search)', () => {
      expect(memoryOps).toContain('find');
    });

    it('should support timeline operation (brain.db context)', () => {
      expect(memoryOps).toContain('timeline');
    });

    it('should support fetch operation (brain.db batch fetch)', () => {
      expect(memoryOps).toContain('fetch');
    });

    it('should support decision.find operation', () => {
      expect(memoryOps).toContain('decision.find');
    });

    it('should support pattern.find operation', () => {
      expect(memoryOps).toContain('pattern.find');
    });

    it('should support learning.find operation', () => {
      expect(memoryOps).toContain('learning.find');
    });

    it('should not contain manifest.read (moved to pipeline)', () => {
      expect(memoryOps).not.toContain('manifest.read');
    });

    it('should keep advanced memory query ops in MCP-dispatch parity lock', async () => {
      for (const operation of ADVANCED_MEMORY_QUERY_OPS) {
        expect(memoryOps).toContain(operation);

        const validation = validateQueryParams({
          domain: 'memory',
          operation,
        });
        expect(validation.valid).toBe(true);

        const gatewayResult = await handleQueryRequest({
          domain: 'memory',
          operation,
        });
        expect(gatewayResult.success).toBe(true);

        const dispatchOp = resolve('query', 'memory', operation);
        expect(dispatchOp, `Missing dispatch op for query memory.${operation}`).toBeDefined();
      }
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

    it('should support manifest.show operation', () => {
      expect(pipelineOps).toContain('manifest.show');
    });

    it('should support manifest.list operation', () => {
      expect(pipelineOps).toContain('manifest.list');
    });

    it('should support manifest.find operation', () => {
      expect(pipelineOps).toContain('manifest.find');
    });

    it('should support manifest.stats operation', () => {
      expect(pipelineOps).toContain('manifest.stats');
    });

    it('should support chain.list operation', () => {
      expect(pipelineOps).toContain('chain.list');
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

    it('should support test operation', () => {
      expect(checkOps).toContain('test');
    });

    it('should support coherence operation', () => {
      expect(checkOps).toContain('coherence');
    });

    it('should support gate.status operation', () => {
      expect(checkOps).toContain('gate.status');
    });

    it('should support archive.stats operation', () => {
      expect(checkOps).toContain('archive.stats');
    });

    it('should support grade operation', () => {
      expect(checkOps).toContain('grade');
    });

    it('should support grade.list operation', () => {
      expect(checkOps).toContain('grade.list');
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

    it('should support stats operation', () => {
      expect(adminOps).toContain('stats');
    });

    it('should support context operation', () => {
      expect(adminOps).toContain('context');
    });

    it('should support runtime operation', () => {
      expect(adminOps).toContain('runtime');
    });

    it('should support job operation', () => {
      expect(adminOps).toContain('job');
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

    it('should support token operation', () => {
      expect(adminOps).toContain('token');
    });

    it('should support adr.show operation', () => {
      expect(adminOps).toContain('adr.show');
    });

    it('should support adr.find operation', () => {
      expect(adminOps).toContain('adr.find');
    });

    it('should support export operation', () => {
      expect(adminOps).toContain('export');
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
      expect(result.error?._meta.gateway).toBe('query');
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
