/**
 * Binding a targeted `test-run:` report to the change it claims to test
 * (T12965).
 *
 * What a bound atom guarantees, exactly:
 *  1. **Freshness.** The report's own run time (vitest `startTime`, else the
 *     file's mtime) is not older than any of:
 *     - the committer time of HEAD and of every commit the branch adds over
 *       origin's default branch. A commit made after the run is refused —
 *       whatever it did, a deletion or rename included — so record the report
 *       before committing, or re-run after;
 *     - the newest working-tree modification of any path the branch changed
 *       against origin's default branch (committed, uncommitted or untracked;
 *       the report itself excluded) — or, with no origin to diff against, any
 *       uncommitted tracked edit;
 *     - for each uncommitted deletion (a rename's old path included, since a
 *       move keeps the file's own mtime), the modification time of the
 *       nearest existing directory it was removed from.
 *     Commit times and mtimes are recorded facts, not proof of content: this
 *     refuses stale reports, it does not attest that the report is honest.
 *  2. **Relevance.** When the change touches workspace packages only, at
 *     least one test file the report covers lies in a directly changed package
 *     or is itself a changed path. When the change is workspace-wide (a path
 *     outside every package, such as a root config or the lockfile), the report
 *     must be a full-suite run: it covers a test file in every workspace
 *     package that has tracked test files. Docs-only changes, and checkouts
 *     with no origin to diff against, are not judged.
 *  3. **Identity.** HEAD and the tool cache's tree hash (T12958) at verify time are
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
import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { discoveryEnv } from '../git/work-tree.js';
import {
  changedPathsSinceDefault,
  deriveAffectedPackages,
  listWorkspacePackages,
  originDefaultMergeBase,
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

/** Most branch commits whose committer time is read. */
const MAX_CHANGE_COMMITS = 1000;

/** A tracked test file, by the names vitest and jest pick up. */
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

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

/** Read-only git in `root`; null on any failure. */
function git(root: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf-8',
      env: discoveryEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function lines(output: string | null): string[] {
  return (output ?? '').split('\n').filter(Boolean);
}

function dirtyTracked(root: string): string[] {
  return lines(git(root, ['diff', '--name-only', '--no-renames', 'HEAD']));
}

/** The newest committer time among HEAD and the branch's own commits. */
function newestChangeCommit(root: string): { sha: string; at: number } | null {
  const mergeBase = originDefaultMergeBase(root);
  const rows = [
    ...lines(git(root, ['log', '-n', '1', '--format=%H %ct', 'HEAD'])),
    ...(mergeBase
      ? lines(
          git(root, [
            'log',
            '-n',
            String(MAX_CHANGE_COMMITS),
            '--format=%H %ct',
            `${mergeBase}..HEAD`,
          ]),
        )
      : []),
  ];
  let newest: { sha: string; at: number } | null = null;
  for (const row of rows) {
    const [sha, seconds] = row.split(' ');
    const at = Number(seconds) * 1000;
    if (sha && Number.isFinite(at) && (newest === null || at > newest.at)) newest = { sha, at };
  }
  return newest;
}

/**
 * When each uncommitted deletion happened, as far as the filesystem says: the
 * mtime of the nearest existing directory it was removed from. A rename's old
 * path is a deletion here (`--no-renames`), and a move keeps the moved file's
 * own mtime, so this is the only trace either leaves.
 */
function uncommittedDeletions(root: string): Array<{ path: string; dir: string; at: number }> {
  const deleted = lines(
    git(root, ['diff', '--name-only', '--no-renames', '--diff-filter=D', 'HEAD']),
  );
  return deleted.flatMap((path) => {
    let dir = dirname(resolve(root, path));
    while (!existsSync(dir) && dir.length > root.length) dir = dirname(dir);
    const at = mtimeOf(dir);
    return at === null ? [] : [{ path, dir, at }];
  });
}

/** Workspace package directories that hold at least one tracked test file. */
function packagesWithTests(root: string): Array<{ name: string; dir: string }> {
  const tracked = lines(git(root, ['ls-files', '--', '*.test.*', '*.spec.*'])).filter((f) =>
    TEST_FILE.test(f),
  );
  return listWorkspacePackages(root).filter((p) => tracked.some((f) => f.startsWith(`${p.dir}/`)));
}

function staleRefusal(ranAt: number, what: string, at: number): string {
  return (
    `test-run report is stale: it ran at ${new Date(ranAt).toISOString()}, but ${what} at ` +
    `${new Date(at).toISOString()}, after the run. Re-run the tests and record the fresh report ` +
    `(write reports to a gitignored path or outside the checkout).`
  );
}

/**
 * Refuse a report that is older than the change it claims to test, or that
 * does not cover it (see the module doc for exactly what this guarantees).
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
  const stale = (at: number): boolean => at > ranAt + MTIME_SLACK_MS;

  const commit = newestChangeCommit(root);
  if (commit !== null && stale(commit.at)) {
    return staleRefusal(
      ranAt,
      `commit ${commit.sha.slice(0, 12)} of the change was made`,
      commit.at,
    );
  }
  const reportRel = relative(root, reportPath).split('\\').join('/');
  const changed = changedPathsSinceDefault(root);
  const candidates = (changed ?? dirtyTracked(root)).filter((p) => p !== reportRel);
  let newest: { path: string; at: number } | null = null;
  for (const path of candidates) {
    const at = mtimeOf(resolve(root, path));
    if (at !== null && (newest === null || at > newest.at)) newest = { path, at };
  }
  if (newest !== null && stale(newest.at)) {
    return staleRefusal(ranAt, `${newest.path} was modified`, newest.at);
  }
  // Writing the report itself touches its own directory: there, only a change
  // after the report was written counts.
  const reportDir = dirname(reportPath);
  const reportWritten = mtimeOf(reportPath) ?? ranAt;
  const removed = uncommittedDeletions(root).find((d) =>
    d.dir === reportDir ? d.at > Math.max(ranAt, reportWritten) + MTIME_SLACK_MS : stale(d.at),
  );
  if (removed) {
    return staleRefusal(
      ranAt,
      `${removed.path} was deleted or moved (its directory changed)`,
      removed.at,
    );
  }

  if (changed === null || changed.length === 0) return null;
  const scope = deriveAffectedPackages(root, changed);
  if (scope.scope === 'full') {
    // A workspace-wide change can break any package: only a full-suite report
    // speaks for it, never an arbitrary targeted one.
    const missing = packagesWithTests(root).filter(
      (p) => !testFiles.some((f) => f.startsWith(`${p.dir}/`)),
    );
    if (missing.length === 0) return null;
    const names = missing.map((p) => p.name);
    return (
      `The change is workspace-wide (${scope.reason}), so a test-run report must cover the full ` +
      `suite, but it covers no test file of ${names.slice(0, 5).join(', ')}` +
      `${names.length > 5 ? `, … (${names.length} packages)` : ''}. Record a full tool:test, or a report of the whole suite.`
    );
  }
  if (scope.direct.length === 0) return null;
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
