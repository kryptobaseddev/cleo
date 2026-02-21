import { describe, it, expect } from 'vitest';
import {
  OPERATIONS,
  resolve,
  resolveAlias,
  validateRequiredParams,
  getByDomain,
  getByGateway,
  getByTier,
  getActiveDomains,
  isLegacyDomain,
  getCounts
} from '../registry.js';

describe('Operation Registry', () => {
  describe('Module validation', () => {
    it('should have exactly 140 operations registered', () => {
      const counts = getCounts();
      expect(counts.query).toBe(75);
      expect(counts.mutate).toBe(65);
      expect(counts.total).toBe(140);
      expect(OPERATIONS.length).toBe(140);
    });
  });

  describe('Alias Resolution', () => {
    it('should normalize legacy domains to canonical equivalents', () => {
      expect(resolveAlias('research')).toBe('pipeline');
      expect(resolveAlias('validate')).toBe('check');
      expect(resolveAlias('system')).toBe('admin');
      
      // Unknown remains unchanged, to be caught by operation matching
      expect(resolveAlias('unknown')).toBe('unknown');
      
      // Canonical stays canonical
      expect(resolveAlias('tasks')).toBe('tasks');
    });

    it('should correctly identify legacy domains', () => {
      expect(isLegacyDomain('research')).toBe(true);
      expect(isLegacyDomain('tasks')).toBe(false);
      expect(isLegacyDomain('unknown')).toBe(false);
    });
  });

  describe('Operation Resolution (resolve)', () => {
    it('should resolve a canonical operation without alias warnings', () => {
      const result = resolve('query', 'tasks', 'show');
      expect(result).toBeDefined();
      expect(result?.domain).toBe('tasks');
      expect(result?.operation).toBe('show');
      expect(result?.alias.aliased).toBe(false);
      expect(result?.alias.deprecation).toBeUndefined();
    });

    it('should resolve a legacy operation with alias warnings', () => {
      const result = resolve('query', 'research', 'show');
      expect(result).toBeDefined();
      expect(result?.domain).toBe('pipeline'); // Normalized
      expect(result?.operation).toBe('show');
      expect(result?.alias.aliased).toBe(true);
      expect(result?.alias.deprecation).toContain('deprecated');
    });

    it('should return undefined for unknown operations', () => {
      expect(resolve('query', 'tasks', 'not_a_real_operation')).toBeUndefined();
      expect(resolve('query', 'unknown', 'show')).toBeUndefined();
    });
  });

  describe('Validation', () => {
    it('should return an empty array if all required params are present', () => {
      const def = {
        gateway: 'query' as const,
        domain: 'tasks' as const,
        operation: 'show',
        description: 'Test',
        tier: 0 as const,
        idempotent: true,
        sessionRequired: false,
        requiredParams: ['id']
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
        requiredParams: ['title', 'size']
      };
      
      expect(validateRequiredParams(def, {})).toEqual(['title', 'size']);
      expect(validateRequiredParams(def, { title: 'Test' })).toEqual(['size']);
      expect(validateRequiredParams(def, { title: 'Test', size: null })).toEqual(['size']);
    });
  });

  describe('Filtered Views', () => {
    it('should get operations by domain', () => {
      const tasksOps = getByDomain('tasks');
      expect(tasksOps.length).toBeGreaterThan(0);
      expect(tasksOps.every(o => o.domain === 'tasks')).toBe(true);
    });

    it('should get operations by gateway', () => {
      const queryOps = getByGateway('query');
      expect(queryOps.length).toBe(75);
      expect(queryOps.every(o => o.gateway === 'query')).toBe(true);
    });

    it('should get active domains', () => {
      const domains = getActiveDomains();
      expect(domains.includes('tasks')).toBe(true);
      expect(domains.includes('admin')).toBe(true);
      expect(domains.includes('research')).toBe(false); // Legacy is resolved
    });
  });
});
