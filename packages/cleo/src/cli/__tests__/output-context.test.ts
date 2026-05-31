/**
 * Unit tests for `--output` mode resolution, including the alias table
 * (T11482 · DHQ-033).
 *
 * `resolveOutputMode` is the SSoT the global flag parser in `cli/index.ts`
 * uses to map a raw `--output <value>` argument to a canonical
 * {@link OutputMode}. The alias table lets natural requests like
 * `--output json` resolve to the canonical `envelope` payload instead of
 * being rejected with exit code 2.
 *
 * @task T11482
 * @epic T11480
 */

import { describe, expect, it } from 'vitest';
import { isOutputMode, OUTPUT_MODES, resolveOutputMode } from '../output-context.js';

describe('resolveOutputMode — canonical modes', () => {
  it('resolves every canonical mode to itself', () => {
    for (const mode of OUTPUT_MODES) {
      expect(resolveOutputMode(mode)).toBe(mode);
    }
  });
});

describe('resolveOutputMode — aliases (T11482 · DHQ-033)', () => {
  it('resolves `json` to the canonical `envelope` payload', () => {
    expect(resolveOutputMode('json')).toBe('envelope');
  });

  it('does not list `json` as a canonical mode (it is an alias only)', () => {
    expect(isOutputMode('json')).toBe(false);
    expect((OUTPUT_MODES as readonly string[]).includes('json')).toBe(false);
  });
});

describe('resolveOutputMode — rejection', () => {
  it('returns undefined for a value that is neither a mode nor an alias', () => {
    expect(resolveOutputMode('bogus')).toBeUndefined();
    expect(resolveOutputMode('')).toBeUndefined();
    expect(resolveOutputMode('JSON')).toBeUndefined(); // case-sensitive
  });
});
