/**
 * Tests for cleo_mutate Gateway
 *
 * @task T2929
 */

import { describe, it, expect } from '@jest/globals';
import {
  MUTATE_OPERATIONS,
  validateMutateParams,
  isIdempotentOperation,
  requiresSession,
  getMutateOperationCount,
  isMutateOperation,
  getMutateDomains,
  getMutateOperations,
  registerMutateTool,
  type MutateRequest,
} from '../mutate.js';

describe('MUTATE_OPERATIONS', () => {
  it('should have exactly 51 operations', () => {
    const totalCount = Object.values(MUTATE_OPERATIONS).flat().length;
    expect(totalCount).toBe(51);
  });

  it('should have all 8 domains', () => {
    const domains = Object.keys(MUTATE_OPERATIONS);
    expect(domains).toEqual([
      'tasks',
      'session',
      'orchestrate',
      'research',
      'lifecycle',
      'validate',
      'release',
      'system',
    ]);
  });

  it('should have correct operation counts per domain', () => {
    expect(MUTATE_OPERATIONS.tasks.length).toBe(11);
    expect(MUTATE_OPERATIONS.session.length).toBe(7);
    expect(MUTATE_OPERATIONS.orchestrate.length).toBe(5);
    expect(MUTATE_OPERATIONS.research.length).toBe(4);
    expect(MUTATE_OPERATIONS.lifecycle.length).toBe(5);
    expect(MUTATE_OPERATIONS.validate.length).toBe(2);
    expect(MUTATE_OPERATIONS.release.length).toBe(7);
    expect(MUTATE_OPERATIONS.system.length).toBe(10);
  });
});

describe('validateMutateParams', () => {
  describe('domain validation', () => {
    it('should reject invalid domain', () => {
      const request: MutateRequest = {
        domain: 'invalid' as any,
        operation: 'create',
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
        'research',
        'lifecycle',
        'validate',
        'release',
        'system',
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
    it('should reject create without title and description', () => {
      const request: MutateRequest = {
        domain: 'tasks',
        operation: 'create',
        params: {},
      };

      const result = validateMutateParams(request);
      expect(result.valid).toBe(false);
      expect(result.error?.error?.code).toBe('E_VALIDATION_FAILED');
    });

    it('should reject create with same title and description', () => {
      const request: MutateRequest = {
        domain: 'tasks',
        operation: 'create',
        params: {
          title: 'Same text',
          description: 'Same text',
        },
      };

      const result = validateMutateParams(request);
      expect(result.valid).toBe(false);
      expect(result.error?.error?.message).toContain('must be different');
    });

    it('should accept create with valid title and description', () => {
      const request: MutateRequest = {
        domain: 'tasks',
        operation: 'create',
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

    it('should reject focus.set without taskId', () => {
      const request: MutateRequest = {
        domain: 'session',
        operation: 'focus.set',
        params: {},
      };

      const result = validateMutateParams(request);
      expect(result.valid).toBe(false);
      expect(result.error?.error?.message).toContain('taskId');
    });
  });

  describe('orchestrate domain parameter validation', () => {
    it('should reject startup without epicId', () => {
      const request: MutateRequest = {
        domain: 'orchestrate',
        operation: 'startup',
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

    it('should reject parallel.start without epicId and wave', () => {
      const request: MutateRequest = {
        domain: 'orchestrate',
        operation: 'parallel.start',
        params: {},
      };

      const result = validateMutateParams(request);
      expect(result.valid).toBe(false);
      expect(result.error?.error?.message).toContain('epicId and wave');
    });

    it('should accept parallel.start with epicId and wave', () => {
      const request: MutateRequest = {
        domain: 'orchestrate',
        operation: 'parallel.start',
        params: {
          epicId: 'T1234',
          wave: 1,
        },
      };

      const result = validateMutateParams(request);
      expect(result.valid).toBe(true);
    });
  });

  describe('research domain parameter validation', () => {
    it('should reject inject without protocolType', () => {
      const request: MutateRequest = {
        domain: 'research',
        operation: 'inject',
        params: {},
      };

      const result = validateMutateParams(request);
      expect(result.valid).toBe(false);
      expect(result.error?.error?.message).toContain('protocolType');
    });

    it('should reject link without researchId and taskId', () => {
      const request: MutateRequest = {
        domain: 'research',
        operation: 'link',
        params: {},
      };

      const result = validateMutateParams(request);
      expect(result.valid).toBe(false);
      expect(result.error?.error?.message).toContain('researchId and taskId');
    });

    it('should reject manifest.append without entry', () => {
      const request: MutateRequest = {
        domain: 'research',
        operation: 'manifest.append',
        params: {},
      };

      const result = validateMutateParams(request);
      expect(result.valid).toBe(false);
      expect(result.error?.error?.message).toContain('entry');
    });
  });

  describe('lifecycle domain parameter validation', () => {
    it('should reject progress without required params', () => {
      const request: MutateRequest = {
        domain: 'lifecycle',
        operation: 'progress',
        params: {},
      };

      const result = validateMutateParams(request);
      expect(result.valid).toBe(false);
      expect(result.error?.error?.message).toContain('taskId, stage, and status');
    });

    it('should reject skip without required params', () => {
      const request: MutateRequest = {
        domain: 'lifecycle',
        operation: 'skip',
        params: {},
      };

      const result = validateMutateParams(request);
      expect(result.valid).toBe(false);
      expect(result.error?.error?.message).toContain('taskId, stage, and reason');
    });

    it('should reject gate.pass without taskId and gateName', () => {
      const request: MutateRequest = {
        domain: 'lifecycle',
        operation: 'gate.pass',
        params: {},
      };

      const result = validateMutateParams(request);
      expect(result.valid).toBe(false);
      expect(result.error?.error?.message).toContain('taskId and gateName');
    });
  });

  describe('validate domain parameter validation', () => {
    it('should reject compliance.record without taskId and result', () => {
      const request: MutateRequest = {
        domain: 'validate',
        operation: 'compliance.record',
        params: {},
      };

      const result = validateMutateParams(request);
      expect(result.valid).toBe(false);
      expect(result.error?.error?.message).toContain('taskId and result');
    });
  });

  describe('release domain parameter validation', () => {
    it('should reject release operations without version', () => {
      const operations = ['prepare', 'changelog', 'commit', 'tag', 'push', 'rollback'];

      for (const operation of operations) {
        const request: MutateRequest = {
          domain: 'release',
          operation,
          params: {},
        };

        const result = validateMutateParams(request);
        expect(result.valid).toBe(false);
        expect(result.error?.error?.message).toContain('version');
      }
    });

    it('should accept release operations with version', () => {
      const request: MutateRequest = {
        domain: 'release',
        operation: 'tag',
        params: {
          version: '1.0.0',
        },
      };

      const result = validateMutateParams(request);
      expect(result.valid).toBe(true);
    });
  });

  describe('system domain parameter validation', () => {
    it('should reject config.set without key and value', () => {
      const request: MutateRequest = {
        domain: 'system',
        operation: 'config.set',
        params: {},
      };

      const result = validateMutateParams(request);
      expect(result.valid).toBe(false);
      expect(result.error?.error?.message).toContain('key and value');
    });

    it('should reject restore without backupId', () => {
      const request: MutateRequest = {
        domain: 'system',
        operation: 'restore',
        params: {},
      };

      const result = validateMutateParams(request);
      expect(result.valid).toBe(false);
      expect(result.error?.error?.message).toContain('backupId');
    });

    it('should reject cleanup without type', () => {
      const request: MutateRequest = {
        domain: 'system',
        operation: 'cleanup',
        params: {},
      };

      const result = validateMutateParams(request);
      expect(result.valid).toBe(false);
      expect(result.error?.error?.message).toContain('type');
    });
  });
});

describe('isIdempotentOperation', () => {
  it('should identify idempotent operations', () => {
    expect(isIdempotentOperation('tasks', 'complete')).toBe(true);
    expect(isIdempotentOperation('tasks', 'archive')).toBe(true);
    expect(isIdempotentOperation('session', 'end')).toBe(true);
    expect(isIdempotentOperation('session', 'focus.clear')).toBe(true);
    expect(isIdempotentOperation('lifecycle', 'progress')).toBe(true);
    expect(isIdempotentOperation('system', 'init')).toBe(true);
  });

  it('should identify non-idempotent operations', () => {
    expect(isIdempotentOperation('tasks', 'create')).toBe(false);
    expect(isIdempotentOperation('tasks', 'delete')).toBe(false);
    expect(isIdempotentOperation('session', 'start')).toBe(false);
  });
});

describe('requiresSession', () => {
  it('should identify operations requiring session', () => {
    expect(requiresSession('tasks', 'create')).toBe(true);
    expect(requiresSession('tasks', 'update')).toBe(true);
    expect(requiresSession('tasks', 'complete')).toBe(true);
    expect(requiresSession('session', 'start')).toBe(true);
    expect(requiresSession('session', 'focus.set')).toBe(true);
    expect(requiresSession('orchestrate', 'startup')).toBe(true);
    expect(requiresSession('orchestrate', 'spawn')).toBe(true);
  });

  it('should identify operations not requiring session', () => {
    expect(requiresSession('tasks', 'delete')).toBe(false);
    expect(requiresSession('session', 'end')).toBe(false);
    expect(requiresSession('release', 'tag')).toBe(false);
  });
});

describe('getMutateOperationCount', () => {
  it('should return total count without domain', () => {
    expect(getMutateOperationCount()).toBe(51);
  });

  it('should return domain-specific counts', () => {
    expect(getMutateOperationCount('tasks')).toBe(11);
    expect(getMutateOperationCount('session')).toBe(7);
    expect(getMutateOperationCount('orchestrate')).toBe(5);
    expect(getMutateOperationCount('research')).toBe(4);
    expect(getMutateOperationCount('lifecycle')).toBe(5);
    expect(getMutateOperationCount('validate')).toBe(2);
    expect(getMutateOperationCount('release')).toBe(7);
    expect(getMutateOperationCount('system')).toBe(10);
  });

  it('should return 0 for unknown domain', () => {
    expect(getMutateOperationCount('unknown')).toBe(0);
  });
});

describe('isMutateOperation', () => {
  it('should identify valid mutate operations', () => {
    expect(isMutateOperation('tasks', 'create')).toBe(true);
    expect(isMutateOperation('session', 'start')).toBe(true);
    expect(isMutateOperation('orchestrate', 'spawn')).toBe(true);
  });

  it('should reject invalid operations', () => {
    expect(isMutateOperation('tasks', 'invalid')).toBe(false);
    expect(isMutateOperation('unknown', 'create')).toBe(false);
  });
});

describe('getMutateDomains', () => {
  it('should return all mutate domains', () => {
    const domains = getMutateDomains();
    expect(domains).toEqual([
      'tasks',
      'session',
      'orchestrate',
      'research',
      'lifecycle',
      'validate',
      'release',
      'system',
    ]);
  });
});

describe('getMutateOperations', () => {
  it('should return operations for specific domain', () => {
    const taskOps = getMutateOperations('tasks');
    expect(taskOps).toContain('create');
    expect(taskOps).toContain('update');
    expect(taskOps).toContain('complete');
    expect(taskOps.length).toBe(11);
  });

  it('should return empty array for unknown domain', () => {
    expect(getMutateOperations('unknown')).toEqual([]);
  });
});

describe('registerMutateTool', () => {
  it('should return valid MCP tool definition', () => {
    const tool = registerMutateTool();

    expect(tool.name).toBe('cleo_mutate');
    expect(tool.description).toContain('write operations');
    expect(tool.inputSchema.type).toBe('object');
    expect(tool.inputSchema.required).toEqual(['domain', 'operation']);
    expect(tool.inputSchema.properties.domain.enum).toEqual([
      'tasks',
      'session',
      'orchestrate',
      'research',
      'lifecycle',
      'validate',
      'release',
      'system',
    ]);
  });
});
