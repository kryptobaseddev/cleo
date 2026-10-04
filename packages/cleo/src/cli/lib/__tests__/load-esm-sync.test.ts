/**
 * loadEsmSync returns the module instance a static import gives (T13126).
 */

import { describe, expect, it } from 'vitest';
import { loadEsmSync } from '../load-esm-sync.js';

describe('loadEsmSync', () => {
  it('loads an ES module synchronously, as the instance `import` gives', async () => {
    const loaded = loadEsmSync<typeof import('citty')>('citty');
    expect(loaded.defineCommand).toBe((await import('citty')).defineCommand);
  });

  it('returns the cached module on later calls', () => {
    expect(loadEsmSync<typeof import('citty')>('citty')).toBe(
      loadEsmSync<typeof import('citty')>('citty'),
    );
  });

  it('throws for a specifier that does not resolve', () => {
    expect(() => loadEsmSync('@cleocode/no-such-package-t13126')).toThrow();
  });
});
