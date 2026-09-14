#!/usr/bin/env node

/**
 * assert-vitest-collected.mjs — prove a vitest run executed the files it was given.
 *
 * Why this exists (gh#1403 follow-up)
 * -----------------------------------
 * `vitest run --project=<p> <paths...>` treats the paths as FILTERS, not as a
 * contract. Measured 2026-09-14 against the `scripts` project:
 *
 *   one path, non-collectable                    -> rc=1  "No test files found"
 *   two paths, one collectable one not           -> rc=0  "Test Files 1 passed (1)"
 *
 * So a TOTAL miss fails loudly and a PARTIAL miss passes **green**, having
 * silently dropped a file it was explicitly told to run. The CI job that runs
 * the scripts project selects files by diffing against the PR base; if any
 * selected path stops matching the project's `include` under its own `root:`
 * — a rename, a directory move, a config change — the job keeps reporting
 * success for a shrinking set, and the count it prints is the count of what it
 * CHOSE, not of what RAN.
 *
 * That is the failure this whole issue is about, one level up: a denominator
 * computed and never compared against what actually happened. The job cannot
 * assert its own coverage from its own selection, because both numbers come
 * from the same side of the question.
 *
 * Usage:
 *   node scripts/assert-vitest-collected.mjs <report.json> <expected-path>...
 *
 * Exit codes:
 *   0 — every expected file appears in the report
 *   1 — at least one expected file was not collected
 *   2 — the report could not be read or parsed (fails closed: an unreadable
 *       report is not evidence that everything ran)
 *
 * @task gh#1403
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Collect the absolute test-file paths a vitest JSON report says it ran.
 *
 * @param {unknown} report - Parsed vitest JSON report.
 * @returns {string[]} Absolute file paths, deduplicated.
 */
export function collectedFiles(report) {
  if (report === null || typeof report !== 'object') return [];
  const results = /** @type {{ testResults?: unknown }} */ (report).testResults;
  if (!Array.isArray(results)) return [];
  const out = new Set();
  for (const r of results) {
    if (
      r &&
      typeof r === 'object' &&
      typeof (/** @type {{name?: unknown}} */ (r).name) === 'string'
    ) {
      out.add(/** @type {{name: string}} */ (r).name);
    }
  }
  return [...out];
}

/**
 * Determine which expected files are missing from a report.
 *
 * Compares on resolved absolute paths so a repo-relative expectation matches
 * the absolute path vitest records.
 *
 * @param {string[]} expected - Paths the run was told to execute.
 * @param {string[]} collected - Paths the report says it executed.
 * @param {string} [cwd] - Base for resolving relative expectations.
 * @returns {string[]} The expected paths with no match in `collected`.
 */
export function missingFiles(expected, collected, cwd = process.cwd()) {
  const have = new Set(collected.map((f) => path.resolve(cwd, f)));
  return expected.filter((e) => !have.has(path.resolve(cwd, e)));
}

/**
 * @param {string[]} argv - [reportPath, ...expectedPaths]
 * @returns {number} Process exit code.
 */
export function main(argv) {
  const [reportPath, ...expected] = argv;

  if (!reportPath || expected.length === 0) {
    console.error('usage: assert-vitest-collected.mjs <report.json> <expected-path>...');
    return 2;
  }

  /** @type {unknown} */
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`::error::could not read the vitest report at ${reportPath}: ${msg}`);
    console.error('Refusing to treat an unreadable report as proof the tests ran.');
    return 2;
  }

  const collected = collectedFiles(report);
  const missing = missingFiles(expected, collected);

  console.log(`selected ${expected.length} file(s); vitest collected ${collected.length}`);

  if (missing.length === 0) {
    console.log('✓ every selected file was collected and executed.');
    return 0;
  }

  console.error(
    `::error::vitest ran ${collected.length} of ${expected.length} selected file(s) and still exited 0.`,
  );
  console.error('Not collected:');
  for (const m of missing) console.error(`  - ${m}`);
  console.error('');
  console.error('A path that does not match the project include is silently dropped when at');
  console.error('least one other path does match. The run was green for a set it never ran.');
  return 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
