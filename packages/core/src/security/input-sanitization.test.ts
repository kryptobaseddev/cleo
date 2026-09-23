import { describe, expect, it } from 'vitest';
import { ALL_VALID_STATUSES, SecurityError, sanitizeParams } from './input-sanitization.js';

describe('sanitizeParams docs.update external file policy (T10616)', () => {
  it('rejects external docs.update file paths unless allowExternal is true', () => {
    expect(() =>
      sanitizeParams({ slug: 'existing-doc', file: '/tmp/cleo-doc-update.md' }, '/repo/project', {
        domain: 'docs',
        operation: 'update',
      }),
    ).toThrow(SecurityError);
  });

  it('allows external docs.update file paths when allowExternal is true', () => {
    const result = sanitizeParams(
      { slug: 'existing-doc', file: '/tmp/cleo-doc-update.md', allowExternal: true },
      '/repo/project',
      { domain: 'docs', operation: 'update' },
    );

    expect(result?.['file']).toBe('/tmp/cleo-doc-update.md');
    expect(result?.['allowExternal']).toBe(true);
  });
});

describe('status enum is a union, not a concatenation (gh#1458)', () => {
  it('names every allowed status exactly once when --status is invalid', () => {
    let message = '';
    try {
      sanitizeParams({ status: 'in_progress' }, undefined, {
        domain: 'tasks',
        operation: 'find',
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    const listed = message.split('Allowed values: ')[1]?.split(', ') ?? [];
    expect(listed.length).toBeGreaterThan(0);
    expect(listed).toEqual([...new Set(listed)]);
  });

  it('exposes a deduplicated allowed-status set', () => {
    expect(ALL_VALID_STATUSES.length).toBe(new Set(ALL_VALID_STATUSES).size);
  });
});
