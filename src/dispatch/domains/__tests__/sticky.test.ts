/**
 * Sticky Domain Handler Tests (T5282)
 *
 * Tests for the sticky note domain: quick capture notes before formal
 * classification as tasks. Operations: add, list, show, convert, archive.
 *
 * @task T5282
 * @epic T5277
 */

import { describe, it, expect } from 'vitest';

import { OPERATIONS, getByDomain } from '../../registry.js';
import { CANONICAL_DOMAINS } from '../../types.js';

describe('Sticky Domain (T5282)', () => {
  // =========================================================================
  // Domain Registry Tests
  // =========================================================================

  describe('registry integration', () => {
    it('sticky is a canonical domain', () => {
      expect(CANONICAL_DOMAINS).toContain('sticky');
    });

    it('sticky domain has registered operations', () => {
      const stickyOps = getByDomain('sticky');
      expect(stickyOps.length).toBeGreaterThan(0);
    });

    it('sticky has expected query operations', () => {
      const stickyOps = getByDomain('sticky');
      const queryOps = stickyOps.filter((o) => o.gateway === 'query');
      const operationNames = queryOps.map((o) => o.operation);

      expect(operationNames).toContain('list');
      expect(operationNames).toContain('show');
    });

    it('sticky has expected mutate operations', () => {
      const stickyOps = getByDomain('sticky');
      const mutateOps = stickyOps.filter((o) => o.gateway === 'mutate');
      const operationNames = mutateOps.map((o) => o.operation);

      expect(operationNames).toContain('add');
      expect(operationNames).toContain('convert');
      expect(operationNames).toContain('archive');
    });

    it('all sticky operations have valid structure', () => {
      const stickyOps = getByDomain('sticky');

      for (const op of stickyOps) {
        expect(op.gateway).toMatch(/^(query|mutate)$/);
        expect(op.domain).toBe('sticky');
        expect(typeof op.operation).toBe('string');
        expect(op.operation.length).toBeGreaterThan(0);
        expect(typeof op.tier).toBe('number');
        expect(typeof op.idempotent).toBe('boolean');
        expect(Array.isArray(op.requiredParams)).toBe(true);
      }
    });
  });

  // =========================================================================
  // Operation Registry Verification
  // =========================================================================

  describe('sticky.add (mutate)', () => {
    it('should be registered as a mutate operation', () => {
      const addOp = OPERATIONS.find(
        (o) => o.domain === 'sticky' && o.operation === 'add' && o.gateway === 'mutate'
      );
      expect(addOp).toBeDefined();
    });
  });

  describe('sticky.list (query)', () => {
    it('should be registered as a query operation', () => {
      const listOp = OPERATIONS.find(
        (o) => o.domain === 'sticky' && o.operation === 'list' && o.gateway === 'query'
      );
      expect(listOp).toBeDefined();
    });
  });

  describe('sticky.show (query)', () => {
    it('should be registered as a query operation', () => {
      const showOp = OPERATIONS.find(
        (o) => o.domain === 'sticky' && o.operation === 'show' && o.gateway === 'query'
      );
      expect(showOp).toBeDefined();
    });
  });

  describe('sticky.convert (mutate)', () => {
    it('should be registered as a mutate operation', () => {
      const convertOp = OPERATIONS.find(
        (o) => o.domain === 'sticky' && o.operation === 'convert' && o.gateway === 'mutate'
      );
      expect(convertOp).toBeDefined();
    });
  });

  describe('sticky.archive (mutate)', () => {
    it('should be registered as a mutate operation', () => {
      const archiveOp = OPERATIONS.find(
        (o) => o.domain === 'sticky' && o.operation === 'archive' && o.gateway === 'mutate'
      );
      expect(archiveOp).toBeDefined();
    });
  });

  // =========================================================================
  // Operation Count Verification
  // =========================================================================

  describe('operation coverage', () => {
    it('sticky domain has at least 5 operations', () => {
      const stickyOps = getByDomain('sticky');
      expect(stickyOps.length).toBeGreaterThanOrEqual(5);
    });

    it('sticky has both query and mutate operations', () => {
      const stickyOps = getByDomain('sticky');
      const hasQuery = stickyOps.some((o) => o.gateway === 'query');
      const hasMutate = stickyOps.some((o) => o.gateway === 'mutate');

      expect(hasQuery).toBe(true);
      expect(hasMutate).toBe(true);
    });
  });
});
