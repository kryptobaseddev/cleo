import { describe, it, expect } from 'vitest';
import { resolveTier, PROJECTIONS, type MviTier } from '../projections.js';
import { applyProjection } from '../../middleware/projection.js';

describe('resolveTier', () => {
  it('should default to standard when no params', () => {
    expect(resolveTier()).toBe('standard');
    expect(resolveTier(undefined)).toBe('standard');
  });

  it('should default to standard when _mviTier is absent', () => {
    expect(resolveTier({})).toBe('standard');
    expect(resolveTier({ foo: 'bar' })).toBe('standard');
  });

  it('should return minimal when _mviTier is minimal', () => {
    expect(resolveTier({ _mviTier: 'minimal' })).toBe('minimal');
  });

  it('should return standard when _mviTier is standard', () => {
    expect(resolveTier({ _mviTier: 'standard' })).toBe('standard');
  });

  it('should return orchestrator when _mviTier is orchestrator', () => {
    expect(resolveTier({ _mviTier: 'orchestrator' })).toBe('orchestrator');
  });

  it('should default to standard for invalid _mviTier values', () => {
    expect(resolveTier({ _mviTier: 'unknown' })).toBe('standard');
    expect(resolveTier({ _mviTier: 42 })).toBe('standard');
    expect(resolveTier({ _mviTier: null })).toBe('standard');
    expect(resolveTier({ _mviTier: true })).toBe('standard');
  });
});

describe('resolveTier with sessionScope', () => {
  it('should still default to standard with null session scope', () => {
    expect(resolveTier(undefined, null)).toBe('standard');
    expect(resolveTier({}, null)).toBe('standard');
  });

  it('should still default to standard with undefined session scope', () => {
    expect(resolveTier(undefined, undefined)).toBe('standard');
  });

  it('should auto-map epic scope to orchestrator tier', () => {
    expect(resolveTier({}, { type: 'epic', epicId: 'T001' })).toBe('orchestrator');
  });

  it('should default to standard for non-epic scope', () => {
    expect(resolveTier({}, { type: 'task' })).toBe('standard');
  });

  it('explicit _mviTier param wins over session scope', () => {
    expect(resolveTier({ _mviTier: 'minimal' }, { type: 'epic', epicId: 'T001' })).toBe('minimal');
    expect(resolveTier({ _mviTier: 'orchestrator' }, { type: 'task' })).toBe('orchestrator');
  });

  it('explicit _mviTier param wins over null session scope', () => {
    expect(resolveTier({ _mviTier: 'minimal' }, null)).toBe('minimal');
    expect(resolveTier({ _mviTier: 'orchestrator' }, null)).toBe('orchestrator');
  });
});

describe('PROJECTIONS', () => {
  it('should define all three tiers', () => {
    expect(PROJECTIONS).toHaveProperty('minimal');
    expect(PROJECTIONS).toHaveProperty('standard');
    expect(PROJECTIONS).toHaveProperty('orchestrator');
  });

  it('minimal tier should only allow tasks, session, admin', () => {
    expect(PROJECTIONS.minimal.allowedDomains).toEqual(['tasks', 'session', 'admin']);
  });

  it('standard tier should include minimal plus memory, check, pipeline, tools, validate', () => {
    const domains = PROJECTIONS.standard.allowedDomains;
    expect(domains).toContain('tasks');
    expect(domains).toContain('session');
    expect(domains).toContain('admin');
    expect(domains).toContain('memory');
    expect(domains).toContain('check');
    expect(domains).toContain('pipeline');
    expect(domains).toContain('tools');
    expect(domains).toContain('validate');
  });

  it('orchestrator tier should include all domains', () => {
    const domains = PROJECTIONS.orchestrator.allowedDomains;
    expect(domains).toContain('orchestrate');
    expect(domains).toContain('sharing');
    expect(domains).toContain('nexus');
    expect(domains).toContain('lifecycle');
    expect(domains).toContain('release');
    expect(domains).toContain('system');
  });

  it('each higher tier should be a superset of the lower', () => {
    for (const domain of PROJECTIONS.minimal.allowedDomains) {
      expect(PROJECTIONS.standard.allowedDomains).toContain(domain);
    }
    for (const domain of PROJECTIONS.standard.allowedDomains) {
      expect(PROJECTIONS.orchestrator.allowedDomains).toContain(domain);
    }
  });

  it('minimal tier should have the smallest maxDepth', () => {
    expect(PROJECTIONS.minimal.maxDepth).toBeLessThan(PROJECTIONS.standard.maxDepth!);
    expect(PROJECTIONS.standard.maxDepth).toBeLessThan(PROJECTIONS.orchestrator.maxDepth!);
  });

  it('minimal tier should exclude notes, history, metadata._internal, auditLog', () => {
    expect(PROJECTIONS.minimal.excludeFields).toContain('notes');
    expect(PROJECTIONS.minimal.excludeFields).toContain('history');
    expect(PROJECTIONS.minimal.excludeFields).toContain('metadata._internal');
    expect(PROJECTIONS.minimal.excludeFields).toContain('auditLog');
  });

  it('standard tier should exclude metadata._internal and auditLog', () => {
    expect(PROJECTIONS.standard.excludeFields).toContain('metadata._internal');
    expect(PROJECTIONS.standard.excludeFields).toContain('auditLog');
  });

  it('orchestrator tier should have no field exclusions', () => {
    expect(PROJECTIONS.orchestrator.excludeFields).toBeUndefined();
  });
});

describe('applyProjection with maxDepth', () => {
  it('should prune objects beyond maxDepth', () => {
    const data = {
      id: 'T1',
      nested: {
        level2: {
          level3: {
            deep: 'value',
          },
        },
      },
    };
    const result = applyProjection(data, { ...PROJECTIONS.minimal, maxDepth: 2 });
    expect(result.id).toBe('T1');
    expect(result.nested).toEqual({ level2: '[Object]' });
  });

  it('should replace arrays beyond maxDepth with placeholder', () => {
    const data = {
      id: 'T1',
      items: {
        list: [1, 2, 3],
      },
    };
    const result = applyProjection(data, { ...PROJECTIONS.minimal, maxDepth: 2 });
    expect(result.id).toBe('T1');
    expect(result.items).toEqual({ list: '[Array(3)]' });
  });

  it('should not prune at orchestrator tier (maxDepth: 8)', () => {
    const data = {
      level1: {
        level2: {
          level3: {
            level4: {
              level5: 'still here',
            },
          },
        },
      },
    };
    const result = applyProjection(data, { allowedDomains: [], maxDepth: 8 });
    expect((result as any).level1.level2.level3.level4.level5).toBe('still here');
  });

  it('should prune at minimal tier (maxDepth: 2)', () => {
    const data = {
      id: 'T1',
      meta: {
        info: {
          deep: 'pruned',
        },
      },
    };
    const result = applyProjection(data, { allowedDomains: [], maxDepth: 2 });
    expect(result.meta).toEqual({ info: '[Object]' });
  });

  it('should handle primitives at any depth', () => {
    const data = {
      str: 'hello',
      num: 42,
      bool: true,
      nil: null,
    };
    const result = applyProjection(data, { allowedDomains: [], maxDepth: 1 });
    expect(result).toEqual({ str: 'hello', num: 42, bool: true, nil: null });
  });

  it('should apply both field exclusions and depth pruning', () => {
    const data = {
      id: 'T1',
      notes: ['note1'],
      nested: {
        deep: {
          value: 'pruned',
        },
      },
    };
    const result = applyProjection(data, {
      allowedDomains: [],
      excludeFields: ['notes'],
      maxDepth: 2,
    });
    expect(result).not.toHaveProperty('notes');
    expect(result.nested).toEqual({ deep: '[Object]' });
  });

  it('should not prune when maxDepth is undefined', () => {
    const data = {
      a: { b: { c: { d: 'deep' } } },
    };
    const result = applyProjection(data, { allowedDomains: [] });
    expect((result as any).a.b.c.d).toBe('deep');
  });
});

describe('applyProjection', () => {
  it('should return non-object data unchanged', () => {
    expect(applyProjection('hello', PROJECTIONS.minimal)).toBe('hello');
    expect(applyProjection(42, PROJECTIONS.minimal)).toBe(42);
    expect(applyProjection(null, PROJECTIONS.minimal)).toBe(null);
    expect(applyProjection(undefined, PROJECTIONS.minimal)).toBe(undefined);
  });

  it('should return data unchanged when no excludeFields', () => {
    const data = { id: 'T1', notes: ['note1'], metadata: { _internal: 'x' } };
    const result = applyProjection(data, PROJECTIONS.orchestrator);
    expect(result).toEqual(data);
  });

  it('should remove top-level excluded fields', () => {
    const data = { id: 'T1', title: 'Test', notes: ['note1'], history: [{ action: 'created' }], auditLog: [] };
    const result = applyProjection(data, PROJECTIONS.minimal);
    expect(result).toEqual({ id: 'T1', title: 'Test' });
  });

  it('should remove nested excluded fields', () => {
    const data = {
      id: 'T1',
      metadata: { _internal: 'secret', visible: 'ok' },
    };
    const result = applyProjection(data, PROJECTIONS.minimal);
    expect(result.id).toBe('T1');
    expect(result.metadata).toEqual({ visible: 'ok' });
  });

  it('should not mutate original data', () => {
    const data = { id: 'T1', notes: ['n1'], metadata: { _internal: 'x', visible: 'y' } };
    const copy = JSON.parse(JSON.stringify(data));
    applyProjection(data, PROJECTIONS.minimal);
    expect(data).toEqual(copy);
  });

  it('should handle missing nested paths gracefully', () => {
    const data = { id: 'T1', title: 'No metadata' };
    const result = applyProjection(data, PROJECTIONS.standard);
    expect(result).toEqual({ id: 'T1', title: 'No metadata' });
  });
});
