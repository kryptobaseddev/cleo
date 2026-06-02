/**
 * Snapshot test for the OPERATIONS registry data.
 *
 * Pins the exact JSON shape of the full OPERATIONS array so that any
 * accidental addition, removal, or mutation of an entry is caught
 * immediately. This test MUST pass before and after the T10061 data
 * relocation — it is the primary guard against behavior change.
 *
 * To update the snapshot intentionally:
 *   pnpm vitest --filter @cleocode/contracts run -u
 *
 * @since T10061 — T9833b / E-CLI-BOUNDARY / SG-ARCH-SOLID T9831
 */

import { describe, expect, it } from 'vitest';
import { defineDomain, defineOp, OPERATIONS } from '../dispatch/operations-registry.js';

describe('operations-registry', () => {
  it('OPERATIONS snapshot — zero behavior change across relocation', () => {
    expect(JSON.stringify(OPERATIONS)).toMatchSnapshot();
  });

  it('OPERATIONS count is consistent', () => {
    expect(OPERATIONS.length).toBeGreaterThan(0);
    const queryCount = OPERATIONS.filter((o) => o.gateway === 'query').length;
    const mutateCount = OPERATIONS.filter((o) => o.gateway === 'mutate').length;
    expect(queryCount + mutateCount).toBe(OPERATIONS.length);
  });

  it('every operation has required structural fields', () => {
    for (const op of OPERATIONS) {
      expect(typeof op.gateway).toBe('string');
      expect(typeof op.domain).toBe('string');
      expect(typeof op.operation).toBe('string');
      expect(typeof op.description).toBe('string');
      expect(typeof op.tier).toBe('number');
      expect(typeof op.idempotent).toBe('boolean');
      expect(typeof op.sessionRequired).toBe('boolean');
      expect(Array.isArray(op.requiredParams)).toBe(true);
    }
  });

  it('defineOp is an identity function', () => {
    const def = OPERATIONS[0];
    expect(defineOp(def)).toBe(def);
  });

  it('defineDomain returns the ops array unchanged', () => {
    const ops = OPERATIONS.filter((o) => o.domain === 'tasks');
    const result = defineDomain('tasks', ops);
    expect(result).toBe(ops);
  });

  it('registers tasks.relates.add-batch as a mutate op (T11575)', () => {
    // Regression guard for T11575: the handler + CLI command shipped but the
    // OperationDef was missing, so the dispatcher rejected every call with
    // E_INVALID_OPERATION before it reached the handler.
    const op = OPERATIONS.find((o) => o.domain === 'tasks' && o.operation === 'relates.add-batch');
    expect(op).toBeDefined();
    expect(op?.gateway).toBe('mutate');
    // The CLI accepts either { relations:[...] } or { edges:[...] }, so neither
    // is individually required at the dispatch boundary.
    expect(op?.requiredParams).toEqual([]);
    const paramNames = (op?.params ?? []).map((p) => p.name);
    expect(paramNames).toEqual(expect.arrayContaining(['relations', 'edges', 'dryRun']));
  });
});
