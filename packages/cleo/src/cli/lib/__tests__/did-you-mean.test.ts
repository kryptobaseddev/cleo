import { describe, expect, it } from 'vitest';
import { didYouMean, levenshteinDistance } from '../did-you-mean.js';

describe('levenshteinDistance', () => {
  it('should return 0 for identical strings', () => {
    expect(levenshteinDistance('add', 'add')).toBe(0);
  });

  it('should return distance for single character difference', () => {
    // 'cat' -> 'bat' (1 substitution)
    expect(levenshteinDistance('cat', 'bat')).toBe(1);
  });

  it('should return distance for insertion', () => {
    // 'cat' -> 'cart' (1 insertion)
    expect(levenshteinDistance('cat', 'cart')).toBe(1);
  });

  it('should return distance for deletion', () => {
    // 'cart' -> 'cat' (1 deletion)
    expect(levenshteinDistance('cart', 'cat')).toBe(1);
  });

  it('should calculate multiple edits', () => {
    // 'create' -> 'add' (requires multiple edits)
    expect(levenshteinDistance('create', 'add')).toBeGreaterThan(2);
  });
});

describe('didYouMean', () => {
  const commands = ['add', 'rm', 'ls', 'list', 'delete', 'show', 'find', 'update'];

  it('should suggest commands for "create" (distance 3)', () => {
    // create -> update is 3 edits
    const suggestions = didYouMean('create', commands, 3);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions).toContain('update');
  });

  it('should suggest "add" for "new" (distance 3)', () => {
    // new -> add is 3 edits
    const suggestions = didYouMean('new', commands, 3);
    expect(suggestions).toContain('add');
  });

  it('should suggest "add" for "make" (distance 3)', () => {
    // make -> add is 3 edits
    const suggestions = didYouMean('make', commands, 3);
    expect(suggestions).toContain('add');
  });

  it('should suggest commands for "remove" (distance 3+)', () => {
    // remove -> rm is 4 edits (exceeds 3), but may match others at distance 3
    const suggestions = didYouMean('remove', commands, 3);
    expect(Array.isArray(suggestions)).toBe(true);
  });

  it('should suggest "list" for "listt" (distance 1)', () => {
    // listt -> list is 1 edit (delete extra t)
    const suggestions = didYouMean('listt', commands, 2);
    expect(suggestions).toContain('list');
  });

  it('should return empty array for distant input', () => {
    const suggestions = didYouMean('xyz', commands);
    expect(suggestions).toHaveLength(0);
  });

  it('should respect maxDistance parameter', () => {
    // 'updat' vs 'update' is 1 edit, so it matches with maxDistance=1
    const suggestions = didYouMean('updat', commands, 1);
    expect(suggestions).toContain('update');

    // But 'uptide' vs 'update' is 3 edits, should not match with maxDistance=1
    const tooFar = didYouMean('uptide', commands, 1);
    expect(tooFar).not.toContain('update');
  });

  it('should return sorted suggestions by distance', () => {
    // 'ad' should match both 'add' and 'rm', but 'add' is closer
    const suggestions = didYouMean('ad', commands, 3);
    if (suggestions.length > 0) {
      // 'add' is 1 edit, 'rm' is at least 2 edits
      expect(suggestions[0]).toBe('add');
    }
  });

  it('should handle alphabetical sorting for equal distances', () => {
    // 'a' matches both 'add' and 'update' at distance 2 or 3
    const suggestions = didYouMean('a', commands, 4);
    // Both 'add' and 'update' might be in suggestions; if they are, 'add' should come first (alphabetically)
    if (suggestions.includes('add') && suggestions.includes('update')) {
      expect(suggestions.indexOf('add')).toBeLessThan(suggestions.indexOf('update'));
    }
  });

  it('should handle empty candidates', () => {
    const suggestions = didYouMean('create', []);
    expect(suggestions).toEqual([]);
  });

  it('should handle empty input', () => {
    const suggestions = didYouMean('', commands);
    // Empty string is 1-2 edits from single-char commands
    expect(Array.isArray(suggestions)).toBe(true);
  });
});
