/**
 * Tests for `addIssue` enum validation — `--severity` and `--area` are closed
 * enums and must be rejected at the core boundary (gh#1383).
 *
 * All calls use `dryRun: true`, which returns before any `gh` invocation.
 *
 * @task T13478
 */

import { describe, expect, it } from 'vitest';

import { addIssue } from '../create.js';

const base = { issueType: 'bug', title: 't', body: 'b', dryRun: true } as const;

describe('addIssue — severity/area enum validation (gh#1383)', () => {
  it('rejects a P0-P3 severity and names the allowed values', () => {
    expect(() => addIssue({ ...base, severity: 'P2' })).toThrow(
      /Invalid --severity 'P2': expected one of Blocker, Major, Moderate, Minor.*cleo add --severity/,
    );
  });

  it('rejects an undeclared area', () => {
    expect(() => addIssue({ ...base, area: 'frontend' })).toThrow(
      /Invalid --area 'frontend': expected one of cli, dispatch, docs, tests, other/,
    );
  });

  it('accepts declared values and writes them into the body', () => {
    const result = addIssue({ ...base, severity: 'Major', area: 'cli' });
    expect(result.dryRun).toBe(true);
    expect(result.body).toContain('**Severity**: Major');
    expect(result.body).toContain('**Area**: cli');
  });
});
