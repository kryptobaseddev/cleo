/**
 * Binding a targeted `test-run:` report to the change it claims to test
 * (T12965).
 *
 * What a bound atom guarantees, exactly:
 *  1. **Freshness.** The report's own run time (vitest `startTime`, else the
 *     file's mtime) is not older than any of:
 *     - the committer time of HEAD and of every commit the branch adds over
 *       origin's default branch — unless the commits made after the run only
 *       recorded what was on disk when it ran: HEAD as of the run is in HEAD's
 *       reflog, and no path that differs between that commit and the working
 *       tree was modified, deleted or moved after the run (edit, run the
 *       tests, commit, then verify). Any other commit after the run is
 *       refused — a rebase onto a newer base included, since it rewrites the
 *       files it brings in — so bind the report before committing, or re-run;
 *     - the newest working-tree modification of any path the branch changed
 *       against origin's default branch (committed, uncommitted or untracked;
 *       the report itself excluded) — or, with no origin to diff against, any
 *       uncommitted tracked edit;
 *     - for each uncommitted deletion (a rename's old path included, since a
 *       move keeps the file's own mtime), the modification time of the
 *       nearest existing directory it was removed from.
 *     Commit times, reflog times and mtimes are recorded facts, not proof of
 *     content: this refuses stale reports, it does not attest that the report
 *     is honest.
 *  2. **Relevance.** When the change touches workspace packages only, the
 *     report covers a test file of every affected package that has one —
 *     each directly changed package and each package that depends on one,
 *     the set `tool:test-affected` runs. An affected package with no test
 *     file (tracked, or added by the change) cannot be covered and is
 *     recorded in `untestedPackages`, as `tool:test-affected` records a
 *     dependent with no test project; when no affected package has a test
 *     file, the report is refused. A test file covers its package when one
 *     of its tests passed (a file a `-t` filter skipped entirely covers
 *     nothing); one such file is enough: a targeted report speaks for the
 *     packages it ran, not for every file in them — merged CI does that. A
 *     workspace-wide change (a path outside every package, such as a root
 *     config or the lockfile) is refused outright: only a full-suite run
 *     speaks for it, and a report cannot show that it ran the whole suite
 *     (test configs exclude tracked test files, so per-package file counts
 *     prove nothing) — `tool:test` runs it. A report with no passed test at
 *     all is refused before any of this.
 *     Docs-only changes, and checkouts with no origin to diff against, are
 *     not judged.
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
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { discoveryEnv } from '../git/work-tree.js';
import {
  deriveAffectedPackages,
  listWorkspacePackages,
  originDefaultMergeBase,
  scopedChangedPaths,
  type WorkspacePackage,
} from './affected-packages.js';

/** The parts of a vitest (or jest) JSON report the binding reads. */
export interface TestRunReport {
  /** Epoch milliseconds the run started. */
  startTime?: number;
  /**
   * Per-file results: `name` is the test file path, `assertionResults` its
   * tests (`passed`, `failed`, `skipped`/`pending`, `todo`). A file's own
   * `status` says nothing about whether any test ran: vitest reports a file
   * whose every test a `-t` filter skipped as `passed`.
   */
  testResults?: Array<{
    status?: string;
    name?: string;
    assertionResults?: Array<{ status?: string }>;
  }>;
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

/** Most HEAD reflog entries read to find HEAD as of the run. */
const MAX_REFLOG_ENTRIES = 1000;

/** A tracked test file, by the names vitest and jest pick up. */
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * The report's test files that ran at least one passing test, relative to
 * `root` where they lie inside it, slash-separated, sorted and unique. A file
 * whose every test was skipped, filtered out (`-t`) or todo covers nothing,
 * and neither does a file that lists no `assertionResults` (T12965 review).
 *
 * @param report - Parsed report.
 * @param root - Execution root.
 * @returns The covered test files.
 * @task T12965
 */
export function coveredTestFiles(report: TestRunReport, root: string): string[] {
  if (!Array.isArray(report.testResults)) return [];
  const inside = (rel: string): boolean => !rel.startsWith('..') && !isAbsolute(rel);
  const files = report.testResults.flatMap((tr) => {
    if (typeof tr.name !== 'string' || tr.name === '') return [];
    const ran = Array.isArray(tr.assertionResults)
      ? tr.assertionResults.some((a) => a?.status === 'passed')
      : false;
    if (!ran) return [];
    let rel = isAbsolute(tr.name) ? relative(root, tr.name) : tr.name;
    // A symlinked spelling of the same checkout (macOS /var → /private/var).
    if (!inside(rel)) rel = relative(realpathOr(root), realpathOr(tr.name));
    return [inside(rel) ? rel.split('\\').join('/') : tr.name];
  });
  return [...new Set(files)].sort();
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
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
 * What HEAD pointed at when the tests ran: the newest HEAD reflog entry that
 * is not after the run. Null when the reflog does not reach back that far.
 */
function headAtRun(root: string, after: (at: number) => boolean): string | null {
  const rows = lines(
    git(root, [
      'reflog',
      'show',
      '--date=unix',
      '--format=%H %gd',
      '-n',
      String(MAX_REFLOG_ENTRIES),
      'HEAD',
    ]),
  );
  for (const row of rows) {
    const match = /^([0-9a-f]{40,64}) HEAD@\{(\d+)\}$/.exec(row);
    if (match?.[1] && match[2] && !after(Number(match[2]) * 1000)) return match[1];
  }
  return null;
}

/** The most recently modified of `paths` that still exists. */
function newestModified(
  root: string,
  paths: readonly string[],
): { path: string; at: number } | null {
  let newest: { path: string; at: number } | null = null;
  for (const path of paths) {
    const at = mtimeOf(resolve(root, path));
    if (at !== null && (newest === null || at > newest.at)) newest = { path, at };
  }
  return newest;
}

/**
 * When each deletion against `base` (HEAD: the uncommitted ones) happened, as
 * far as the filesystem says: the mtime of the nearest existing directory it
 * was removed from. A rename's old path is a deletion here (`--no-renames`),
 * and a move keeps the moved file's own mtime, so this is the only trace
 * either leaves.
 */
function deletionsSince(
  root: string,
  base: string,
): Array<{ path: string; dir: string; at: number }> | null {
  const out = git(root, ['diff', '--name-only', '--no-renames', '--diff-filter=D', base]);
  if (out === null) return null;
  return lines(out).flatMap((path) => {
    let dir = dirname(resolve(root, path));
    while (!existsSync(dir) && dir.length > root.length) dir = dirname(dir);
    const at = mtimeOf(dir);
    return at === null ? [] : [{ path, dir, at }];
  });
}

/** The run's own clock, and how a time compares with it. */
interface RunClock {
  /** When the run started (epoch ms). */
  ranAt: number;
  /** Whether a recorded time is after the run (beyond the mtime slack). */
  after: (at: number) => boolean;
  /** Absolute path of the report, symlinks resolved. */
  reportPath: string;
  /** The report's path relative to the root, symlinks resolved. */
  reportRel: string;
}

/**
 * The first deletion against `base` that happened after the run. Writing the
 * report itself touches its own directory: there, only a change after the
 * report was written counts.
 */
function deletedAfterRun(
  root: string,
  base: string,
  clock: RunClock,
): { path: string; at: number } | undefined {
  const reportDir = dirname(clock.reportPath);
  const reportWritten = mtimeOf(clock.reportPath) ?? clock.ranAt;
  return (deletionsSince(root, base) ?? []).find((d) =>
    realpathOr(d.dir) === reportDir
      ? d.at > Math.max(clock.ranAt, reportWritten) + MTIME_SLACK_MS
      : clock.after(d.at),
  );
}

/**
 * Why the commits made after the run may hold content the run did not see,
 * or null when they only recorded what was on disk when it ran (T12965
 * review): every path that differs between HEAD as of the run and the
 * working tree now is unmodified, and undeleted, since the run.
 */
function committedAfterRunUnseen(root: string, clock: RunClock): string | null {
  const atRun = headAtRun(root, clock.after);
  if (atRun === null)
    return 'HEAD as of the run is not in the reflog, so what the run saw is unknown';
  const differing = git(root, ['diff', '--name-only', '--no-renames', atRun]);
  if (differing === null)
    return `git could not diff ${atRun.slice(0, 12)} against the working tree`;
  const touched = newestModified(
    root,
    lines(differing).filter((p) => p !== clock.reportRel),
  );
  if (touched !== null && clock.after(touched.at)) {
    return `${touched.path} was modified at ${new Date(touched.at).toISOString()}, after the run`;
  }
  const removed = deletedAfterRun(root, atRun, clock);
  if (removed) {
    return `${removed.path} was deleted or moved at ${new Date(removed.at).toISOString()}, after the run`;
  }
  return null;
}

/** The first package (of `packages`, longest directory first) whose directory holds `path`. */
function ownerOf(
  path: string,
  packages: readonly WorkspacePackage[],
): WorkspacePackage | undefined {
  return packages.find((p) => path === p.dir || path.startsWith(`${p.dir}/`));
}

/**
 * Names of the workspace packages that hold a test file: a tracked one, or
 * one the change adds (an untracked or changed test file on disk).
 */
function packagesWithTestFiles(
  root: string,
  packages: readonly WorkspacePackage[],
  changed: readonly string[],
): Set<string> {
  const tracked = lines(git(root, ['ls-files', '--', '*.test.*', '*.spec.*']));
  const added = changed.filter((f) => mtimeOf(resolve(root, f)) !== null);
  const owners = new Set<string>();
  for (const file of [...tracked, ...added]) {
    if (!TEST_FILE.test(file)) continue;
    const owner = ownerOf(file, packages);
    if (owner) owners.add(owner.name);
  }
  return owners;
}

function staleRefusal(ranAt: number, what: string, at: number, remedy: string): string {
  return (
    `test-run report is stale: it ran at ${new Date(ranAt).toISOString()}, but ${what} at ` +
    `${new Date(at).toISOString()}, after the run. ${remedy}`
  );
}

/** The remedy for a report older than the change. */
const RERUN =
  'Re-run the tests and record the fresh report (write reports to a gitignored path or outside the checkout).';

/** Up to five names, then a count. */
function someNames(names: readonly string[]): string {
  return `${names.slice(0, 5).join(', ')}${names.length > 5 ? `, … (${names.length} packages)` : ''}`;
}

/** What binding a report decided. */
export type TestRunBinding =
  | {
      /** The report is refused. */
      ok: false;
      /** Older than the change (stale), or not covering it (insufficient). */
      codeName: 'E_EVIDENCE_STALE' | 'E_EVIDENCE_INSUFFICIENT';
      /** Why, and what to do instead. */
      reason: string;
    }
  | {
      /** The report may be bound. */
      ok: true;
      /** Affected packages with no test file, which no report could cover (sorted). */
      untestedPackages: string[];
    };

/**
 * Bind a report to the change it claims to test, or refuse it when it is
 * older than the change or does not cover it (see the module doc for exactly
 * what this guarantees).
 *
 * @param report - Parsed report.
 * @param reportPath - Absolute path of the report file.
 * @param root - The task's checkout (a git checkout, or not).
 * @param testFiles - {@link coveredTestFiles} of the report.
 * @returns The refusal, or the binding with the affected packages left untested.
 * @task T12965
 */
export function bindTestRunReport(
  report: TestRunReport,
  reportPath: string,
  root: string,
  testFiles: readonly string[],
): TestRunBinding {
  const ranAt =
    typeof report.startTime === 'number' && Number.isFinite(report.startTime)
      ? report.startTime
      : mtimeOf(reportPath);
  if (ranAt === null) return { ok: true, untestedPackages: [] };
  const clock: RunClock = {
    ranAt,
    after: (at) => at > ranAt + MTIME_SLACK_MS,
    reportPath: realpathOr(reportPath),
    reportRel: relative(realpathOr(root), realpathOr(reportPath)).split('\\').join('/'),
  };
  const stale = (reason: string): TestRunBinding => ({
    ok: false,
    codeName: 'E_EVIDENCE_STALE',
    reason,
  });
  const refuse = (reason: string): TestRunBinding => ({
    ok: false,
    codeName: 'E_EVIDENCE_INSUFFICIENT',
    reason,
  });

  const commit = newestChangeCommit(root);
  if (commit !== null && clock.after(commit.at)) {
    const unseen = committedAfterRunUnseen(root, clock);
    if (unseen !== null) {
      return stale(
        staleRefusal(
          ranAt,
          `commit ${commit.sha.slice(0, 12)} of the change was made`,
          commit.at,
          `It may hold content the run did not see: ${unseen}. Bind test-run before committing ` +
            '(cleo verify right after the run), or re-run the tests and record the fresh report.',
        ),
      );
    }
  }
  const changes = scopedChangedPaths(root);
  const changed = changes?.paths ?? null;
  const newest = newestModified(
    root,
    (changed ?? dirtyTracked(root)).filter((p) => p !== clock.reportRel),
  );
  if (newest !== null && clock.after(newest.at)) {
    return stale(staleRefusal(ranAt, `${newest.path} was modified`, newest.at, RERUN));
  }
  const removed = deletedAfterRun(root, 'HEAD', clock);
  if (removed) {
    return stale(
      staleRefusal(
        ranAt,
        `${removed.path} was deleted or moved (its directory changed)`,
        removed.at,
        RERUN,
      ),
    );
  }

  // T13135: a change whose every path was set aside as out of scope has
  // nothing a targeted report can speak for; it must not pass vacuously.
  if (changes !== null && changes.paths.length === 0 && changes.excluded.length > 0) {
    return refuse(
      `Every path this change touches is excluded from evidence scope (${changes.excluded.slice(0, 5).join(', ')}${changes.excluded.length > 5 ? ', …' : ''}), ` +
        'so a test-run report cannot speak for it. Record tool:test, or ci:<pr> once the PR merges.',
    );
  }
  if (changed === null || changed.length === 0) return { ok: true, untestedPackages: [] };
  const scope = deriveAffectedPackages(root, changed);
  if (scope.scope === 'full') {
    // A workspace-wide change can break any package: only a full-suite run
    // speaks for it, and no report shows it ran the whole suite.
    return refuse(
      `The change is workspace-wide (${scope.reason}), so only a full-suite run speaks for it, ` +
        'and a test-run report cannot show that it ran the whole suite (test configs exclude ' +
        'tracked test files, so file counts prove nothing). Record tool:test, which runs the ' +
        'full suite for a workspace-wide change, or ci:<pr> once the PR merges.',
    );
  }
  if (scope.direct.length === 0) return { ok: true, untestedPackages: [] };
  // Longest directory first, so a file belongs to its innermost package.
  const workspace = listWorkspacePackages(root).sort((a, b) => b.dir.length - a.dir.length);
  const withTests = packagesWithTestFiles(root, workspace, changed);
  const required = scope.packages.filter((name) => withTests.has(name));
  const untestedPackages = scope.packages.filter((name) => !withTests.has(name));
  if (required.length === 0) {
    return refuse(
      `No test file exists in the changed package(s) ${someNames(scope.direct)} or in any package ` +
        'that depends on them, so a targeted test-run cannot cover the change. Record tool:test.',
    );
  }
  const covered = new Set(testFiles.flatMap((f) => ownerOf(f, workspace)?.name ?? []));
  const missing = required.filter((name) => !covered.has(name));
  if (missing.length === 0) return { ok: true, untestedPackages };
  const labelled = missing.map((name) =>
    scope.direct.includes(name) ? `${name} (changed)` : `${name} (depends on a changed package)`,
  );
  return refuse(
    `${
      testFiles.length === 0
        ? 'test-run report lists no test files, so it covers no test file of'
        : 'test-run report covers no test file of'
    } ${someNames(labelled)}. A targeted report must cover every affected package that has ` +
      'tests — each changed package and each package that depends on one, the set ' +
      'tool:test-affected runs. Run those tests and record the report, or record ' +
      'tool:test-affected (or tool:test).',
  );
}
