/**
 * Unit tests for canonicalProjectId and helpers (T9149 W5).
 *
 * @task T9149
 */

import { describe, expect, it } from 'vitest';
import { computeLegacyAliases, legacyProjectId } from '../identity.js';

describe('identity (T9149 W5)', () => {
  describe('legacyProjectId', () => {
    it('computes base64url(path).slice(0, 32)', () => {
      const p = '/mnt/projects/cleocode';
      const id = legacyProjectId(p);
      expect(id).toBe(Buffer.from(p).toString('base64url').slice(0, 32));
      expect(id.length).toBeLessThanOrEqual(32);
    });

    it('produces different IDs for different paths', () => {
      const id1 = legacyProjectId('/mnt/projects/cleocode');
      const id2 = legacyProjectId('/workspace/cleocode');
      expect(id1).not.toBe(id2);
    });
  });

  describe('computeLegacyAliases', () => {
    it('returns legacy ID for the given path', () => {
      const aliases = computeLegacyAliases('/mnt/projects/cleocode');
      expect(aliases).toContain(legacyProjectId('/mnt/projects/cleocode'));
    });

    it('includes additional path aliases', () => {
      const aliases = computeLegacyAliases('/mnt/projects/cleocode', ['/workspace/cleocode']);
      expect(aliases).toContain(legacyProjectId('/mnt/projects/cleocode'));
      expect(aliases).toContain(legacyProjectId('/workspace/cleocode'));
    });

    it('deduplicates identical paths', () => {
      const aliases = computeLegacyAliases('/mnt/projects/cleocode', ['/mnt/projects/cleocode']);
      const dupes = aliases.filter((a) => a === legacyProjectId('/mnt/projects/cleocode'));
      expect(dupes).toHaveLength(1);
    });
  });
});
