/**
 * slug unit tests — T9712 (ST-MIG-1b).
 *
 * Covers:
 *   - slugify basic kebab-case + diacritic stripping + lowercasing
 *   - stripMdExtension behaviour
 *   - generateSlug success path
 *   - collision suffixing (-2, -3, ...)
 *   - reserved slug rejection
 *   - empty input rejection
 *   - collision-limit guard
 *
 * @epic T9628 (Saga T9625)
 * @task T9712
 */

import { describe, expect, it } from 'vitest';
import {
  generateSlug,
  RESERVED_SLUGS,
  SlugCollisionLimitError,
  SlugReservedError,
  slugify,
  stripMdExtension,
} from '../../import/slug.js';

describe('slugify', () => {
  it('lowercases and joins words with hyphens', () => {
    expect(slugify('My Cool Doc')).toBe('my-cool-doc');
  });
  it('collapses non-alphanumeric runs', () => {
    expect(slugify('  Foo // Bar !! Baz  ')).toBe('foo-bar-baz');
  });
  it('strips combining diacritics via NFKD normalisation', () => {
    expect(slugify('Café Résumé')).toBe('cafe-resume');
  });
  it('returns empty string for non-alphanumeric input', () => {
    expect(slugify('!!!')).toBe('');
  });
});

describe('stripMdExtension', () => {
  it('removes a trailing .md', () => {
    expect(stripMdExtension('foo.md')).toBe('foo');
  });
  it('removes case-insensitively', () => {
    expect(stripMdExtension('FOO.MD')).toBe('FOO');
  });
  it('leaves non-.md filenames alone', () => {
    expect(stripMdExtension('foo.txt')).toBe('foo.txt');
  });
});

describe('generateSlug', () => {
  it('returns the base slug when no collision exists', () => {
    const result = generateSlug({ source: 'Hello World', existing: new Set() });
    expect(result.slug).toBe('hello-world');
    expect(result.collision).toBe(false);
    expect(result.suffix).toBeUndefined();
  });

  it('appends -2 on first collision', () => {
    const result = generateSlug({
      source: 'Hello World',
      existing: new Set(['hello-world']),
    });
    expect(result).toEqual({ slug: 'hello-world-2', collision: true, suffix: 2 });
  });

  it('appends -3, -4, ... as collisions accumulate', () => {
    const existing = new Set(['hello-world', 'hello-world-2']);
    const result = generateSlug({ source: 'Hello World', existing });
    expect(result.slug).toBe('hello-world-3');
    expect(result.suffix).toBe(3);
  });

  it('throws SlugReservedError for reserved slugs', () => {
    expect(() => generateSlug({ source: 'index', existing: new Set() })).toThrow(SlugReservedError);
    expect(() => generateSlug({ source: 'Publish', existing: new Set() })).toThrow(
      SlugReservedError,
    );
  });

  it('throws SlugReservedError for empty input after normalisation', () => {
    expect(() => generateSlug({ source: '!!!', existing: new Set() })).toThrow(SlugReservedError);
  });

  it('throws SlugCollisionLimitError when too many collisions accumulate', () => {
    const existing = new Set<string>(['hello']);
    for (let i = 2; i <= 5; i++) existing.add(`hello-${i}`);
    expect(() => generateSlug({ source: 'hello', existing, maxSuffix: 5 })).toThrow(
      SlugCollisionLimitError,
    );
  });

  it('RESERVED_SLUGS covers the docs subcommand verbs', () => {
    for (const verb of [
      'add',
      'list',
      'fetch',
      'remove',
      'import',
      'publish',
      'sync',
      'status',
      'generate',
      'export',
      'search',
      'merge',
      'graph',
      'rank',
      'versions',
    ]) {
      expect(RESERVED_SLUGS.has(verb)).toBe(true);
    }
  });
});
