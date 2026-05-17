/**
 * Registry wiring tests for the `cleo saga` CLI suite (T9521 / ADR-073).
 *
 * Exercises the FULL dispatch pipeline (resolve → handler route) to catch the
 * exact failure class: a handler wired in domains/tasks.ts but absent from
 * registry.ts. Unit-testing handlers alone would NOT catch this.
 *
 * Tests:
 *   1. All 5 saga ops resolve from the dispatch registry
 *   2. Gateway assignments are correct (query vs mutate)
 *   3. Required params are declared correctly
 *   4. Tier and idempotent flags match intent
 *   5. Saga ops are in the tasks domain (not a separate domain)
 *
 * @task T9521
 * @see ADR-073 — Above-Epic Naming (Saga, prefix SG-)
 */

import { describe, expect, it } from 'vitest';
import { resolve, validateRequiredParams } from '../../dispatch/registry.js';

describe('T9521: saga.* operations in dispatch registry', () => {
  // -------------------------------------------------------------------------
  // saga.create (mutate)
  // -------------------------------------------------------------------------
  describe('tasks.saga.create', () => {
    it('resolves through the dispatch registry', () => {
      const result = resolve('mutate', 'tasks', 'saga.create');
      expect(
        result,
        'tasks.saga.create missing from registry — dispatcher returns E_INVALID_OPERATION',
      ).toBeDefined();
    });

    it('is registered as a mutate (non-idempotent, tier 0)', () => {
      const result = resolve('mutate', 'tasks', 'saga.create');
      expect(result).toBeDefined();
      expect(result!.def.gateway).toBe('mutate');
      expect(result!.def.idempotent).toBe(false);
      expect(result!.def.tier).toBe(0);
      expect(result!.def.sessionRequired).toBe(false);
    });

    it('does NOT resolve as a query', () => {
      const q = resolve('query', 'tasks', 'saga.create');
      expect(q).toBeUndefined();
    });

    it('requires title param', () => {
      const result = resolve('mutate', 'tasks', 'saga.create');
      expect(result).toBeDefined();
      const missing = validateRequiredParams(result!.def, {});
      expect(missing).toContain('title');
    });

    it('title satisfies required params', () => {
      const result = resolve('mutate', 'tasks', 'saga.create');
      expect(result).toBeDefined();
      const missing = validateRequiredParams(result!.def, { title: 'My Saga' });
      expect(missing).toEqual([]);
    });

    it('param definitions include title, description, acceptance', () => {
      const result = resolve('mutate', 'tasks', 'saga.create');
      expect(result).toBeDefined();
      const names = (result!.def.params ?? []).map((p) => p.name);
      expect(names).toContain('title');
      expect(names).toContain('description');
      expect(names).toContain('acceptance');
    });
  });

  // -------------------------------------------------------------------------
  // saga.add (mutate)
  // -------------------------------------------------------------------------
  describe('tasks.saga.add', () => {
    it('resolves through the dispatch registry', () => {
      const result = resolve('mutate', 'tasks', 'saga.add');
      expect(result, 'tasks.saga.add missing from registry').toBeDefined();
    });

    it('is registered as a mutate (non-idempotent, tier 0)', () => {
      const result = resolve('mutate', 'tasks', 'saga.add');
      expect(result).toBeDefined();
      expect(result!.def.gateway).toBe('mutate');
      expect(result!.def.idempotent).toBe(false);
      expect(result!.def.tier).toBe(0);
    });

    it('does NOT resolve as a query', () => {
      expect(resolve('query', 'tasks', 'saga.add')).toBeUndefined();
    });

    it('requires sagaId and epicId', () => {
      const result = resolve('mutate', 'tasks', 'saga.add');
      expect(result).toBeDefined();
      const missing = validateRequiredParams(result!.def, {});
      expect(missing).toContain('sagaId');
      expect(missing).toContain('epicId');
    });

    it('sagaId + epicId satisfies required params', () => {
      const result = resolve('mutate', 'tasks', 'saga.add');
      expect(result).toBeDefined();
      const missing = validateRequiredParams(result!.def, { sagaId: 'T9999', epicId: 'T8888' });
      expect(missing).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // saga.list (query)
  // -------------------------------------------------------------------------
  describe('tasks.saga.list', () => {
    it('resolves through the dispatch registry', () => {
      const result = resolve('query', 'tasks', 'saga.list');
      expect(result, 'tasks.saga.list missing from registry').toBeDefined();
    });

    it('is registered as a query (idempotent, tier 0)', () => {
      const result = resolve('query', 'tasks', 'saga.list');
      expect(result).toBeDefined();
      expect(result!.def.gateway).toBe('query');
      expect(result!.def.idempotent).toBe(true);
      expect(result!.def.tier).toBe(0);
    });

    it('does NOT resolve as a mutate', () => {
      expect(resolve('mutate', 'tasks', 'saga.list')).toBeUndefined();
    });

    it('has no required params', () => {
      const result = resolve('query', 'tasks', 'saga.list');
      expect(result).toBeDefined();
      const missing = validateRequiredParams(result!.def, {});
      expect(missing).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // saga.members (query)
  // -------------------------------------------------------------------------
  describe('tasks.saga.members', () => {
    it('resolves through the dispatch registry', () => {
      const result = resolve('query', 'tasks', 'saga.members');
      expect(result, 'tasks.saga.members missing from registry').toBeDefined();
    });

    it('is registered as a query (idempotent, tier 0)', () => {
      const result = resolve('query', 'tasks', 'saga.members');
      expect(result).toBeDefined();
      expect(result!.def.gateway).toBe('query');
      expect(result!.def.idempotent).toBe(true);
    });

    it('does NOT resolve as a mutate', () => {
      expect(resolve('mutate', 'tasks', 'saga.members')).toBeUndefined();
    });

    it('requires sagaId', () => {
      const result = resolve('query', 'tasks', 'saga.members');
      expect(result).toBeDefined();
      const missing = validateRequiredParams(result!.def, {});
      expect(missing).toContain('sagaId');
    });

    it('sagaId satisfies required params', () => {
      const result = resolve('query', 'tasks', 'saga.members');
      expect(result).toBeDefined();
      const missing = validateRequiredParams(result!.def, { sagaId: 'T9999' });
      expect(missing).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // saga.rollup (query)
  // -------------------------------------------------------------------------
  describe('tasks.saga.rollup', () => {
    it('resolves through the dispatch registry', () => {
      const result = resolve('query', 'tasks', 'saga.rollup');
      expect(result, 'tasks.saga.rollup missing from registry').toBeDefined();
    });

    it('is registered as a query (idempotent, tier 0)', () => {
      const result = resolve('query', 'tasks', 'saga.rollup');
      expect(result).toBeDefined();
      expect(result!.def.gateway).toBe('query');
      expect(result!.def.idempotent).toBe(true);
    });

    it('does NOT resolve as a mutate', () => {
      expect(resolve('mutate', 'tasks', 'saga.rollup')).toBeUndefined();
    });

    it('requires sagaId', () => {
      const result = resolve('query', 'tasks', 'saga.rollup');
      expect(result).toBeDefined();
      const missing = validateRequiredParams(result!.def, {});
      expect(missing).toContain('sagaId');
    });

    it('sagaId satisfies required params', () => {
      const result = resolve('query', 'tasks', 'saga.rollup');
      expect(result).toBeDefined();
      const missing = validateRequiredParams(result!.def, { sagaId: 'T9999' });
      expect(missing).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Cross-op consistency checks
  // -------------------------------------------------------------------------
  describe('cross-operation consistency', () => {
    it('all 5 saga ops live in the tasks domain', () => {
      const ops = [
        resolve('mutate', 'tasks', 'saga.create'),
        resolve('mutate', 'tasks', 'saga.add'),
        resolve('query', 'tasks', 'saga.list'),
        resolve('query', 'tasks', 'saga.members'),
        resolve('query', 'tasks', 'saga.rollup'),
      ];
      for (const op of ops) {
        expect(op).toBeDefined();
        expect(op!.def.domain).toBe('tasks');
      }
    });

    it('mutate ops are non-idempotent, query ops are idempotent', () => {
      const create = resolve('mutate', 'tasks', 'saga.create');
      const add = resolve('mutate', 'tasks', 'saga.add');
      const list = resolve('query', 'tasks', 'saga.list');
      const members = resolve('query', 'tasks', 'saga.members');
      const rollup = resolve('query', 'tasks', 'saga.rollup');
      expect(create!.def.idempotent).toBe(false);
      expect(add!.def.idempotent).toBe(false);
      expect(list!.def.idempotent).toBe(true);
      expect(members!.def.idempotent).toBe(true);
      expect(rollup!.def.idempotent).toBe(true);
    });

    it('all 5 saga ops have tier 0 (basic exposure)', () => {
      const ops = [
        resolve('mutate', 'tasks', 'saga.create'),
        resolve('mutate', 'tasks', 'saga.add'),
        resolve('query', 'tasks', 'saga.list'),
        resolve('query', 'tasks', 'saga.members'),
        resolve('query', 'tasks', 'saga.rollup'),
      ];
      for (const op of ops) {
        expect(op!.def.tier).toBe(0);
      }
    });
  });
});
