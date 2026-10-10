/**
 * T13381 — the advisory forge-ts job must complete, never end `cancelled`.
 *
 * `Documentation Coverage (forge-ts)` ended `cancelled` on #1966 (run
 * 37565876848) and #1973 (run 38022115168). Both runs hit `timeout-minutes: 10`
 * inside `forge-ts build`, which took 160-525 s and whose output nothing read
 * (no artifact, `|| true`). `continue-on-error` does not mask a timeout, so the
 * cancelled job blocked the merge. The build step is removed rather than given
 * more time. These tests pin that.
 *
 * @task T13381
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ci = parseYaml(readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8'));
const job = ci.jobs['forge-ts-check'];
const runs = (job?.steps ?? []).map((s) => String(s.run ?? ''));

describe('forge-ts CI job (T13381)', () => {
  it('runs the TSDoc coverage check', () => {
    expect(runs.some((r) => /forge-ts check\b/.test(r))).toBe(true);
  });

  it('never runs forge-ts build, whose output nothing consumes', () => {
    expect(runs.filter((r) => /forge-ts build\b/.test(r))).toEqual([]);
  });

  it('stays advisory with a timeout far above the check (10-23 s plus install)', () => {
    expect(job['continue-on-error']).toBe(true);
    expect(job['timeout-minutes']).toBeGreaterThanOrEqual(10);
  });
});
