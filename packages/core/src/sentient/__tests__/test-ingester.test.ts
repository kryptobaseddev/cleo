/**
 * Tests for the Test ingester.
 *
 * Uses real tmp directories for file I/O — no mocks.
 *
 * @task T1008
 */

import { mkdtempSync as fsMkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  COVERAGE_SUMMARY_PATH,
  GATES_JSONL_PATH,
  runTestIngester,
  TEST_BASE_WEIGHT,
} from '../ingesters/test-ingester.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fsMkdtempSync(join(tmpdir(), 'cleo-test-ingester-'));
  mkdirSync(join(tmpDir, '.cleo', 'audit'), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeGates(lines: object[]) {
  writeFileSync(
    join(tmpDir, GATES_JSONL_PATH),
    lines.map((l) => JSON.stringify(l)).join('\n'),
    'utf-8',
  );
}

function writeCoverage(summary: object) {
  writeFileSync(join(tmpDir, COVERAGE_SUMMARY_PATH), JSON.stringify(summary), 'utf-8');
}

// ---------------------------------------------------------------------------
// runTestIngester
// ---------------------------------------------------------------------------

describe('runTestIngester', () => {
  it('returns empty array when gates.jsonl is absent', () => {
    expect(runTestIngester(tmpDir)).toEqual([]);
  });

  it('parses gates.jsonl and emits one candidate per task with failCount > 0', () => {
    writeGates([
      { taskId: 'T100', gate: 'testsPassed', failCount: 2 },
      { taskId: 'T101', gate: 'qaPassed', failCount: 0 },
      { taskId: 'T102', gate: 'implemented', failCount: 1 },
    ]);
    const results = runTestIngester(tmpDir);
    expect(results).toHaveLength(2);
    expect(results.some((r) => r.sourceId === 'T100.testsPassed')).toBe(true);
    expect(results.some((r) => r.sourceId === 'T102.implemented')).toBe(true);
  });

  it('returns empty array for Source B when coverage-summary.json is absent (no error)', () => {
    // gates.jsonl also absent — should get empty with no throw
    expect(() => runTestIngester(tmpDir)).not.toThrow();
    expect(runTestIngester(tmpDir)).toEqual([]);
  });

  it('coverage source: emits candidate for file with lines.pct < 80', () => {
    writeCoverage({
      'src/utils.ts': { lines: { pct: 55 } },
    });
    const results = runTestIngester(tmpDir);
    expect(results.some((r) => r.sourceId === 'src/utils.ts')).toBe(true);
  });

  it('coverage source: does NOT emit candidate for file with lines.pct >= 80', () => {
    writeCoverage({
      'src/utils.ts': { lines: { pct: 90 } },
    });
    const results = runTestIngester(tmpDir);
    expect(results.some((r) => r.sourceId === 'src/utils.ts')).toBe(false);
  });

  it('title format for gate-fail candidate matches [T2-TEST] template', () => {
    writeGates([{ taskId: 'T100', gate: 'testsPassed', failCount: 3 }]);
    const results = runTestIngester(tmpDir);
    expect(results[0]?.title).toMatch(/^\[T2-TEST\]/);
    expect(results[0]?.title).toBe('[T2-TEST] Fix flaky gate: T100.testsPassed');
  });

  it('all candidates have source="test" and weight=TEST_BASE_WEIGHT', () => {
    writeGates([{ taskId: 'T100', gate: 'testsPassed', failCount: 1 }]);
    writeCoverage({ 'src/foo.ts': { lines: { pct: 60 } } });
    const results = runTestIngester(tmpDir);
    expect(results.every((r) => r.source === 'test')).toBe(true);
    expect(results.every((r) => r.weight === TEST_BASE_WEIGHT)).toBe(true);
  });
});
