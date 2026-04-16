/**
 * Docs Domain Handler Tests (T797)
 *
 * Tests for the docs domain: attachment management operations
 * (add, list, fetch, remove) backed by the AttachmentStore.
 *
 * Handler-level tests validate:
 *   - Proper E_INVALID_INPUT on missing required parameters (no DB calls needed)
 *   - Correct registry integration (operations declared, structure valid)
 *   - DocsHandler is registered in the domain map
 *
 * Store-level integration tests live in @cleocode/core/src/store/__tests__/attachment-store.test.ts.
 *
 * @epic T760
 * @task T797
 */

import { describe, expect, it } from 'vitest';
import { getByDomain, OPERATIONS } from '../../registry.js';
import { CANONICAL_DOMAINS } from '../../types.js';
import { DocsHandler } from '../docs.js';
import { createDomainHandlers } from '../index.js';

// ===========================================================================
// Mocks — prevent SQLite access in handler tests
// ===========================================================================

// The docs handler only calls createAttachmentStore() inside the switch
// case bodies, after required-param validation. For the tests below that
// pass empty params, the handler returns E_INVALID_INPUT before any DB call.
// No mocks needed for those tests.

// ===========================================================================
// Registry Tests
// ===========================================================================

describe('Docs Domain Registry (T797)', () => {
  it('docs is a canonical domain', () => {
    expect(CANONICAL_DOMAINS).toContain('docs');
  });

  it('docs domain has 4 registered operations', () => {
    const docsOps = getByDomain('docs');
    expect(docsOps).toHaveLength(4);
  });

  it('docs has expected query operations', () => {
    const docsOps = getByDomain('docs');
    const queryOps = docsOps.filter((o) => o.gateway === 'query');
    const names = queryOps.map((o) => o.operation);
    expect(names).toContain('list');
    expect(names).toContain('fetch');
  });

  it('docs has expected mutate operations', () => {
    const docsOps = getByDomain('docs');
    const mutateOps = docsOps.filter((o) => o.gateway === 'mutate');
    const names = mutateOps.map((o) => o.operation);
    expect(names).toContain('add');
    expect(names).toContain('remove');
  });

  it('all docs operations have valid structure', () => {
    const docsOps = getByDomain('docs');
    for (const op of docsOps) {
      expect(op.gateway).toMatch(/^(query|mutate)$/);
      expect(op.domain).toBe('docs');
      expect(typeof op.operation).toBe('string');
      expect(op.operation.length).toBeGreaterThan(0);
      expect(typeof op.tier).toBe('number');
      expect(typeof op.idempotent).toBe('boolean');
      expect(Array.isArray(op.requiredParams)).toBe(true);
    }
  });

  it('docs.add has ownerId as a required param', () => {
    const addOp = OPERATIONS.find((o) => o.domain === 'docs' && o.operation === 'add');
    expect(addOp).toBeDefined();
    expect(addOp!.requiredParams).toContain('ownerId');
  });

  it('docs.fetch has attachmentRef as a required param', () => {
    const fetchOp = OPERATIONS.find((o) => o.domain === 'docs' && o.operation === 'fetch');
    expect(fetchOp).toBeDefined();
    expect(fetchOp!.requiredParams).toContain('attachmentRef');
  });

  it('docs.remove has attachmentRef and from as required params', () => {
    const removeOp = OPERATIONS.find((o) => o.domain === 'docs' && o.operation === 'remove');
    expect(removeOp).toBeDefined();
    expect(removeOp!.requiredParams).toContain('attachmentRef');
    expect(removeOp!.requiredParams).toContain('from');
  });
});

// ===========================================================================
// Domain Handler Registration
// ===========================================================================

describe('Docs Domain Handler Registration', () => {
  it('DocsHandler is registered in createDomainHandlers()', () => {
    const handlers = createDomainHandlers();
    expect(handlers.has('docs')).toBe(true);
    expect(handlers.get('docs')).toBeInstanceOf(DocsHandler);
  });

  it('DocsHandler reports correct supported operations', () => {
    const handler = new DocsHandler();
    const ops = handler.getSupportedOperations();
    expect(ops.query).toContain('list');
    expect(ops.query).toContain('fetch');
    expect(ops.mutate).toContain('add');
    expect(ops.mutate).toContain('remove');
  });
});

// ===========================================================================
// Parameter Validation Tests (no DB required)
// ===========================================================================

describe('DocsHandler parameter validation', () => {
  const handler = new DocsHandler();

  describe('docs.add', () => {
    it('returns E_INVALID_INPUT when ownerId is missing', async () => {
      const result = await handler.mutate('add', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('returns E_INVALID_INPUT when no file or url is provided', async () => {
      const result = await handler.mutate('add', { ownerId: 'T001' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('does not return E_INVALID_OPERATION', async () => {
      const result = await handler.mutate('add', {});
      expect(result.error?.code).not.toBe('E_INVALID_OPERATION');
    });
  });

  describe('docs.list', () => {
    it('returns E_INVALID_INPUT when no owner filter is provided', async () => {
      const result = await handler.query('list', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('does not return E_INVALID_OPERATION', async () => {
      const result = await handler.query('list', {});
      expect(result.error?.code).not.toBe('E_INVALID_OPERATION');
    });
  });

  describe('docs.fetch', () => {
    it('returns E_INVALID_INPUT when attachmentRef is missing', async () => {
      const result = await handler.query('fetch', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('does not return E_INVALID_OPERATION', async () => {
      const result = await handler.query('fetch', {});
      expect(result.error?.code).not.toBe('E_INVALID_OPERATION');
    });
  });

  describe('docs.remove', () => {
    it('returns E_INVALID_INPUT when attachmentRef is missing', async () => {
      const result = await handler.mutate('remove', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('returns E_INVALID_INPUT when --from is missing', async () => {
      const result = await handler.mutate('remove', { attachmentRef: 'att_abc' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('does not return E_INVALID_OPERATION', async () => {
      const result = await handler.mutate('remove', {});
      expect(result.error?.code).not.toBe('E_INVALID_OPERATION');
    });
  });

  describe('unknown operations', () => {
    it('returns E_INVALID_OPERATION for unknown query op', async () => {
      const result = await handler.query('unknown-op', {});
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
    });

    it('returns E_INVALID_OPERATION for unknown mutate op', async () => {
      const result = await handler.mutate('unknown-op', {});
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
    });
  });
});

// ===========================================================================
// inferOwnerType heuristics (tested indirectly via docs.add validation path)
// ===========================================================================

describe('DocsHandler owner type inference (via docs.list)', () => {
  const handler = new DocsHandler();

  it('accepts T### task IDs via --task option', async () => {
    // Providing a valid task ID via the task param — this gets past the
    // "no owner filter" check and will try to call the store (which will
    // fail with E_INTERNAL in test env), but must NOT return E_INVALID_INPUT
    // for the ID format itself.
    const result = await handler.query('list', { task: 'T123' });
    // Should either succeed (if store works) or fail with E_INTERNAL (store error),
    // but NOT E_INVALID_INPUT (ID was accepted) or E_INVALID_OPERATION.
    expect(result.error?.code).not.toBe('E_INVALID_OPERATION');
    expect(result.error?.code).not.toBe('E_INVALID_INPUT');
  });
});
