/**
 * Binding a targeted `test-run:` report to the change it claims to test
 * (T12965).
 *
 * What a bound atom guarantees, exactly:
 *  1. **Freshness.** The report's own run time (vitest `startTime`, else the
 *     file's mtime) is not older than the newest working-tree modification of
 *     any path the branch changed against origin's default branch (committed,
 *     uncommitted or untracked; the report itself excluded) — or, with no
 *     origin to diff against, any uncommitted tracked edit. So no file of the
 *     change was edited after the run started. Committing after the run is
 *     fine; editing is not. A file's mtime is a filesystem fact, not proof of
 *     content, so this is a guard against stale reports, not an attestation.
 *  2. **Relevance.** When the change touches workspace packages (and nothing
 *     workspace-wide), at least one test file the report covers lies in a
 *     directly changed package or is itself a changed path. Changes that are
 *     workspace-wide, docs-only or outside any workspace are not judged.
 *  3. **Identity.** HEAD and the tracked tree hash at verify time are
 *     recorded, and `cleo complete` refuses the atom once that tree moved
 *     (unless merged CI or a full run carries the gate).
 *
 * It does NOT prove the report was produced by this tree's code: a report is
 * a file the caller supplies. Merged CI (`ci:<pr>`) or `tool:test` are the
 * evidence that does.
 *
 * @task T12965
 */

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { discoveryEnv } from '../git/work-tree.js';
import {
  changedPathsSinceDefault,
  deriveAffectedPackages,
  listWorkspacePackages,
} from './affected-packages.js';

/** The parts of a vitest JSON report the binding reads. */
export interface TestRunReport {
  /** Epoch milliseconds the run started (vitest). */
  startTime?: number;
  /** Per-file results; `name` is the test file path. */
  testResults?: Array<{ status?: string; name?: string }>;
}

/**
 * Most test files a `test-run:` atom lists; `testFileCount` keeps the true
 * total when a full-suite report covers more.
 */
export const TEST_RUN_MAX_RECORDED_FILES = 200;

/** Mtime slack for filesystems with coarse timestamps (ms). */
const MTIME_SLACK_MS = 1000;

/**
 * The report's test files, relative to `root` where they lie inside it,
 * slash-separated, sorted and unique.
 *
 * @param report - Parsed report.
 * @param root - Execution root.
 * @returns The covered test files.
 * @task T12965
 */
export function coveredTestFiles(report: TestRunReport, root: string): string[] {
  if (!Array.isArray(report.testResults)) return [];
  const files = report.testResults.flatMap((tr) => {
    if (typeof tr.name !== 'string' || tr.name === '') return [];
    const rel = isAbsolute(tr.name) ? relative(root, tr.name) : tr.name;
    return [rel.startsWith('..') || isAbsolute(rel) ? tr.name : rel.split('\\').join('/')];
  });
  return [...new Set(files)].sort();
}

function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null; // deleted by the change
  }
}

function dirtyTracked(root: string): string[] {
  try {
    return execFileSync('git', ['diff', '--name-only', '--no-renames', 'HEAD'], {
      cwd: root,
      encoding: 'utf-8',
      env: discoveryEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Refuse a report that is older than the change it claims to test, or that
 * covers none of the changed packages (see the module doc for exactly what
 * this guarantees).
 *
 * @param report - Parsed report.
 * @param reportPath - Absolute path of the report file.
 * @param root - Execution root (a git checkout, or not).
 * @param testFiles - {@link coveredTestFiles} of the report.
 * @returns A refusal reason, or null when the report may be bound.
 * @task T12965
 */
export function testRunBindingRefusal(
  report: TestRunReport,
  reportPath: string,
  root: string,
  testFiles: readonly string[],
): string | null {
  const ranAt =
    typeof report.startTime === 'number' && Number.isFinite(report.startTime)
      ? report.startTime
      : mtimeOf(reportPath);
  if (ranAt === null) return null;
  const reportRel = relative(root, reportPath).split('\\').join('/');
  const changed = changedPathsSinceDefault(root);
  const candidates = (changed ?? dirtyTracked(root)).filter((p) => p !== reportRel);
  let newest: { path: string; at: number } | null = null;
  for (const path of candidates) {
    const at = mtimeOf(resolve(root, path));
    if (at !== null && (newest === null || at > newest.at)) newest = { path, at };
  }
  if (newest !== null && newest.at > ranAt + MTIME_SLACK_MS) {
    return (
      `test-run report is stale: it ran at ${new Date(ranAt).toISOString()}, but ${newest.path} ` +
      `was modified at ${new Date(newest.at).toISOString()}, after the run. Re-run the tests and ` +
      `record the fresh report (write reports to a gitignored path or outside the checkout).`
    );
  }
  if (changed === null || changed.length === 0) return null;
  const scope = deriveAffectedPackages(root, changed);
  if (scope.scope === 'full' || scope.direct.length === 0) return null;
  const dirs = listWorkspacePackages(root)
    .filter((p) => scope.direct.includes(p.name))
    .map((p) => p.dir);
  const changedSet = new Set(changed);
  const relevant = testFiles.some(
    (f) => changedSet.has(f) || dirs.some((d) => f === d || f.startsWith(`${d}/`)),
  );
  if (relevant) return null;
  return testFiles.length === 0
    ? `test-run report lists no test files, so it cannot show it covers the changed package(s) ${scope.direct.join(', ')}.`
    : `test-run report covers none of the changed package(s) ${scope.direct.join(', ')} ` +
        `(${testFiles.slice(0, 3).join(', ')}${testFiles.length > 3 ? ', …' : ''}). ` +
        `Run the tests of the packages this change touches, or record tool:test.`;
}
