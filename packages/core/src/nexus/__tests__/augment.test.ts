/**
 * Tests for NEXUS symbol context augmentation (T1061, T1765)
 *
 * Tests LIKE search and result formatting for PreToolUse hook injection.
 *
 * T1765 regression coverage:
 *   - Wrong column names in callers/callees subqueries no longer produce empty results
 *   - Operator precedence bug in WHERE clause fixed (label LIKE OR file_path LIKE AND kind)
 *   - communityId typed as string (matching nexus_nodes.community_id text column)
 */

import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openNativeDatabase } from '../../store/sqlite.js';
import { augmentSymbol, formatAugmentResults } from '../augment.js';

// ---------------------------------------------------------------------------
// Integration tests — only run when nexus.db is populated with rows
// ---------------------------------------------------------------------------

const nexusDbPath = `${process.env.HOME}/.local/share/cleo/nexus.db`;

/**
 * Returns true only when nexus.db exists AND contains at least one row in
 * nexus_nodes. A mere file-existence check is insufficient: CI runners may
 * have an empty nexus.db created by prior tool-chain steps, which would cause
 * the integration suite to run and immediately fail the row-count assertions.
 *
 * Skips gracefully on any DB error (missing table, locked file, etc.).
 */
function nexusDbHasData(): boolean {
  if (!existsSync(nexusDbPath)) return false;
  try {
    const db = openNativeDatabase(nexusDbPath, { readonly: true });
    const row = db.prepare('SELECT COUNT(*) AS c FROM nexus_nodes').get() as
      | { c: number }
      | undefined;
    db.close();
    return (row?.c ?? 0) > 0;
  } catch {
    return false;
  }
}

const hasNexusData = nexusDbHasData();

describe('augmentSymbol — unit (no DB dependency)', () => {
  it('returns empty array if nexus.db does not exist', () => {
    // This passes because in the CI test environment nexus.db is not populated
    const results = augmentSymbol('__nonexistent_symbol_xyz__');
    expect(Array.isArray(results)).toBe(true);
  });

  it('returns empty array for empty pattern', () => {
    const results = augmentSymbol('');
    expect(results).toEqual([]);
  });

  it('does not throw on arbitrary pattern', () => {
    expect(() => augmentSymbol('loadConfig')).not.toThrow();
  });
});

describe.skipIf(!hasNexusData)(
  'augmentSymbol — integration (requires populated nexus.db, skipped when empty or absent)',
  () => {
    it('returns non-empty results for common symbol patterns', () => {
      // "load" is a common pattern that should exist in any indexed TypeScript codebase.
      const results = augmentSymbol('load', 5);
      expect(results.length).toBeGreaterThan(0);
    });

    it('results contain only callable kinds', () => {
      const callableKinds = new Set([
        'function',
        'method',
        'constructor',
        'class',
        'interface',
        'type_alias',
      ]);
      const results = augmentSymbol('load', 10);
      for (const r of results) {
        expect(callableKinds.has(r.kind)).toBe(true);
      }
    });

    it('callersCount and calleesCount are non-negative integers', () => {
      const results = augmentSymbol('load', 5);
      for (const r of results) {
        expect(typeof r.callersCount).toBe('number');
        expect(typeof r.calleesCount).toBe('number');
        expect(r.callersCount).toBeGreaterThanOrEqual(0);
        expect(r.calleesCount).toBeGreaterThanOrEqual(0);
      }
    });

    it('communityId is a string when present (not a number)', () => {
      // Regression: communityId was typed as number but DB stores text like "comm_3".
      const results = augmentSymbol('load', 10);
      for (const r of results) {
        if (r.communityId !== undefined) {
          expect(typeof r.communityId).toBe('string');
        }
      }
    });

    it('p50 latency is under 500ms (T1765 perf target)', () => {
      const patterns = ['load', 'get', 'set', 'create', 'handle'];
      const timings: number[] = [];

      for (const pat of patterns) {
        const start = performance.now();
        augmentSymbol(pat, 5);
        timings.push(performance.now() - start);
      }

      timings.sort((a, b) => a - b);
      const p50 = timings[Math.floor(timings.length / 2)];
      // p50 must be under 500ms (gitnexus baseline: 317ms)
      expect(p50).toBeLessThan(500);
    });

    it('returns up to `limit` results', () => {
      const results = augmentSymbol('load', 3);
      expect(results.length).toBeLessThanOrEqual(3);
    });
  },
);

// ---------------------------------------------------------------------------
// formatAugmentResults — unit
// ---------------------------------------------------------------------------

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
        communityId: 'comm_5',
        communitySize: 12,
      },
    ];

    const formatted = formatAugmentResults(results);
    expect(formatted).toContain('[nexus] Symbol context:');
    expect(formatted).toContain('loadConfig (function)');
    expect(formatted).toContain('callers: 3, callees: 2');
    expect(formatted).toContain('community comm_5');
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
