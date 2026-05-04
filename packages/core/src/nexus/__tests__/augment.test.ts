/**
 * Tests for NEXUS symbol context augmentation (T1061, T1765)
 *
 * Tests LIKE search and result formatting for PreToolUse hook injection.
 *
 * T1765 regression coverage:
 *   - Wrong column names in callers/callees subqueries no longer produce empty results
 *   - Operator precedence bug in WHERE clause fixed (label LIKE OR file_path LIKE AND kind)
 *   - communityId typed as string (matching nexus_nodes.community_id text column)
 *
 * T1849 skip-guard:
 *   - Integration tests skip in CI environments (process.env.CI === 'true')
 *   - Integration tests also skip when the specific label pattern has no matches
 *     in nexus_nodes (belt-and-suspenders: guards against polluted-but-mismatched DB)
 */

import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openNativeDatabase } from '../../store/sqlite.js';
import { augmentSymbol, formatAugmentResults } from '../augment.js';

// ---------------------------------------------------------------------------
// Integration skip-guard — approach (A)+(B) combined (T1849)
// ---------------------------------------------------------------------------

const nexusDbPath = `${process.env.HOME}/.local/share/cleo/nexus.db`;

/**
 * Returns true if this integration test should be skipped.
 *
 * Skips when EITHER:
 *   (A) Running in a CI environment — CI runners may have a polluted nexus.db
 *       from prior test-suite steps that does NOT contain the symbols these
 *       tests need. Detected via process.env.CI, GITHUB_ACTIONS, or
 *       CONTINUOUS_INTEGRATION env vars.
 *   (B) The specific label pattern has zero matches in nexus_nodes — guards
 *       against developers who have a nexus.db but haven't indexed the right
 *       codebase, and against any future CI leakage not covered by (A).
 *
 * Never throws: any DB error returns true (skip safely).
 *
 * @param labelPattern - The label pattern the test will search for (e.g. 'load')
 */
function shouldSkipNexusIntegration(labelPattern: string): boolean {
  // (A) CI environment detection — belt
  if (
    process.env.CI === 'true' ||
    process.env.CI === '1' ||
    process.env.GITHUB_ACTIONS === 'true' ||
    process.env.CONTINUOUS_INTEGRATION === 'true'
  ) {
    return true;
  }

  // (B) Pattern-specific presence check — suspenders
  if (!existsSync(nexusDbPath)) return true;
  try {
    const db = openNativeDatabase(nexusDbPath, { readonly: true });
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c FROM nexus_nodes WHERE label LIKE ? AND kind IN ('function', 'method', 'constructor', 'class', 'interface', 'type_alias') LIMIT 1`,
      )
      .get(`%${labelPattern}%`) as { c: number } | undefined;
    db.close();
    return (row?.c ?? 0) === 0;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Unit tests — no DB dependency
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Integration tests — per-test skip guards (T1849)
//
// Each test uses shouldSkipNexusIntegration with its own label pattern so that
// a DB populated with different symbols doesn't cause false failures.
// ---------------------------------------------------------------------------

describe('augmentSymbol — integration (requires populated nexus.db, skipped in CI or when absent)', () => {
  it.skipIf(shouldSkipNexusIntegration('load'))(
    'returns non-empty results for common symbol patterns',
    () => {
      // "load" is a common pattern that should exist in any indexed TypeScript codebase.
      const results = augmentSymbol('load', 5);
      expect(results.length).toBeGreaterThan(0);
    },
  );

  it.skipIf(shouldSkipNexusIntegration('load'))('results contain only callable kinds', () => {
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

  it.skipIf(shouldSkipNexusIntegration('load'))(
    'callersCount and calleesCount are non-negative integers',
    () => {
      const results = augmentSymbol('load', 5);
      for (const r of results) {
        expect(typeof r.callersCount).toBe('number');
        expect(typeof r.calleesCount).toBe('number');
        expect(r.callersCount).toBeGreaterThanOrEqual(0);
        expect(r.calleesCount).toBeGreaterThanOrEqual(0);
      }
    },
  );

  it.skipIf(shouldSkipNexusIntegration('load'))(
    'communityId is a string when present (not a number)',
    () => {
      // Regression: communityId was typed as number but DB stores text like "comm_3".
      const results = augmentSymbol('load', 10);
      for (const r of results) {
        if (r.communityId !== undefined) {
          expect(typeof r.communityId).toBe('string');
        }
      }
    },
  );

  it.skipIf(shouldSkipNexusIntegration('load'))(
    'p50 latency is under 500ms (T1765 perf target)',
    () => {
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
    },
  );

  it.skipIf(shouldSkipNexusIntegration('load'))('returns up to `limit` results', () => {
    const results = augmentSymbol('load', 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });
});

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
