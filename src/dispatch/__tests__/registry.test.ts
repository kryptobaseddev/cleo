import { describe, it, expect } from 'vitest';
import {
  OPERATIONS,
  resolve,
  validateRequiredParams,
  getByDomain,
  getByGateway,
  getByTier,
  getActiveDomains,
  getCounts
} from '../registry.js';

describe('Operation Registry', () => {
  describe('Module validation', () => {
    it('should have exactly 145 operations registered (81Q + 64M)', () => {
      const counts = getCounts();
      expect(counts.query).toBe(81);
      expect(counts.mutate).toBe(64);
      expect(counts.total).toBe(145);
      expect(OPERATIONS.length).toBe(145);
    });

    it('should cover all 9 canonical domains', () => {
      const domains = getActiveDomains();
      expect(domains).toContain('tasks');
      expect(domains).toContain('session');
      expect(domains).toContain('memory');
      expect(domains).toContain('check');
      expect(domains).toContain('pipeline');
      expect(domains).toContain('orchestrate');
      expect(domains).toContain('tools');
      expect(domains).toContain('admin');
      // nexus is a placeholder with 0 ops — not required in active domains
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

      const release = resolve('mutate', 'pipeline', 'release.prepare');
      expect(release).toBeDefined();
      expect(release?.domain).toBe('pipeline');
      expect(release?.operation).toBe('release.prepare');
    });

    it('should resolve memory domain operations', () => {
      const result = resolve('query', 'memory', 'show');
      expect(result).toBeDefined();
      expect(result?.domain).toBe('memory');
      expect(result?.operation).toBe('show');
    });

    it('should return undefined for unknown operations', () => {
      expect(resolve('query', 'tasks', 'not_a_real_operation')).toBeUndefined();
      expect(resolve('query', 'unknown', 'show')).toBeUndefined();
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
      expect(tasksOps.length).toBe(25);
      expect(tasksOps.every(o => o.domain === 'tasks')).toBe(true);

      const memoryOps = getByDomain('memory');
      expect(memoryOps.length).toBe(12);

      const toolsOps = getByDomain('tools');
      expect(toolsOps.length).toBe(27);
    });

    it('should get operations by gateway', () => {
      const queryOps = getByGateway('query');
      expect(queryOps.length).toBe(81);
      expect(queryOps.every(o => o.gateway === 'query')).toBe(true);

      const mutateOps = getByGateway('mutate');
      expect(mutateOps.length).toBe(64);
    });

    it('should get operations by tier', () => {
      const tier0 = getByTier(0);
      expect(tier0.length).toBeGreaterThan(0);
      expect(tier0.every(o => o.tier === 0)).toBe(true);

      const allTiers = getByTier(2);
      expect(allTiers.length).toBe(145);
    });
  });
});
