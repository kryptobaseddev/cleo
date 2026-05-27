import { describe, expect, it } from 'vitest';
import {
  getActiveDomains,
  getByDomain,
  getByGateway,
  getByTier,
  getCounts,
  OPERATIONS,
  resolve,
  validateRequiredParams,
} from '../registry.js';

describe('Operation Registry', () => {
  describe('Module validation', () => {
    it('should report dynamic operation totals consistently', () => {
      const counts = getCounts();
      expect(counts.query).toBeGreaterThan(0);
      expect(counts.mutate).toBeGreaterThan(0);
      expect(counts.total).toBe(counts.query + counts.mutate);
      expect(OPERATIONS.length).toBe(counts.total);
    });

    it('should cover all 10 canonical domains including nexus', () => {
      const domains = getActiveDomains();
      expect(domains).toContain('tasks');
      expect(domains).toContain('session');
      expect(domains).toContain('memory');
      expect(domains).toContain('check');
      expect(domains).toContain('pipeline');
      expect(domains).toContain('orchestrate');
      expect(domains).toContain('tools');
      expect(domains).toContain('admin');
      expect(domains).toContain('nexus');
    });
  });

  describe('Operation Resolution', () => {
    it('should resolve a direct canonical operation', () => {
      const result = resolve('query', 'tasks', 'show');
      expect(result).toBeDefined();
      expect(result?.domain).toBe('tasks');
      expect(result?.operation).toBe('show');
    });

    it('should resolve prefixed sub-domain operations', () => {
      const skill = resolve('query', 'tools', 'skill.list');
      expect(skill).toBeDefined();
      expect(skill?.domain).toBe('tools');
      expect(skill?.operation).toBe('skill.list');

      const stage = resolve('query', 'pipeline', 'stage.validate');
      expect(stage).toBeDefined();
      expect(stage?.domain).toBe('pipeline');
      expect(stage?.operation).toBe('stage.validate');

      // T9540 removed `release.ship`; T10103 deleted the deprecation shim
      // outright. The sub-domain prefix resolution we want to exercise here
      // is now `release.list` (query) — same dotted-prefix path through the
      // pipeline domain.
      const release = resolve('query', 'pipeline', 'release.list');
      expect(release).toBeDefined();
      expect(release?.domain).toBe('pipeline');
      expect(release?.operation).toBe('release.list');
    });

    it('should resolve memory domain operations', () => {
      const result = resolve('query', 'memory', 'find');
      expect(result).toBeDefined();
      expect(result?.domain).toBe('memory');
      expect(result?.operation).toBe('find');
    });

    it('should return undefined for unknown operations', () => {
      expect(resolve('query', 'tasks', 'not_a_real_operation')).toBeUndefined();
      expect(resolve('query', 'unknown', 'show')).toBeUndefined();
    });

    /**
     * T10111: `cleo relates remove` returned `E_INVALID_OPERATION` because the
     * operation handler was wired in the dispatch domain + MUTATE_OPS set but
     * never registered in the contracts OPERATIONS registry. Lock-in regression
     * test: every relates verb listed in the CLI help text must resolve.
     */
    it('should resolve mutate:tasks.relates.remove (T10111)', () => {
      const resolution = resolve('mutate', 'tasks', 'relates.remove');
      expect(resolution).toBeDefined();
      expect(resolution?.domain).toBe('tasks');
      expect(resolution?.operation).toBe('relates.remove');
      expect(resolution?.def.requiredParams).toContain('taskId');
      expect(resolution?.def.requiredParams).toContain('relatedId');
    });

    it('should resolve mutate:tasks.relates.add (companion of relates.remove)', () => {
      const resolution = resolve('mutate', 'tasks', 'relates.add');
      expect(resolution).toBeDefined();
      expect(resolution?.domain).toBe('tasks');
      expect(resolution?.operation).toBe('relates.add');
    });
  });

  describe('Parameter Validation', () => {
    it('should return empty array when all required params present', () => {
      const def = {
        gateway: 'query' as const,
        domain: 'tasks' as const,
        operation: 'show',
        description: 'Test',
        tier: 0 as const,
        idempotent: true,
        sessionRequired: false,
        requiredParams: ['id'],
      };

      expect(validateRequiredParams(def, { id: 'T123' })).toEqual([]);
      expect(validateRequiredParams(def, { id: 'T123', extra: true })).toEqual([]);
    });

    it('should return missing params', () => {
      const def = {
        gateway: 'mutate' as const,
        domain: 'tasks' as const,
        operation: 'add',
        description: 'Test',
        tier: 0 as const,
        idempotent: false,
        sessionRequired: false,
        requiredParams: ['title', 'size'],
      };

      expect(validateRequiredParams(def, {})).toEqual(['title', 'size']);
      expect(validateRequiredParams(def, { title: 'Test' })).toEqual(['size']);
      expect(validateRequiredParams(def, { title: 'Test', size: null })).toEqual(['size']);
    });
  });

  describe('Filtered Views', () => {
    it('should get operations by domain', () => {
      const tasksOps = getByDomain('tasks');
      expect(tasksOps.length).toBe(OPERATIONS.filter((o) => o.domain === 'tasks').length);
      expect(tasksOps.every((o) => o.domain === 'tasks')).toBe(true);

      const memoryOps = getByDomain('memory');
      expect(memoryOps.length).toBe(OPERATIONS.filter((o) => o.domain === 'memory').length);

      const toolsOps = getByDomain('tools');
      expect(toolsOps.length).toBe(OPERATIONS.filter((o) => o.domain === 'tools').length);
    });

    it('should get operations by gateway', () => {
      const queryOps = getByGateway('query');
      expect(queryOps.length).toBe(getCounts().query);
      expect(queryOps.every((o) => o.gateway === 'query')).toBe(true);

      const mutateOps = getByGateway('mutate');
      expect(mutateOps.length).toBe(getCounts().mutate);
    });

    it('should get operations by tier', () => {
      const tier0 = getByTier(0);
      expect(tier0.length).toBeGreaterThan(0);
      expect(tier0.every((o) => o.tier === 0)).toBe(true);

      const allTiers = getByTier(2);
      expect(allTiers.length).toBe(getCounts().total);
    });
  });
});
