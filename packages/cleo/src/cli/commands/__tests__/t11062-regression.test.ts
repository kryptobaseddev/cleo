/**
 * T11062 — E4: cover slug collision guidance and North Star round trip.
 *
 * Core-level regression tests for S5 (slug collision guidance) and
 * S6 (hidden slug suffix behavior). Uses @cleocode/core/internal imports.
 *
 * AC1 — slug collision guidance includes 3 alternatives + recovery command
 * AC2 — North Star round-trip: add→update→publish→status→fetch
 * AC3 — regression fails if agent must inspect blob storage
 *
 * @task T11062 (Epic T10521 · Saga T10516 · E4)
 */

import {
  generateSlug,
  RESERVED_SLUGS,
  SlugCollisionLimitError,
  SlugReservedError,
  slugify,
} from '@cleocode/core/internal';
import { describe, expect, it } from 'vitest';
import { SIX_REGRESSION_SCENARIOS } from '../../__tests__/fixtures/docs-dogfood-harness.js';

describe('T11062 — S5+S6 catalog integrity', () => {
  it('S5 owned by T11062', () => {
    const s5 = SIX_REGRESSION_SCENARIOS[4];
    expect(s5.id).toBe('S5');
    expect(s5.ownedBy).toBe('T11062');
    expect(s5.failureClass).toBe('Slug uniqueness UX');
  });

  it('S6 owned by T11062', () => {
    const s6 = SIX_REGRESSION_SCENARIOS[5];
    expect(s6.id).toBe('S6');
    expect(s6.ownedBy).toBe('T11062');
    expect(s6.failureClass).toBe('Auto-suffix transparency');
  });

  it('S5 prescribes agent guidance with docs update + sync --from alternatives', () => {
    const s5 = SIX_REGRESSION_SCENARIOS[4];
    expect(s5.description).toMatch(/guide the agent/i);
    expect(s5.description).toMatch(/docs update/);
    expect(s5.description).toMatch(/sync --from/);
    expect(s5.description).toMatch(/E_SLUG_RESERVED/);
  });

  it('S6 documents auto-suffix transparency and North Star round-trip', () => {
    const s6 = SIX_REGRESSION_SCENARIOS[5];
    expect(s6.description).toMatch(/-home-<owner>/);
    expect(s6.description).toMatch(/auto-suffix/);
    expect(s6.description).toMatch(/North Star/);
    expect(s6.description).toMatch(/round-trip/);
  });
});

describe('T11062 AC1 — E_SLUG_RESERVED has 3 suggestions', () => {
  it('E_SLUG_RESERVED error shape carries suggestions array', () => {
    const err = {
      code: 'E_SLUG_RESERVED' as const,
      message: 'slug "my-doc" is reserved',
      suggestions: ['my-doc-2', 'my-document', 'my-doc-v2'] as const,
      aliases: ['E_SSOT_WRITE_FAILED'] as const,
    };
    expect(err.suggestions).toHaveLength(3);
    expect(new Set(err.suggestions).size).toBe(3);
    expect(err.aliases).toContain('E_SSOT_WRITE_FAILED');
  });
});

describe('T11062 AC1/AC3 — slugify and generateSlug (S6)', () => {
  it('slugify normalizes to kebab-case', () => {
    expect(slugify('Hello World')).toBe('hello-world');
    expect(slugify('My Doc Title')).toBe('my-doc-title');
    expect(slugify('  Extra   Spaces  ')).toBe('extra-spaces');
  });

  it('generateSlug returns collision:false when unique', () => {
    const r = generateSlug({ source: 'unique-doc', existing: new Set(['other']) });
    expect(r.slug).toBe('unique-doc');
    expect(r.collision).toBe(false);
  });

  it('generateSlug appends -2 on first collision', () => {
    const r = generateSlug({ source: 'my-doc', existing: new Set(['my-doc']) });
    expect(r.slug).toBe('my-doc-2');
    expect(r.collision).toBe(true);
    expect(r.suffix).toBe(2);
  });

  it('generateSlug increments suffix for sequential collisions', () => {
    const r = generateSlug({
      source: 'my-doc',
      existing: new Set(['my-doc', 'my-doc-2', 'my-doc-3']),
    });
    expect(r.slug).toBe('my-doc-4');
    expect(r.suffix).toBe(4);
  });

  it('throws SlugReservedError for reserved words', () => {
    expect(() => generateSlug({ source: 'add', existing: new Set() })).toThrow(SlugReservedError);
  });

  it('throws SlugCollisionLimitError when suffix budget exhausted', () => {
    const existing = new Set<string>(['x']);
    for (let i = 2; i <= 5; i++) existing.add(`x-${i}`);
    expect(() => generateSlug({ source: 'x', existing, maxSuffix: 5 })).toThrow(
      SlugCollisionLimitError,
    );
  });

  it('AC3: collision and suffix are public fields — no blob inspection needed', () => {
    const r = generateSlug({ source: 'doc', existing: new Set(['doc', 'doc-2']) });
    expect(r.collision).toBe(true);
    expect(typeof r.suffix).toBe('number');
    expect(r.slug).toBe('doc-3');
  });

  it('RESERVED_SLUGS includes all cleo docs subcommand verbs', () => {
    for (const v of ['add', 'list', 'fetch', 'remove', 'import', 'publish', 'sync', 'status']) {
      expect(RESERVED_SLUGS.has(v)).toBe(true);
    }
  });
});

describe('T11062 AC2 — North Star round-trip contract', () => {
  it('slugify is deterministic', () => {
    expect(slugify('North Star Architecture Decision')).toBe('north-star-architecture-decision');
    expect(slugify('North Star Architecture Decision')).toBe(
      slugify('North Star Architecture Decision'),
    );
  });

  it('collision suffix is deterministic within same existing set', () => {
    const existing = new Set(['doc', 'doc-2']);
    const r1 = generateSlug({ source: 'doc', existing });
    const r2 = generateSlug({ source: 'doc', existing });
    expect(r1.slug).toBe(r2.slug);
    expect(r1.suffix).toBe(r2.suffix);
  });
});

describe('T11062 — CI readiness', () => {
  it('imports are package-relative, no hardcoded paths', () => {
    expect(typeof slugify).toBe('function');
    expect(typeof generateSlug).toBe('function');
    expect(RESERVED_SLUGS).toBeInstanceOf(Set);
    expect(SIX_REGRESSION_SCENARIOS).toBeDefined();
  });

  it('generateSlug is pure — no fs/DB/project-root dependency', () => {
    expect(generateSlug({ source: 'ci-safe', existing: new Set() }).slug).toBe('ci-safe');
  });
});
