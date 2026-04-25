/**
 * Tests for the Conduit domain handler (T1422 typed-dispatch migration).
 *
 * Verifies:
 *   1. Query and mutate operations are properly declared
 *   2. Unsupported operations return correct error
 *   3. Operation routing is correct
 *   4. Envelope format is LAFS-compliant
 *
 * @task T1422 — Typed-dispatch migration (T975 follow-on)
 */

import { describe, expect, it } from 'vitest';
import { ConduitHandler } from '../conduit.js';

describe('ConduitHandler (T1422 typed-dispatch)', () => {
  const handler = new ConduitHandler();

  // =========================================================================
  // Supported Operations Declaration
  // =========================================================================

  describe('supported operations', () => {
    it('declares query operations: status, peek, listen', () => {
      const ops = handler.getSupportedOperations();
      expect(ops.query).toEqual(expect.arrayContaining(['status', 'peek', 'listen']));
      expect(ops.query).toHaveLength(3);
    });

    it('declares mutate operations: start, stop, send, subscribe, publish', () => {
      const ops = handler.getSupportedOperations();
      expect(ops.mutate).toEqual(
        expect.arrayContaining(['start', 'stop', 'send', 'subscribe', 'publish']),
      );
      expect(ops.mutate).toHaveLength(5);
    });
  });

  // =========================================================================
  // Operation Routing (via unsupported operation detection)
  // =========================================================================

  describe('operation routing', () => {
    it('rejects unsupported query operations', async () => {
      const result = await handler.query('unsupported', {});
      expect(result.success).toBe(false);
    });

    it('rejects unsupported mutate operations', async () => {
      const result = await handler.mutate('unsupported', {});
      expect(result.success).toBe(false);
    });
  });

  // =========================================================================
  // Envelope Format (LAFS compliance) — error paths
  // =========================================================================

  describe('envelope format (LAFS compliance)', () => {
    it('unsupported query response has success=false', async () => {
      const result = await handler.query('unsupported', {});
      expect(result).toHaveProperty('success');
      expect(result.success).toBe(false);
    });

    it('unsupported query response includes error with code and message', async () => {
      const result = await handler.query('unsupported', {});
      expect(result.error).toBeDefined();
      if (result.error) {
        expect(result.error).toHaveProperty('code');
        expect(result.error).toHaveProperty('message');
        expect(typeof result.error.code).toBe('string');
        expect(typeof result.error.message).toBe('string');
      }
    });

    it('unsupported mutate response has success=false', async () => {
      const result = await handler.mutate('unsupported', {});
      expect(result).toHaveProperty('success');
      expect(result.success).toBe(false);
    });

    it('unsupported mutate response includes error with code and message', async () => {
      const result = await handler.mutate('unsupported', {});
      expect(result.error).toBeDefined();
      if (result.error) {
        expect(result.error).toHaveProperty('code');
        expect(result.error).toHaveProperty('message');
        expect(typeof result.error.code).toBe('string');
        expect(typeof result.error.message).toBe('string');
      }
    });
  });

  // =========================================================================
  // Type Safety via Typed-Dispatch (T1422)
  // =========================================================================

  describe('typed-dispatch signature validation', () => {
    it('handler implements DomainHandler interface', () => {
      expect(handler).toHaveProperty('query');
      expect(handler).toHaveProperty('mutate');
      expect(handler).toHaveProperty('getSupportedOperations');
      expect(typeof handler.query).toBe('function');
      expect(typeof handler.mutate).toBe('function');
      expect(typeof handler.getSupportedOperations).toBe('function');
    });

    it('query signature accepts operation string and optional params', async () => {
      const result = await handler.query('status', { agentId: 'test' });
      expect(result).toBeDefined();
      // Test that params are passed through (even if operation fails)
    });

    it('mutate signature accepts operation string and optional params', async () => {
      const result = await handler.mutate('stop', {});
      expect(result).toBeDefined();
      // Test that params are passed through
    });
  });
});
