/**
 * `@cleocode/core/paths` and `@cleocode/core/paths.js` are two exports naming
 * two DIFFERENT modules with different APIs: `paths-export.ts` re-exports the
 * `@cleocode/paths` package, `paths.ts` is core's own resolver (its own
 * `getCleoHome`, `getProjectRoot`, …). They share only a few names, so pointing
 * both at one file would change the published API. Under vitest they are two
 * module ids, as in the published package. These tests prove a `vi.doMock` of
 * either specifier replaces the module every importer of THAT file sees,
 * including core's own relative imports, and does NOT reach an importer of the
 * other spelling: mock the specifier the code under test imports.
 *
 * @task T14525
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('@cleocode/core/paths.js');
  vi.doUnmock('@cleocode/core/paths');
  vi.resetModules();
});

describe('@cleocode/core/paths module identity', () => {
  it('vi.doMock of @cleocode/core/paths.js reaches relative importers of paths.ts', async () => {
    vi.resetModules();
    vi.doMock('@cleocode/core/paths.js', () => ({ getCleoHome: () => '/mocked/paths.js' }));
    const viaSpecifier = await import('@cleocode/core/paths.js');
    const viaRelative = await import('../paths.js');
    expect(viaRelative.getCleoHome()).toBe('/mocked/paths.js');
    expect(viaRelative).toBe(viaSpecifier);
  });

  it('vi.doMock of @cleocode/core/paths reaches relative importers of paths-export.ts', async () => {
    vi.resetModules();
    vi.doMock('@cleocode/core/paths', () => ({ getCleoHome: () => '/mocked/paths' }));
    const viaSpecifier = await import('@cleocode/core/paths');
    const viaRelative = await import('../paths-export.js');
    expect(viaRelative.getCleoHome()).toBe('/mocked/paths');
    expect(viaRelative).toBe(viaSpecifier);
  });

  it('a mock of one spelling does not reach importers of the other (both directions)', async () => {
    vi.resetModules();
    vi.doMock('@cleocode/core/paths.js', () => ({ getCleoHome: () => '/mocked/paths.js' }));
    vi.doMock('@cleocode/core/paths', () => ({ getCleoHome: () => '/mocked/paths' }));
    const dotJs = await import('@cleocode/core/paths.js');
    const bare = await import('@cleocode/core/paths');
    expect(dotJs.getCleoHome()).toBe('/mocked/paths.js');
    expect(bare.getCleoHome()).toBe('/mocked/paths');
    expect(bare).not.toBe(dotJs);
  });
});
