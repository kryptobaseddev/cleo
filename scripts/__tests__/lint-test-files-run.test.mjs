/**
 * Gate 43 (T14410): every tracked test file is collected by a vitest run CI
 * performs, and the baseline of files that never ran only shrinks.
 *
 * @task T14410
 */

import { describe, expect, it } from 'vitest';
import {
  BASELINE,
  compare,
  quarantinedFiles,
  TEST_FILE,
  workflowInvokes,
} from '../lint-test-files-run.mjs';

const none = { quarantined: new Set(), baseline: {}, ignoredPrefixes: [] };

describe('lint-test-files-run (gate 43)', () => {
  it('fails a tracked test file no CI run collects', () => {
    const r = compare({
      ...none,
      tracked: ['a/x.test.ts', 'a/y-integration.test.ts'],
      collected: new Set(['a/x.test.ts']),
    });
    expect(r.uncollected).toEqual(['a/y-integration.test.ts']);
  });

  it('accepts quarantined, ignored and baselined files, and reports baselined ones', () => {
    const r = compare({
      tracked: ['q.test.ts', '.cleo/z.test.js', 'b.spec.ts'],
      collected: new Set(),
      quarantined: new Set(['q.test.ts']),
      baseline: { 'b.spec.ts': 'reason' },
      ignoredPrefixes: ['.cleo/'],
    });
    expect(r.uncollected).toEqual([]);
    expect(r.baselined).toEqual(['b.spec.ts']);
    expect(r.stale).toEqual([]);
  });

  it('fails a stale baseline entry: collected now, or deleted', () => {
    const r = compare({
      ...none,
      tracked: ['now-runs.test.ts'],
      collected: new Set(['now-runs.test.ts']),
      baseline: { 'now-runs.test.ts': 'r', 'gone.test.ts': 'r' },
    });
    expect(r.stale.sort()).toEqual(['gone.test.ts', 'now-runs.test.ts']);
  });

  it('matches test file names, not their fixtures or helpers', () => {
    for (const f of [
      'a.test.ts',
      'a.spec.ts',
      'a.test.mjs',
      'a.test.tsx',
      'a.integration.test.ts',
    ]) {
      expect(TEST_FILE.test(f), f).toBe(true);
    }
    for (const f of ['a.ts', 'test-helpers.ts', 'a.test.ts.snap']) {
      expect(TEST_FILE.test(f), f).toBe(false);
    }
  });

  it('counts a runner invoked only on a comment line as not invoked', () => {
    expect(workflowInvokes('  # run: vitest --config x.ts\n', '--config x.ts')).toBe(false);
    expect(workflowInvokes('        run: vitest --config x.ts\n', '--config x.ts')).toBe(true);
  });

  it('parses quarantine entries and skips comment text with apostrophes', () => {
    const src =
      "export const CLEO_TEST_QUARANTINE: readonly string[] = [\n  // the section's file\n  'p/a.test.ts',\n];\n";
    expect(quarantinedFiles(src)).toEqual(['p/a.test.ts']);
  });

  it('gives every baseline entry a reason naming its burn-down task', () => {
    for (const [file, reason] of Object.entries(BASELINE)) {
      expect(reason, file).toMatch(/T\d{4,}/);
    }
  });
});
