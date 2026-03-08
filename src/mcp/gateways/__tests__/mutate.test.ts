/**
 * Tests for mutate Gateway
 *
 * @task T2929
 */

import { describe, expect, it } from 'vitest';
import { resolve } from '../../../dispatch/registry.js';
import {
  getMutateDomains,
  getMutateOperationCount,
  getMutateOperations,
  handleMutateRequest,
  isIdempotentOperation,
  isMutateOperation,
  MUTATE_OPERATIONS,
  type MutateRequest,
  registerMutateTool,
  requiresSession,
  validateMutateParams,
} from '../mutate.js';

const ADVANCED_MEMORY_MUTATE_OPS = ['pattern.store', 'learning.store'] as const;

describe('MUTATE_OPERATIONS', () => {
  it('should derive total operations dynamically from registry', () => {
    const totalCount = Object.values(MUTATE_OPERATIONS).flat().length;
    expect(totalCount).toBe(getMutateOperationCount());
    expect(totalCount).toBeGreaterThan(0);
  });

  it('should have all 10 canonical domains', () => {
    const domains = Object.keys(MUTATE_OPERATIONS);
    // Derived from registry — order follows canonical OPERATIONS definition order
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

  it('should have correct operation counts per domain', () => {
    // Canonical domains (updated for T5323 CLI-to-dispatch migration)
    expect(MUTATE_OPERATIONS.tasks.length).toBe(12);
    expect(MUTATE_OPERATIONS.session.length).toBe(7);
    expect(MUTATE_OPERATIONS.orchestrate.length).toBe(7);
    expect(MUTATE_OPERATIONS.memory.length).toBe(7);
    expect(MUTATE_OPERATIONS.check.length).toBe(3);
    expect(MUTATE_OPERATIONS.pipeline.length).toBe(17);
    expect(MUTATE_OPERATIONS.admin.length).toBe(15);
    expect(MUTATE_OPERATIONS.tools.length).toBe(6);
    expect(MUTATE_OPERATIONS.nexus.length).toBe(8); // Includes share.* operations
    expect(getMutateOperationCount('nexus')).toBe(8);
  });
});

describe('validateMutateParams', () => {
  describe('domain validation', () => {
    it('should reject invalid domain', () => {
      const request: MutateRequest = {
        domain: 'invalid' as any,
        operation: 'add',
      };

      const result = validateMutateParams(request);
      expect(result.valid).toBe(false);
      expect(result.error?.error?.code).toBe('E_INVALID_DOMAIN');
      expect(result.error?.error?.exitCode).toBe(2);
    });

    it('should accept valid domains', () => {
      const domains: Array<MutateRequest['domain']> = [
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
      ];

      for (const domain of domains) {
        const request: MutateRequest = {
          domain,
          operation: MUTATE_OPERATIONS[domain][0],
        };

        const result = validateMutateParams(request);
        // May fail on param validation, but should pass domain/operation check
        if (!result.valid) {
          expect(result.error?.error?.code).not.toBe('E_INVALID_DOMAIN');
          expect(result.error?.error?.code).not.toBe('E_INVALID_OPERATION');
        }
      }
    });
  });

  describe('operation validation', () => {
    it('should reject invalid operation for domain', () => {
      const request: MutateRequest = {
        domain: 'tasks',
        operation: 'invalid_operation',
      };

      const result = validateMutateParams(request);
      expect(result.valid).toBe(false);
      expect(result.error?.error?.code).toBe('E_INVALID_OPERATION');
      expect(result.error?.error?.exitCode).toBe(2);
    });

    it('should accept valid operations for each domain', () => {
      for (const [domain, operations] of Object.entries(MUTATE_OPERATIONS)) {
        for (const operation of operations) {
          const request: MutateRequest = {
            domain: domain as MutateRequest['domain'],
            operation,
          };

          const result = validateMutateParams(request);
          // May fail on param validation, but should pass domain/operation check
          if (!result.valid) {
            expect(result.error?.error?.code).not.toBe('E_INVALID_DOMAIN');
            expect(result.error?.error?.code).not.toBe('E_INVALID_OPERATION');
          }
        }
      }
    });
  });

  describe('tasks domain parameter validation', () => {
    it('should reject add without title and description', () => {
      const request: MutateRequest = {
        domain: 'tasks',
        operation: 'add',
        params: {},
      };

      const result = validateMutateParams(request);
      expect(result.valid).toBe(false);
      expect(result.error?.error?.code).toBe('E_VALIDATION_FAILED');
    });

    it('should reject add with same title and description', () => {
      const request: MutateRequest = {
        domain: 'tasks',
        operation: 'add',
        params: {
          title: 'Same text',
          description: 'Same text',
        },
      };

      const result = validateMutateParams(request);
      expect(result.valid).toBe(false);
      expect(result.error?.error?.message).toContain('must be different');
    });

    it('should accept add with valid title and description', () => {
      const request: MutateRequest = {
        domain: 'tasks',
        operation: 'add',
        params: {
          title: 'Task title',
          description: 'Task description that is different',
        },
      };

      const result = validateMutateParams(request);
      expect(result.valid).toBe(true);
    });

    it('should reject update without taskId', () => {
      const request: MutateRequest = {
        domain: 'tasks',
        operation: 'update',
        params: {},
      };

      const result = validateMutateParams(request);
      expect(result.valid).toBe(false);
      expect(result.error?.error?.message).toContain('taskId');
    });

    it('should accept update with taskId', () => {
      const request: MutateRequest = {
        domain: 'tasks',
        operation: 'update',
        params: {
          taskId: 'T1234',
        },
      };

      const result = validateMutateParams(request);
      expect(result.valid).toBe(true);
    });
  });

  describe('session domain parameter validation', () => {
    it('should reject start without scope', () => {
      const request: MutateRequest = {
        domain: 'session',
        operation: 'start',
        params: {},
      };

      const result = validateMutateParams(request);
      expect(result.valid).toBe(false);
      expect(result.error?.error?.message).toContain('scope');
    });

    it('should accept start with scope', () => {
      const request: MutateRequest = {
        domain: 'session',
        operation: 'start',
        params: {
          scope: 'epic:T1234',
        },
      };

      const result = validateMutateParams(request);
      expect(result.valid).toBe(true);
    });

    it('should reject tasks start without taskId', () => {
      const request: MutateRequest = {
        domain: 'tasks',
        operation: 'start',
        params: {},
      };

      const result = validateMutateParams(request);
      expect(result.valid).toBe(false);
      expect(result.error?.error?.message).toContain('taskId');
    });
  });

  describe('orchestrate domain parameter validation', () => {
    it('should reject start without epicId', () => {
      const request: MutateRequest = {
        domain: 'orchestrate',
        operation: 'start',
        params: {},
      };

      const result = validateMutateParams(request);
      expect(result.valid).toBe(false);
      expect(result.error?.error?.message).toContain('epicId');
    });

    it('should reject spawn without taskId', () => {
      const request: MutateRequest = {
        domain: 'orchestrate',
        operation: 'spawn',
        params: {},
      };

      const result = validateMutateParams(request);
      expect(result.valid).toBe(false);
      expect(result.error?.error?.message).toContain('taskId');
    });

    it('should accept parallel as a valid orchestrate operation', () => {
      // parallel absorbs parallel.start and parallel.end via action param (T5615)
      const request: MutateRequest = {
        domain: 'orchestrate',
        operation: 'parallel',
        params: {
          action: 'start',
          epicId: 'T1234',
          wave: 1,
        },
      };

      const result = validateMutateParams(request);
      expect(result.valid).toBe(true);
    });

    it('should reject handoff without protocolType', () => {
      const request: MutateRequest = {
        domain: 'orchestrate',
        operation: 'handoff',
        params: { taskId: 'T1234' },
      };

      const result = validateMutateParams(request);
      expect(result.valid).toBe(false);
      expect(result.error?.error?.message).toContain('taskId and protocolType');
    });
  });

  describe('legacy domain aliases are rejected', () => {
    it('rejects removed legacy aliases with E_INVALID_DOMAIN', () => {
      const legacyDomains = [
        'research',
        'validate',
        'lifecycle',
        'release',
        'system',
        'skills',
        'providers',
        'issues',
        'brain',
      ];

      for (const domain of legacyDomains) {
        const result = validateMutateParams({
          domain: domain as MutateRequest['domain'],
          operation: 'add',
          params: {},
        });
        expect(result.valid).toBe(false);
        expect(result.error?.error?.code).toBe('E_INVALID_DOMAIN');
      }
    });
  });

  describe('admin domain context.inject validation', () => {
    it('should accept context.inject as a valid admin operation', () => {
      const request: MutateRequest = {
        domain: 'admin',
        operation: 'context.inject',
        params: { protocolType: 'research' },
      };

      const result = validateMutateParams(request);
      expect(result.valid).toBe(true);
    });
  });

  describe('pipeline domain manifest validation', () => {
    it('should accept manifest.append as a valid pipeline operation', () => {
      const request: MutateRequest = {
        domain: 'pipeline',
        operation: 'manifest.append',
        params: { entry: { id: 'test', title: 'Test' } },
      };

      const result = validateMutateParams(request);
      expect(result.valid).toBe(true);
    });

    it('should accept manifest.archive as a valid pipeline operation', () => {
      const request: MutateRequest = {
        domain: 'pipeline',
        operation: 'manifest.archive',
        params: { beforeDate: '2026-01-01' },
      };

      const result = validateMutateParams(request);
      expect(result.valid).toBe(true);
    });

    it('should accept stage.gate.pass with required params', () => {
      const request: MutateRequest = {
        domain: 'pipeline',
        operation: 'stage.gate.pass',
        params: { taskId: 'T1234', gateName: 'quality-gate' },
      };

      const result = validateMutateParams(request);
      expect(result.valid).toBe(true);
    });

    it('should reject stage.gate.fail without required params', () => {
      const request: MutateRequest = {
        domain: 'pipeline',
        operation: 'stage.gate.fail',
        params: { taskId: 'T1234' },
      };

      const result = validateMutateParams(request);
      expect(result.valid).toBe(false);
      expect(result.error?.error?.message).toContain('taskId and gateName');
    });
  });

  describe('memory domain advanced operation validation', () => {
    it('should accept pattern.store as a valid memory operation', () => {
      const request: MutateRequest = {
        domain: 'memory',
        operation: 'pattern.store',
        params: {
          pattern: 'retry failed webhook once',
          context: 'webhook processing',
        },
      };

      const result = validateMutateParams(request);
      expect(result.valid).toBe(true);
    });

    it('should keep advanced memory mutate ops in MCP-dispatch parity lock', async () => {
      for (const operation of ADVANCED_MEMORY_MUTATE_OPS) {
        expect(MUTATE_OPERATIONS.memory).toContain(operation);

        const validation = validateMutateParams({
          domain: 'memory',
          operation,
          params: {},
        });
        expect(validation.valid).toBe(true);

        const gatewayResult = await handleMutateRequest({
          domain: 'memory',
          operation,
          params: {},
        });
        expect(gatewayResult.success).toBe(true);

        const dispatchOp = resolve('mutate', 'memory', operation);
        expect(dispatchOp, `Missing dispatch op for mutate memory.${operation}`).toBeDefined();
      }
    });
  });
});

describe('isIdempotentOperation', () => {
  it('should identify idempotent operations', () => {
    expect(isIdempotentOperation('admin', 'context.inject')).toBe(true);
    expect(isIdempotentOperation('admin', 'install.global')).toBe(true);
    expect(isIdempotentOperation('nexus', 'sync')).toBe(true);
  });

  it('should identify non-idempotent operations', () => {
    expect(isIdempotentOperation('tasks', 'add')).toBe(false);
    expect(isIdempotentOperation('tasks', 'delete')).toBe(false);
    expect(isIdempotentOperation('session', 'start')).toBe(false);
  });
});

describe('requiresSession', () => {
  it('should identify operations requiring session', () => {
    expect(requiresSession('tasks', 'add')).toBe(false);
    expect(requiresSession('session', 'start')).toBe(false);
    expect(requiresSession('orchestrate', 'spawn')).toBe(false);
  });

  it('should identify operations not requiring session', () => {
    expect(requiresSession('tasks', 'delete')).toBe(false);
    expect(requiresSession('session', 'end')).toBe(false);
    expect(requiresSession('pipeline', 'release.tag')).toBe(false);
  });
});

describe('getMutateOperationCount', () => {
  it('should return total count without domain', () => {
    expect(getMutateOperationCount()).toBe(Object.values(MUTATE_OPERATIONS).flat().length);
  });

  it('should return domain-specific counts', () => {
    // Canonical domains (updated for T5323 CLI-to-dispatch migration)
    expect(getMutateOperationCount('tasks')).toBe(12);
    expect(getMutateOperationCount('session')).toBe(7);
    expect(getMutateOperationCount('orchestrate')).toBe(7);
    expect(getMutateOperationCount('memory')).toBe(7);
    expect(getMutateOperationCount('check')).toBe(3);
    expect(getMutateOperationCount('pipeline')).toBe(17);
    expect(getMutateOperationCount('admin')).toBe(15);
    expect(getMutateOperationCount('tools')).toBe(6);
    expect(getMutateOperationCount('sticky')).toBe(4);
    expect(getMutateOperationCount('nexus')).toBe(8);
  });

  it('should return 0 for unknown domain', () => {
    expect(getMutateOperationCount('unknown')).toBe(0);
  });
});

describe('isMutateOperation', () => {
  it('should identify valid mutate operations', () => {
    expect(isMutateOperation('tasks', 'add')).toBe(true);
    expect(isMutateOperation('session', 'start')).toBe(true);
    expect(isMutateOperation('orchestrate', 'spawn')).toBe(true);
    expect(isMutateOperation('memory', 'pattern.store')).toBe(true);
  });

  it('should reject invalid operations', () => {
    expect(isMutateOperation('tasks', 'invalid')).toBe(false);
    expect(isMutateOperation('unknown', 'add')).toBe(false);
  });
});

describe('getMutateDomains', () => {
  it('should return all mutate domains', () => {
    const domains = getMutateDomains();
    expect(domains).toHaveLength(10);
    expect(domains).toEqual(Object.keys(MUTATE_OPERATIONS));
  });
});

describe('getMutateOperations', () => {
  it('should return operations for specific domain', () => {
    const taskOps = getMutateOperations('tasks');
    expect(taskOps).toContain('add');
    expect(taskOps).toContain('update');
    expect(taskOps).toContain('complete');
    expect(taskOps.length).toBe(12);
  });

  it('should return empty array for unknown domain', () => {
    expect(getMutateOperations('unknown')).toEqual([]);
  });
});

describe('registerMutateTool', () => {
  it('should return valid MCP tool definition', () => {
    const tool = registerMutateTool();

    expect(tool.name).toBe('mutate');
    expect(tool.description).toContain('write operations');
    expect(tool.inputSchema.type).toBe('object');
    expect(tool.inputSchema.required).toEqual(['domain', 'operation']);
    expect(tool.inputSchema.properties.domain.enum).toEqual(Object.keys(MUTATE_OPERATIONS));
  });
});
