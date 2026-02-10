/**
 * Domain Router Tests
 *
 * Tests routing logic, validation, and error handling
 *
 * @task T2911
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DomainRouter, RouterError } from '../src/lib/router.js';

describe('DomainRouter', () => {
  let router: DomainRouter;

  beforeEach(() => {
    router = new DomainRouter();
  });

  describe('getDomains', () => {
    it('should return all 8 domains', () => {
      const domains = router.getDomains();
      expect(domains).toHaveLength(8);
      expect(domains).toContain('tasks');
      expect(domains).toContain('session');
      expect(domains).toContain('orchestrate');
      expect(domains).toContain('research');
      expect(domains).toContain('lifecycle');
      expect(domains).toContain('validate');
      expect(domains).toContain('release');
      expect(domains).toContain('system');
    });
  });

  describe('getDomainOperations', () => {
    it('should return operations for tasks domain', () => {
      const ops = router.getDomainOperations('tasks');
      expect(ops).not.toBeNull();
      expect(ops?.query).toContain('get');
      expect(ops?.query).toContain('list');
      expect(ops?.mutate).toContain('create');
      expect(ops?.mutate).toContain('update');
    });

    it('should return null for unknown domain', () => {
      const ops = router.getDomainOperations('unknown');
      expect(ops).toBeNull();
    });

    it('should return empty query array for release domain', () => {
      const ops = router.getDomainOperations('release');
      expect(ops?.query).toEqual([]);
      expect(ops?.mutate.length).toBeGreaterThan(0);
    });
  });

  describe('validateRoute', () => {
    it('should accept valid query operation', () => {
      expect(() => {
        router.validateRoute({
          gateway: 'cleo_query',
          domain: 'tasks',
          operation: 'get',
        });
      }).not.toThrow();
    });

    it('should accept valid mutate operation', () => {
      expect(() => {
        router.validateRoute({
          gateway: 'cleo_mutate',
          domain: 'tasks',
          operation: 'create',
        });
      }).not.toThrow();
    });

    it('should reject unknown domain', () => {
      expect(() => {
        router.validateRoute({
          gateway: 'cleo_query',
          domain: 'unknown',
          operation: 'get',
        });
      }).toThrow(RouterError);
    });

    it('should reject invalid operation for domain', () => {
      expect(() => {
        router.validateRoute({
          gateway: 'cleo_query',
          domain: 'tasks',
          operation: 'create', // create is mutate-only
        });
      }).toThrow(RouterError);
    });

    it('should reject query operations on release domain', () => {
      expect(() => {
        router.validateRoute({
          gateway: 'cleo_query',
          domain: 'release',
          operation: 'prepare',
        });
      }).toThrow(RouterError);
    });

    it('should reject mutate operation on query gateway', () => {
      expect(() => {
        router.validateRoute({
          gateway: 'cleo_query',
          domain: 'tasks',
          operation: 'update', // update is mutate-only
        });
      }).toThrow(RouterError);
    });
  });

  describe('routeOperation', () => {
    it('should route query operation and return not implemented', async () => {
      const response = await router.routeOperation({
        gateway: 'cleo_query',
        domain: 'tasks',
        operation: 'get',
        params: { taskId: 'T1234' },
      });

      expect(response.success).toBe(false);
      expect(response._meta.gateway).toBe('cleo_query');
      expect(response._meta.domain).toBe('tasks');
      expect(response._meta.operation).toBe('get');
      expect(response.error?.code).toBe('E_NOT_IMPLEMENTED');
      expect(response._meta.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('should route mutate operation and return not implemented', async () => {
      const response = await router.routeOperation({
        gateway: 'cleo_mutate',
        domain: 'tasks',
        operation: 'create',
        params: { title: 'Test Task' },
      });

      expect(response.success).toBe(false);
      expect(response._meta.gateway).toBe('cleo_mutate');
      expect(response._meta.domain).toBe('tasks');
      expect(response._meta.operation).toBe('create');
      expect(response.error?.code).toBe('E_NOT_IMPLEMENTED');
    });

    it('should return error for invalid domain', async () => {
      const response = await router.routeOperation({
        gateway: 'cleo_query',
        domain: 'invalid',
        operation: 'get',
      });

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('E_INVALID_DOMAIN');
      expect(response.error?.exitCode).toBe(2);
    });

    it('should return error for invalid operation', async () => {
      const response = await router.routeOperation({
        gateway: 'cleo_query',
        domain: 'tasks',
        operation: 'invalid',
      });

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('E_INVALID_OPERATION');
    });

    it('should include timestamp in metadata', async () => {
      const response = await router.routeOperation({
        gateway: 'cleo_query',
        domain: 'tasks',
        operation: 'list',
      });

      expect(response._meta.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should include version in metadata', async () => {
      const response = await router.routeOperation({
        gateway: 'cleo_query',
        domain: 'tasks',
        operation: 'list',
      });

      expect(response._meta.version).toBe('1.0.0');
    });
  });

  describe('domain-specific routing', () => {
    const testCases = [
      { domain: 'tasks', query: 'list', mutate: 'create' },
      { domain: 'session', query: 'status', mutate: 'start' },
      { domain: 'orchestrate', query: 'status', mutate: 'startup' },
      { domain: 'research', query: 'list', mutate: 'link' },
      { domain: 'lifecycle', query: 'check', mutate: 'progress' },
      { domain: 'validate', query: 'schema', mutate: 'compliance.record' },
      { domain: 'release', mutate: 'prepare' },
      { domain: 'system', query: 'version', mutate: 'init' },
    ];

    testCases.forEach(({ domain, query, mutate }) => {
      if (query) {
        it(`should route ${domain}.${query} query operation`, async () => {
          const response = await router.routeOperation({
            gateway: 'cleo_query',
            domain,
            operation: query,
          });

          expect(response._meta.domain).toBe(domain);
          expect(response._meta.operation).toBe(query);
        });
      }

      it(`should route ${domain}.${mutate} mutate operation`, async () => {
        const response = await router.routeOperation({
          gateway: 'cleo_mutate',
          domain,
          operation: mutate,
        });

        expect(response._meta.domain).toBe(domain);
        expect(response._meta.operation).toBe(mutate);
      });
    });
  });
});
