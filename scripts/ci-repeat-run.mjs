#!/usr/bin/env node
/**
 * Run one test file N times for `.github/workflows/repeat-run.yml` (T14149).
 *
 *   node scripts/ci-repeat-run.mjs validate   # check REPEAT_TEST / REPEAT_RUNS, run nothing
 *   node scripts/ci-repeat-run.mjs run        # validate, then run vitest N times
 *
 * The inputs arrive through the environment, never through a shell: the test
 * path must be a tracked, repo-relative test file (no `..`), and the run count
 * an integer from 1 to 200. Each run is `vitest run <file>` with a JSON report,
 * spawned without a shell, and the first failing run stops the loop with a
 * non-zero exit. `$REPEAT_OUT/repeat-report.json` records the test, the count,
 * the commit and every run's counts; `cleo verify … ci-run:<runId>` reads it
 * to cross-check the run's title (T14149).
 *
 * @task T14149
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Most runs one dispatch may ask for. */
export const MAX_REPEAT_RUNS = 200;

/** A repo-relative test file path: no `..`, no leading `/`, a test suffix. */
const TEST_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._@/-]+\.(?:test|spec)\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;

/**
 * Validate the dispatch inputs.
 *
 * @param {{ test?: string, runs?: string }} input - Raw inputs.
 * @param {(path: string) => boolean} isTracked - Whether git tracks the path.
 * @returns {{ ok: true, test: string, runs: number } | { ok: false, reason: string }}
 */
export function validateRepeatInputs(input, isTracked) {
  const test = (input.test ?? '').trim();
  if (!TEST_PATH.test(test))
    return {
      ok: false,
      reason: `test must be a repo-relative test file (*.test.ts, *.spec.ts, …) with no "..": got ${JSON.stringify(test)}`,
    };
  if (!isTracked(test)) return { ok: false, reason: `test ${test} is not a tracked file` };
  const raw = (input.runs ?? '').trim();
  if (!/^[0-9]+$/.test(raw)) return { ok: false, reason: `runs must be an integer: got ${JSON.stringify(raw)}` };
  const runs = Number(raw);
  if (runs < 1 || runs > MAX_REPEAT_RUNS)
    return { ok: false, reason: `runs must be 1-${MAX_REPEAT_RUNS}: got ${runs}` };
  return { ok: true, test, runs };
}

/**
 * Counts of one vitest JSON report.
 *
 * @param {unknown} report - Parsed `--reporter=json` output.
 * @returns {{ numTotalTests: number, numPassedTests: number, numFailedTests: number, files: string[] }}
 */
export function runCounts(report) {
  const r = /** @type {Record<string, unknown>} */ (report ?? {});
  const num = (key) => (typeof r[key] === 'number' ? /** @type {number} */ (r[key]) : 0);
  const files = Array.isArray(r.testResults)
    ? r.testResults.flatMap((f) => (f && typeof f.name === 'string' ? [f.name] : []))
    : [];
  return {
    numTotalTests: num('numTotalTests'),
    numPassedTests: num('numPassedTests'),
    numFailedTests: num('numFailedTests'),
    files,
  };
}

function isTrackedInRepo(path) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', path], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function fail(message) {
  console.error(`repeat-run: ${message}`);
  process.exit(1);
}

function main() {
  const mode = process.argv[2];
  const input = validateRepeatInputs(
    { test: process.env.REPEAT_TEST, runs: process.env.REPEAT_RUNS },
    isTrackedInRepo,
  );
  if (!input.ok) fail(input.reason);
  if (process.env.GITHUB_REF && process.env.GITHUB_REF !== 'refs/heads/main')
    fail(`runs only on refs/heads/main, not ${process.env.GITHUB_REF}`);
  if (mode === 'validate') return;
  if (mode !== 'run') fail('usage: ci-repeat-run.mjs validate|run');
  const out = process.env.REPEAT_OUT ?? join(process.cwd(), '.repeat-run');
  mkdirSync(out, { recursive: true });
  const report = {
    test: input.test,
    runs: input.runs,
    sha: process.env.GITHUB_SHA ?? null,
    runId: process.env.GITHUB_RUN_ID ? Number(process.env.GITHUB_RUN_ID) : null,
    iterations: [],
  };
  const save = () => writeFileSync(join(out, 'repeat-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  for (let i = 1; i <= input.runs; i++) {
    const file = join(out, `run-${i}.json`);
    const child = spawnSync(
      'pnpm',
      ['exec', 'vitest', 'run', input.test, '--reporter=json', `--outputFile=${file}`],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
    let counts = { numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, files: [] };
    try {
      counts = runCounts(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      // No report: the run did not finish; recorded with zero counts.
    }
    report.iterations.push({ run: i, exitCode: child.status, ...counts });
    save();
    if (child.status !== 0 || counts.numFailedTests > 0 || counts.numPassedTests === 0)
      fail(`run ${i} of ${input.runs} failed (exit ${child.status}, ${counts.numFailedTests} failed, ${counts.numPassedTests} passed)`);
    console.log(`repeat-run: run ${i}/${input.runs} passed (${counts.numPassedTests} tests)`);
  }
  console.log(`repeat-run: all ${input.runs} runs of ${input.test} passed`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
