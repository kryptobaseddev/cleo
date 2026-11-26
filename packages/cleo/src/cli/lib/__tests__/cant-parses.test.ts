/**
 * Tests for {@link cantParses}: the parser is imported inside the check, so a
 * missing `@cleocode/cant` surfaces as a thrown check (the doctor's D-012
 * finding) rather than aborting the command before the doctor runs (T14655).
 *
 * @task T14655
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('@cleocode/cant');
  vi.resetModules();
});

describe('cantParses', () => {
  it('reports the parser result', async () => {
    vi.doMock('@cleocode/cant', () => ({
      parseDocument: async (path: string) => ({ success: path.endsWith('good.cant') }),
    }));
    const { cantParses } = await import('../cant-parses.js');
    expect(await cantParses('/x/good.cant')).toBe(true);
    expect(await cantParses('/x/bad.cant')).toBe(false);
  });

  it('loads the module without the parser and throws only when the check runs', async () => {
    vi.doMock('@cleocode/cant', () => {
      throw new Error('native addon missing');
    });
    // Importing the helper succeeds; only running the check fails.
    const { cantParses } = await import('../cant-parses.js');
    await expect(cantParses('/x/a.cant')).rejects.toThrow();
  });
});
