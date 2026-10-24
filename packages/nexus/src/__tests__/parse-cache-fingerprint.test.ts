/**
 * Parser limits that decide whether a file extracts are part of the parse-cache
 * identity (T14016).
 *
 * @task T14016
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_SOURCE_BYTES, DEFAULT_PARSE_TIMEOUT_MS } from '../code/parser.js';
import { parseCacheFingerprint } from '../pipeline/parse-cache.js';

describe('parseCacheFingerprint (T14016)', () => {
  it('keeps the build fingerprint under the default limits, stated or not', () => {
    expect(parseCacheFingerprint('build')).toBe('build');
    expect(
      parseCacheFingerprint('build', {
        maxSourceBytes: DEFAULT_MAX_SOURCE_BYTES,
        timeoutMs: DEFAULT_PARSE_TIMEOUT_MS,
      }),
    ).toBe('build');
  });

  it('differs per source-size bound and parse deadline, and is stable for each', () => {
    const small = parseCacheFingerprint('build', { maxSourceBytes: 4096 });
    const slow = parseCacheFingerprint('build', { timeoutMs: 5000 });
    expect(new Set([small, slow, 'build']).size).toBe(3);
    expect(parseCacheFingerprint('build', { maxSourceBytes: 4096 })).toBe(small);
    expect(parseCacheFingerprint('other', { maxSourceBytes: 4096 })).not.toBe(small);
  });

  it('has no identity without a build fingerprint', () => {
    expect(parseCacheFingerprint(null, { maxSourceBytes: 4096 })).toBeNull();
  });
});
