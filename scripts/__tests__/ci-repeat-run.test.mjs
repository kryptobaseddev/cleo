/**
 * T14149 — repeat-run.yml and scripts/ci-repeat-run.mjs.
 *
 * The workflow repeats one test file N times on main so a criterion that needs
 * a heavy or repeated run is proven in CI. Its inputs are user-supplied, so
 * none may reach a shell: they pass through `env:` and are validated before
 * anything runs.
 *
 * @task T14149
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { MAX_REPEAT_RUNS, runCounts, validateRepeatInputs } from '../ci-repeat-run.mjs';

const WORKFLOW = '.github/workflows/repeat-run.yml';
const doc = () => parseYaml(readFileSync(WORKFLOW, 'utf8'));
const tracked = () => true;

describe('repeat-run.yml structure (T14149)', () => {
  it('no run: block interpolates a dispatch input', () => {
    for (const [name, job] of Object.entries(doc().jobs)) {
      for (const step of job.steps ?? []) {
        if (typeof step.run !== 'string') continue;
        expect(step.run, `${name}: ${step.name ?? step.run}`).not.toMatch(/\$\{\{\s*inputs\./);
        expect(step.run).not.toMatch(/\$\{\{\s*github\.event\.inputs\./);
      }
    }
  });

  it('runs only on main, under a bounded timeout, and only on workflow_dispatch', () => {
    const d = doc();
    expect(Object.keys(d.on)).toEqual(['workflow_dispatch']);
    expect(d.jobs.repeat.if).toBe("github.ref == 'refs/heads/main'");
    expect(d.jobs.repeat['timeout-minutes']).toBeLessThanOrEqual(90);
    expect(d.permissions).toEqual({ contents: 'read' });
  });

  it('keeps repeats out of the live main CI concurrency group', () => {
    expect(doc().concurrency.group).toMatch(/^repeat-run-/);
  });

  it('names the test and count in the run title, which cleo cross-checks with the report', () => {
    // Regex, not a literal: `${{ … }}` in a plain string trips biome's noTemplateCurlyInString.
    expect(doc()['run-name']).toMatch(/^repeat-run \$\{\{ inputs\.test \}\} x\$\{\{ inputs\.runs \}\}$/);
  });
});

describe('validateRepeatInputs (T14149)', () => {
  it('accepts a tracked repo-relative test file and a count of 1-200', () => {
    expect(
      validateRepeatInputs({ test: 'packages/core/src/a/__tests__/b.test.ts', runs: '50' }, tracked),
    ).toEqual({ ok: true, test: 'packages/core/src/a/__tests__/b.test.ts', runs: 50 });
    expect(validateRepeatInputs({ test: 'scripts/__tests__/x.test.mjs', runs: '200' }, tracked).ok).toBe(true);
  });

  it('refuses a path with .., an absolute path, a non-test file or shell syntax', () => {
    for (const test of [
      '../etc/passwd.test.ts',
      'packages/../../x.test.ts',
      '/abs/x.test.ts',
      'packages/core/src/a.ts',
      'x.test.ts; rm -rf /',
      '$(id).test.ts',
      'a b.test.ts',
    ]) {
      expect(validateRepeatInputs({ test, runs: '5' }, tracked).ok, test).toBe(false);
    }
  });

  it('refuses an untracked file', () => {
    expect(validateRepeatInputs({ test: 'a.test.ts', runs: '5' }, () => false)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('not a tracked file'),
    });
  });

  it('refuses a count that is not an integer from 1 to 200', () => {
    for (const runs of ['0', '201', '-1', '1.5', '5; id', '', 'fifty']) {
      expect(validateRepeatInputs({ test: 'a.test.ts', runs }, tracked).ok, runs).toBe(false);
    }
    expect(MAX_REPEAT_RUNS).toBe(200);
  });
});

describe('runCounts (T14149)', () => {
  it("reads a vitest JSON report's counts and files", () => {
    expect(
      runCounts({
        numTotalTests: 3,
        numPassedTests: 3,
        numFailedTests: 0,
        testResults: [{ name: '/w/a.test.ts' }],
      }),
    ).toEqual({ numTotalTests: 3, numPassedTests: 3, numFailedTests: 0, files: ['/w/a.test.ts'] });
    expect(runCounts(null)).toEqual({
      numTotalTests: 0,
      numPassedTests: 0,
      numFailedTests: 0,
      files: [],
    });
  });
});
