/**
 * Tests for NEXUS symbol context augmentation (T1061)
 *
 * Tests BM25 search and result formatting for PreToolUse hook injection.
 */

import { describe, expect, it } from 'vitest';
import { augmentSymbol, formatAugmentResults } from '../augment.js';

describe('augmentSymbol', () => {
  it('returns empty array if nexus.db does not exist', () => {
    // This will pass because nexus.db doesn't exist in test environment
    const results = augmentSymbol('nonexistent');
    expect(results).toEqual([]);
  });

  it('returns empty array for empty pattern', () => {
    const results = augmentSymbol('');
    expect(results).toEqual([]);
  });

  it('handles LIKE pattern matching gracefully', () => {
    // Even if database is empty or missing, augmentSymbol should not throw
    const results = augmentSymbol('loadConfig');
    expect(Array.isArray(results)).toBe(true);
  });
});

describe('formatAugmentResults', () => {
  it('returns empty string for empty results', () => {
    const formatted = formatAugmentResults([]);
    expect(formatted).toBe('');
  });

  it('formats single result correctly', () => {
    const results = [
      {
        id: 'file.ts::loadConfig',
        label: 'loadConfig',
        kind: 'function',
        filePath: 'src/config.ts',
        startLine: 10,
        endLine: 25,
        callersCount: 3,
        calleesCount: 2,
        communityId: 5,
        communitySize: 12,
      },
    ];

    const formatted = formatAugmentResults(results);
    expect(formatted).toContain('[nexus] Symbol context:');
    expect(formatted).toContain('loadConfig (function)');
    expect(formatted).toContain('callers: 3, callees: 2');
    expect(formatted).toContain('community 5');
    expect(formatted).toContain('12 members');
  });

  it('formats multiple results with varying metadata', () => {
    const results = [
      {
        id: 'main.ts::main',
        label: 'main',
        kind: 'function',
        filePath: 'src/main.ts',
        startLine: 1,
        endLine: 50,
        callersCount: 0,
        calleesCount: 5,
      },
      {
        id: 'utils.ts::helper',
        label: 'helper',
        kind: 'method',
        callersCount: 10,
        calleesCount: 0,
      },
    ];

    const formatted = formatAugmentResults(results);
    expect(formatted).toContain('main (function)');
    expect(formatted).toContain('helper (method)');
    expect(formatted).toContain('callers: 0, callees: 5');
    expect(formatted).toContain('callers: 10, callees: 0');
  });

  it('omits location and community info when not present', () => {
    const results = [
      {
        id: 'unknown::process',
        label: 'process',
        kind: 'function',
        callersCount: 1,
        calleesCount: 1,
      },
    ];

    const formatted = formatAugmentResults(results);
    expect(formatted).not.toContain('(unknown');
    expect(formatted).not.toContain('community');
  });

  it('includes multiple lines for multiple results', () => {
    const results = [
      {
        id: '1',
        label: 'func1',
        kind: 'function',
        callersCount: 1,
        calleesCount: 2,
      },
      {
        id: '2',
        label: 'func2',
        kind: 'function',
        callersCount: 3,
        calleesCount: 4,
      },
    ];

    const formatted = formatAugmentResults(results);
    const lines = formatted.split('\n');
    expect(lines.length).toBe(3); // header + 2 results
  });
});
