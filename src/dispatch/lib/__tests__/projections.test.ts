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
