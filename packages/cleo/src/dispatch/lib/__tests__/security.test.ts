import { describe, expect, it } from 'vitest';
import { ensureArray, SecurityError, sanitizeParams, sanitizeTaskId } from '../security.js';

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

  // T9854 regression: object arrays must NOT be String()-coerced to "[object Object]"
  it('passes through an array of objects unmodified (T9854)', () => {
    const tasks = [
      { title: 'Task A', acceptance: ['a'] },
      { title: 'Task B', parent: 'T100', acceptance: ['b'] },
    ];
    const result = ensureArray(tasks);
    expect(result).toHaveLength(2);
    expect(result?.[0]).toStrictEqual({ title: 'Task A', acceptance: ['a'] });
    expect(result?.[1]).toStrictEqual({ title: 'Task B', parent: 'T100', acceptance: ['b'] });
  });

  it('does NOT produce "[object Object]" strings for object array items (T9854)', () => {
    const result = ensureArray([{ title: 'Smoke' }, { title: 'Test' }]);
    // Items must be objects, not the string literal "[object Object]" (the original bug)
    expect(result?.every((item) => typeof item !== 'string')).toBe(true);
    // Verify items are NOT stored as the string "[object Object]" — the pre-fix behaviour
    expect(result?.some((item) => item === '[object Object]')).toBe(false);
  });

  it('passes through a mixed array of objects and strings unmodified (T9854)', () => {
    const mixed = [{ title: 'Task' }, 'raw-string-label'];
    const result = ensureArray(mixed);
    expect(result?.[0]).toStrictEqual({ title: 'Task' });
    expect(result?.[1]).toBe('raw-string-label');
  });

  it('trims strings within an array but does not touch non-string items (T9854)', () => {
    const result = ensureArray(['  label-a  ', { key: 'val' }, '  label-b  ']);
    expect(result?.[0]).toBe('label-a');
    expect(result?.[1]).toStrictEqual({ key: 'val' });
    expect(result?.[2]).toBe('label-b');
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

  // T9854 regression: `tasks` param with array of objects must survive sanitizer intact
  it('preserves tasks array-of-objects through sanitizeParams (T9854)', () => {
    const taskSpecs = [
      { title: 'Smoke A', acceptance: ['x'] },
      { title: 'Smoke B', parent: 'T100', acceptance: ['y'] },
    ];
    const result = sanitizeParams({ tasks: taskSpecs });
    const sanitizedTasks = result?.['tasks'];
    expect(Array.isArray(sanitizedTasks)).toBe(true);
    const arr = sanitizedTasks as unknown[];
    expect(arr).toHaveLength(2);
    expect(arr[0]).toStrictEqual({ title: 'Smoke A', acceptance: ['x'] });
    expect(arr[1]).toStrictEqual({ title: 'Smoke B', parent: 'T100', acceptance: ['y'] });
  });

  it('does NOT convert task objects to "[object Object]" strings (T9854)', () => {
    const result = sanitizeParams({
      tasks: [
        { title: 'Task A', acceptance: ['a'] },
        { title: 'Task B', acceptance: ['b'] },
      ],
    });
    const arr = result?.['tasks'] as unknown[];
    expect(arr.every((item) => item !== '[object Object]')).toBe(true);
    expect(arr.every((item) => typeof item === 'object' && item !== null)).toBe(true);
  });

  it('still normalizes string-array params like labels (T9854 non-regression)', () => {
    const result = sanitizeParams({ labels: 'bug,feature,p1' });
    expect(result?.['labels']).toEqual(['bug', 'feature', 'p1']);
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
