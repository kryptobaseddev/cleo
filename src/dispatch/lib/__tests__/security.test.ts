import { describe, it, expect } from 'vitest';
import { sanitizeParams, SecurityError, ensureArray } from '../security.js';

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
