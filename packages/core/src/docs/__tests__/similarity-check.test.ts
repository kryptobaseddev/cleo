/**
 * Unit tests for {@link checkSlugSimilarity} and {@link parseSimilarityConfig}.
 *
 * The DB path is exercised by passing `existingSlugs` directly so the test
 * suite does not need to bootstrap an AttachmentStore. End-to-end coverage
 * against the live store lives in
 * `packages/cleo/src/cli/commands/__tests__/docs-add-similarity.test.ts`.
 *
 * @task T10361 (T-E3.3)
 * @epic T10291 (E3-DOCS-CLI-HARDENING)
 * @saga T10288 (SG-DOCS-INTEGRITY)
 * @closes T10167
 */

import { describe, expect, it } from 'vitest';
import {
  checkSlugSimilarity,
  DEFAULT_SIMILARITY_MODE,
  DEFAULT_SIMILARITY_THRESHOLD,
  parseSimilarityConfig,
} from '../similarity-check.js';

describe('checkSlugSimilarity', () => {
  const projectRoot = '/tmp/never-touched';

  it('returns mostSimilarSlug when score crosses the default threshold', async () => {
    // Levenshtein('cantspec', 'cant-spec') = 1; longest = 9; score = 8/9 ≈ 0.888
    const r = await checkSlugSimilarity({
      slug: 'cant-spec',
      type: 'spec',
      projectRoot,
      existingSlugs: ['cantspec', 'release-plan-v1'],
    });
    expect(r.belowThreshold).toBe(false);
    expect(r.mostSimilarSlug).toBe('cantspec');
    expect(r.score).toBeGreaterThan(DEFAULT_SIMILARITY_THRESHOLD);
    expect(r.score).toBeLessThan(1);
  });

  it('returns null mostSimilarSlug when no candidate crosses the threshold', async () => {
    const r = await checkSlugSimilarity({
      slug: 'completely-different-name',
      type: 'spec',
      projectRoot,
      existingSlugs: ['short', 'tiny', 'release-plan-v1'],
    });
    expect(r.belowThreshold).toBe(true);
    expect(r.mostSimilarSlug).toBeNull();
    expect(r.score).toBe(0);
  });

  it('ignores exact matches (score 1.0) — collision path handles those', async () => {
    const r = await checkSlugSimilarity({
      slug: 'cant-spec',
      type: 'spec',
      projectRoot,
      existingSlugs: ['cant-spec', 'release-plan-v1'],
    });
    // Exact match is dropped; no other candidate is similar enough.
    expect(r.belowThreshold).toBe(true);
    expect(r.mostSimilarSlug).toBeNull();
  });

  it('honours a custom threshold from the caller', async () => {
    // Score for ('foo-bar', 'foo-baz') = 1 - 1/7 ≈ 0.857
    // Below 0.95 threshold → null. Above 0.80 threshold → match.
    const high = await checkSlugSimilarity({
      slug: 'foo-bar',
      type: 'note',
      projectRoot,
      existingSlugs: ['foo-baz'],
      threshold: 0.95,
    });
    expect(high.mostSimilarSlug).toBeNull();
    expect(high.belowThreshold).toBe(true);

    const low = await checkSlugSimilarity({
      slug: 'foo-bar',
      type: 'note',
      projectRoot,
      existingSlugs: ['foo-baz'],
      threshold: 0.8,
    });
    expect(low.mostSimilarSlug).toBe('foo-baz');
    expect(low.belowThreshold).toBe(false);
  });

  it('returns the closest match when multiple candidates cross the threshold', async () => {
    // Three candidates near 'release-plan':
    //   'release-plans' (one extra char) → score 12/13 ≈ 0.923
    //   'release-plan2' (one substitution) → score 12/13 ≈ 0.923 ← tie
    //   'release-pla'   (one deletion)    → score 11/12 ≈ 0.916
    // The first-found best is returned; the function picks the highest
    // and ties go to whichever was scanned first.
    const r = await checkSlugSimilarity({
      slug: 'release-plan',
      type: 'plan',
      projectRoot,
      existingSlugs: ['release-pla', 'release-plans', 'release-plan2'],
    });
    expect(r.mostSimilarSlug).not.toBeNull();
    // The chosen slug must be the highest-scoring one.
    expect(['release-plans', 'release-plan2']).toContain(r.mostSimilarSlug);
    expect(r.score).toBeGreaterThan(0.9);
  });

  it('returns null on empty existingSlugs', async () => {
    const r = await checkSlugSimilarity({
      slug: 'whatever',
      type: 'note',
      projectRoot,
      existingSlugs: [],
    });
    expect(r.belowThreshold).toBe(true);
    expect(r.mostSimilarSlug).toBeNull();
  });
});

describe('parseSimilarityConfig', () => {
  const source = '.cleo/canon.yml';

  it('returns defaults when raw is undefined or null', () => {
    expect(parseSimilarityConfig(undefined, source)).toEqual({
      warnThreshold: DEFAULT_SIMILARITY_THRESHOLD,
      mode: DEFAULT_SIMILARITY_MODE,
    });
    expect(parseSimilarityConfig(null, source)).toEqual({
      warnThreshold: DEFAULT_SIMILARITY_THRESHOLD,
      mode: DEFAULT_SIMILARITY_MODE,
    });
  });

  it('honours warnThreshold when valid', () => {
    expect(parseSimilarityConfig({ warnThreshold: 0.9 }, source)).toEqual({
      warnThreshold: 0.9,
      mode: DEFAULT_SIMILARITY_MODE,
    });
  });

  it('honours mode=block', () => {
    expect(parseSimilarityConfig({ mode: 'block' }, source)).toEqual({
      warnThreshold: DEFAULT_SIMILARITY_THRESHOLD,
      mode: 'block',
    });
  });

  it('rejects non-object input', () => {
    expect(() => parseSimilarityConfig('not-an-object', source)).toThrow(/must be an object/);
    expect(() => parseSimilarityConfig([0.85, 'warn'], source)).toThrow(/must be an object/);
  });

  it('rejects out-of-range warnThreshold', () => {
    expect(() => parseSimilarityConfig({ warnThreshold: 1.5 }, source)).toThrow(
      /must be a number in \[0, 1\]/,
    );
    expect(() => parseSimilarityConfig({ warnThreshold: -0.1 }, source)).toThrow(
      /must be a number in \[0, 1\]/,
    );
    expect(() => parseSimilarityConfig({ warnThreshold: 'high' }, source)).toThrow(
      /must be a number in \[0, 1\]/,
    );
  });

  it('rejects unknown mode values', () => {
    expect(() => parseSimilarityConfig({ mode: 'silent' }, source)).toThrow(
      /must be 'warn' or 'block'/,
    );
  });
});
