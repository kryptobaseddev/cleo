/**
 * Sticky Domain Handler Tests (T5282)
 *
 * Tests for the sticky note domain: quick capture notes before formal
 * classification as tasks. Operations: add, list, show, convert, archive.
 *
 * @task T5282
 * @epic T5277
 * @task T1535 — OpsFromCore migration tests
 * @task T1537 — convert sub-operation split tests
 */

import { describe, expect, it } from 'vitest';
import { getByDomain, OPERATIONS } from '../../registry.js';
import { CANONICAL_DOMAINS } from '../../types.js';
import type { StickyDispatchOps } from '../sticky.js';
import { StickyHandler } from '../sticky.js';

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
        (o) => o.domain === 'sticky' && o.operation === 'add' && o.gateway === 'mutate',
      );
      expect(addOp).toBeDefined();
    });
  });

  describe('sticky.list (query)', () => {
    it('should be registered as a query operation', () => {
      const listOp = OPERATIONS.find(
        (o) => o.domain === 'sticky' && o.operation === 'list' && o.gateway === 'query',
      );
      expect(listOp).toBeDefined();
    });
  });

  describe('sticky.show (query)', () => {
    it('should be registered as a query operation', () => {
      const showOp = OPERATIONS.find(
        (o) => o.domain === 'sticky' && o.operation === 'show' && o.gateway === 'query',
      );
      expect(showOp).toBeDefined();
    });
  });

  describe('sticky.convert (mutate)', () => {
    it('should be registered as a mutate operation', () => {
      const convertOp = OPERATIONS.find(
        (o) => o.domain === 'sticky' && o.operation === 'convert' && o.gateway === 'mutate',
      );
      expect(convertOp).toBeDefined();
    });
  });

  describe('sticky.archive (mutate)', () => {
    it('should be registered as a mutate operation', () => {
      const archiveOp = OPERATIONS.find(
        (o) => o.domain === 'sticky' && o.operation === 'archive' && o.gateway === 'mutate',
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

  // =========================================================================
  // T1535 — OpsFromCore typed handler pattern
  // =========================================================================

  describe('T1535 — OpsFromCore typed handler', () => {
    it('StickyHandler can be instantiated', () => {
      const handler = new StickyHandler();
      expect(handler).toBeDefined();
    });

    it('getSupportedOperations returns expected shape', () => {
      const handler = new StickyHandler();
      const ops = handler.getSupportedOperations();
      expect(ops.query).toContain('list');
      expect(ops.query).toContain('show');
      expect(ops.mutate).toContain('add');
      expect(ops.mutate).toContain('convert');
      expect(ops.mutate).toContain('archive');
      expect(ops.mutate).toContain('purge');
    });

    it('query with unsupported op returns E_INVALID_OPERATION', async () => {
      const handler = new StickyHandler();
      const result = await handler.query('not-a-real-op', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
    });

    it('mutate with unsupported op returns E_INVALID_OPERATION', async () => {
      const handler = new StickyHandler();
      const result = await handler.mutate('not-a-real-op', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
    });

    it('StickyDispatchOps type is exported (compile-time check)', () => {
      // If file compiles, the exported type exists. Runtime proof: handler is instantiable.
      type _check = StickyDispatchOps;
      const handler = new StickyHandler();
      expect(handler).toBeDefined();
    });
  });

  // =========================================================================
  // T1537 — Convert sub-operation split
  // =========================================================================

  describe('T1537 — convert sub-operation routing', () => {
    it('mutate convert without targetType returns E_INVALID_INPUT', async () => {
      const handler = new StickyHandler();
      const result = await handler.mutate('convert', { stickyId: 'SN-001' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
      expect(result.error?.message).toContain('targetType');
    });

    it('mutate convert with invalid targetType returns E_INVALID_INPUT', async () => {
      const handler = new StickyHandler();
      const result = await handler.mutate('convert', { stickyId: 'SN-001', targetType: 'bogus' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('mutate convert task_note without taskId returns E_INVALID_INPUT', async () => {
      const handler = new StickyHandler();
      // Intentionally omit taskId to trigger sub-op typed validation
      const result = await handler.mutate('convert', {
        stickyId: 'SN-001',
        targetType: 'task_note',
      });
      // Sub-op validation fires: taskId is required for task_note
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });
  });
});
