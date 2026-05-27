import { describe, expect, it } from 'vitest';
import { SecurityError, sanitizeParams } from './input-sanitization.js';

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
