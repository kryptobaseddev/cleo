import { describe, it, expect } from 'vitest';
import { sanitizeParams, sanitizeTaskId, SecurityError, ensureArray } from '../security.js';

describe('sanitizeTaskId normalization', () => {
  it('normalizes bare digits to T-prefixed form', () => {
    expect(sanitizeTaskId('1234')).toBe('T1234');
  });

  it('normalizes lowercase t prefix', () => {
    expect(sanitizeTaskId('t1234')).toBe('T1234');
  });

  it('passes through canonical T-prefixed form', () => {
    expect(sanitizeTaskId('T1234')).toBe('T1234');
  });

  it('throws for task ID exceeding maximum value', () => {
    expect(() => sanitizeTaskId('T1000000')).toThrow(SecurityError);
  });

  it('throws for non-string input', () => {
    expect(() => sanitizeTaskId(123 as unknown as string)).toThrow(SecurityError);
  });

  it('throws for empty string', () => {
    expect(() => sanitizeTaskId('')).toThrow(SecurityError);
  });

  it('throws for invalid format', () => {
    expect(() => sanitizeTaskId('abc')).toThrow(SecurityError);
  });
});

describe('dispatch security sanitizeParams', () => {
  it('accepts lifecycle stage status for pipeline.stage.record', () => {
    const result = sanitizeParams(
      { taskId: 'T4798', stage: 'research', status: 'in_progress' },
      undefined,
      { domain: 'pipeline', operation: 'stage.record' },
    );

    expect(result?.['status']).toBe('in_progress');
  });

  it('rejects lifecycle stage status outside lifecycle stage recording context', () => {
    expect(() => sanitizeParams({ status: 'in_progress' })).toThrow(SecurityError);
  });
});

describe('ensureArray', () => {
  it('returns undefined for undefined', () => {
    expect(ensureArray(undefined)).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(ensureArray(null)).toBeUndefined();
  });

  it('passes through an array of strings', () => {
    expect(ensureArray(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('splits a comma-separated string into an array', () => {
    expect(ensureArray('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('wraps a single string in an array', () => {
    expect(ensureArray('single')).toEqual(['single']);
  });

  it('returns empty array for empty string', () => {
    expect(ensureArray('')).toEqual([]);
  });

  it('converts a number to a string array', () => {
    expect(ensureArray(42)).toEqual(['42']);
  });

  it('trims whitespace from comma-separated values', () => {
    expect(ensureArray(' a , b ')).toEqual(['a', 'b']);
  });

  it('supports a custom separator', () => {
    expect(ensureArray('a|b|c', '|')).toEqual(['a', 'b', 'c']);
  });
});

describe('sanitizeParams array normalization', () => {
  it('normalizes comma-separated labels string to array', () => {
    const result = sanitizeParams({ labels: 'bug,feature' });
    expect(result?.['labels']).toEqual(['bug', 'feature']);
  });

  it('passes through labels already in array form', () => {
    const result = sanitizeParams({ labels: ['bug', 'feature'] });
    expect(result?.['labels']).toEqual(['bug', 'feature']);
  });

  it('leaves non-array params alone', () => {
    const result = sanitizeParams({ title: 'test' });
    expect(result?.['title']).toBe('test');
  });

  it('normalizes comma-separated depends string to array', () => {
    const result = sanitizeParams({ depends: 'T001,T002' });
    expect(result?.['depends']).toEqual(['T001', 'T002']);
  });
});

describe('sanitizeParams ID normalization', () => {
  it('normalizes bare digit taskId', () => {
    const result = sanitizeParams({ taskId: '1234' });
    expect(result?.['taskId']).toBe('T1234');
  });

  it('normalizes parentId', () => {
    const result = sanitizeParams({ parentId: '1234' });
    expect(result?.['parentId']).toBe('T1234');
  });

  it('normalizes newParentId', () => {
    const result = sanitizeParams({ newParentId: 't99' });
    expect(result?.['newParentId']).toBe('T99');
  });

  it('normalizes relatedId', () => {
    const result = sanitizeParams({ relatedId: '500' });
    expect(result?.['relatedId']).toBe('T500');
  });

  it('normalizes targetId', () => {
    const result = sanitizeParams({ targetId: 't42' });
    expect(result?.['targetId']).toBe('T42');
  });

  it('normalizes depends array with mixed formats', () => {
    const result = sanitizeParams({ depends: ['1', 't2', 'T3'] });
    expect(result?.['depends']).toEqual(['T1', 'T2', 'T3']);
  });

  it('normalizes addDepends array', () => {
    const result = sanitizeParams({ addDepends: ['1'] });
    expect(result?.['addDepends']).toEqual(['T1']);
  });

  it('normalizes removeDepends array', () => {
    const result = sanitizeParams({ removeDepends: ['t5', '6'] });
    expect(result?.['removeDepends']).toEqual(['T5', 'T6']);
  });

  it('preserves empty string parent (means remove parent)', () => {
    const result = sanitizeParams({ parent: '' });
    expect(result?.['parent']).toBe('');
  });
});
