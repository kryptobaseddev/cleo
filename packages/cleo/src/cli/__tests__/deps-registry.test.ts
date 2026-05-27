/**
 * Integration test: tasks.deps.validate and tasks.deps.tree registry wiring
 *
 * Regression guard for T1923 / T1857 gap: handler existed in tasks.ts QUERY_OPS
 * but registry.ts had no entry → dispatcher returned E_INVALID_OPERATION at runtime.
 *
 * These tests exercise the FULL dispatch pipeline (resolve → handler route) to
 * catch the exact class of failure: a handler wired in domains/tasks.ts but
 * absent from registry.ts. Unit-testing the handler alone would NOT catch this.
 *
 * @task T1923
 * @epic T1855
 */

import { describe, expect, it } from 'vitest';
import { resolve, validateRequiredParams } from '../../dispatch/registry.js';

describe('T1923 regression: tasks.deps.validate and tasks.deps.tree in registry', () => {
  describe('tasks.deps.validate', () => {
    it('resolves through the dispatch registry (not E_INVALID_OPERATION)', () => {
      const result = resolve('query', 'tasks', 'deps.validate');

      // If this is undefined the dispatcher would have returned E_INVALID_OPERATION
      expect(result).toBeDefined();
      expect(result!.domain).toBe('tasks');
      expect(result!.operation).toBe('deps.validate');
    });

    it('is registered as a query (idempotent, tier 1)', () => {
      const result = resolve('query', 'tasks', 'deps.validate');
      expect(result).toBeDefined();
      expect(result!.def.gateway).toBe('query');
      expect(result!.def.idempotent).toBe(true);
      expect(result!.def.tier).toBe(1);
      expect(result!.def.sessionRequired).toBe(false);
    });

    it('does NOT resolve as a mutate — wrong gateway returns undefined', () => {
      const mutate = resolve('mutate', 'tasks', 'deps.validate');
      expect(mutate).toBeUndefined();
    });

    it('has no required params (epicId is optional)', () => {
      const result = resolve('query', 'tasks', 'deps.validate');
      expect(result).toBeDefined();
      const missing = validateRequiredParams(result!.def, {});
      expect(missing).toEqual([]);
    });

    it('param definitions include epicId and scope', () => {
      const result = resolve('query', 'tasks', 'deps.validate');
      expect(result).toBeDefined();
      const params = result!.def.params ?? [];
      const names = params.map((p) => p.name);
      expect(names).toContain('epicId');
      expect(names).toContain('scope');
    });

    it('epicId param is not required', () => {
      const result = resolve('query', 'tasks', 'deps.validate');
      expect(result).toBeDefined();
      const epicIdParam = (result!.def.params ?? []).find((p) => p.name === 'epicId');
      expect(epicIdParam).toBeDefined();
      expect(epicIdParam!.required).toBe(false);
    });
  });

  describe('tasks.deps.tree', () => {
    it('resolves through the dispatch registry (not E_INVALID_OPERATION)', () => {
      const result = resolve('query', 'tasks', 'deps.tree');

      // If this is undefined the dispatcher would have returned E_INVALID_OPERATION
      expect(result).toBeDefined();
      expect(result!.domain).toBe('tasks');
      expect(result!.operation).toBe('deps.tree');
    });

    it('is registered as a query (idempotent, tier 1)', () => {
      const result = resolve('query', 'tasks', 'deps.tree');
      expect(result).toBeDefined();
      expect(result!.def.gateway).toBe('query');
      expect(result!.def.idempotent).toBe(true);
      expect(result!.def.tier).toBe(1);
      expect(result!.def.sessionRequired).toBe(false);
    });

    it('does NOT resolve as a mutate — wrong gateway returns undefined', () => {
      const mutate = resolve('mutate', 'tasks', 'deps.tree');
      expect(mutate).toBeUndefined();
    });

    it('epicId is a required param', () => {
      const result = resolve('query', 'tasks', 'deps.tree');
      expect(result).toBeDefined();
      expect(result!.def.requiredParams).toContain('epicId');

      // Passing no params should report epicId as missing
      const missing = validateRequiredParams(result!.def, {});
      expect(missing).toContain('epicId');
    });

    it('epicId param is marked required in param definitions', () => {
      const result = resolve('query', 'tasks', 'deps.tree');
      expect(result).toBeDefined();
      const epicIdParam = (result!.def.params ?? []).find((p) => p.name === 'epicId');
      expect(epicIdParam).toBeDefined();
      expect(epicIdParam!.required).toBe(true);
    });

    it('supplying epicId satisfies required params', () => {
      const result = resolve('query', 'tasks', 'deps.tree');
      expect(result).toBeDefined();
      const missing = validateRequiredParams(result!.def, { epicId: 'T1042' });
      expect(missing).toEqual([]);
    });

    it('param definitions include epicId and format', () => {
      const result = resolve('query', 'tasks', 'deps.tree');
      expect(result).toBeDefined();
      const params = result!.def.params ?? [];
      const names = params.map((p) => p.name);
      expect(names).toContain('epicId');
      expect(names).toContain('format');
    });
  });

  describe('cross-operation consistency checks', () => {
    it('both ops share the same domain (tasks) and gateway (query)', () => {
      const validate = resolve('query', 'tasks', 'deps.validate');
      const tree = resolve('query', 'tasks', 'deps.tree');
      expect(validate?.def.domain).toBe(tree?.def.domain);
      expect(validate?.def.gateway).toBe(tree?.def.gateway);
    });

    it('neither tasks.deps.validate nor tasks.deps.tree existed before T1923 — explicit before/after check', () => {
      // This is the regression assertion: if either returns undefined, the bug is back.
      const validate = resolve('query', 'tasks', 'deps.validate');
      const tree = resolve('query', 'tasks', 'deps.tree');

      expect(
        validate,
        'tasks.deps.validate missing from registry — dispatcher returns E_INVALID_OPERATION (T1923 regression)',
      ).toBeDefined();

      expect(
        tree,
        'tasks.deps.tree missing from registry — dispatcher returns E_INVALID_OPERATION (T1923 regression)',
      ).toBeDefined();
    });
  });
});
