/**
 * Binding a targeted `test-run:` report to the change it claims to test
 * (T12965).
 *
 * What a bound atom guarantees, exactly:
 *  1. **Freshness.** The report's own run time (vitest `startTime`, Playwright
 *     `stats.startTime`, else the file's mtime) is not older than any of:
 *     - the committer time of HEAD and of every commit the branch adds over
 *       origin's default branch — unless the commits made after the run only
 *       recorded what was on disk when it ran: HEAD as of the run is in HEAD's
 *       reflog (that of the linked worktree holding the report, when it is
 *       not the bound checkout; T13579), and no path that differs between that commit and the working
 *       tree was modified, deleted or moved after the run (edit, run the
 *       tests, commit, then verify). Any other commit after the run is
 *       refused — a rebase onto a newer base included, since it rewrites the
 *       files it brings in — so bind the report before committing, or re-run.
 *       One exception (T13784, `test-run:` only): on the default branch, when
 *       HEAD is on origin's default branch and HEAD as of the run is its
 *       ancestor, the commits after the run are main moving on, not the
 *       change; the atom records HEAD as of the run (`runHeadSha`), and the
 *       post-merge stand-in refuses it when those commits touched the
 *       change's files or the test files it ran;
 *     - the newest working-tree modification of any path the branch changed
 *       against origin's default branch (committed, uncommitted or untracked;
 *       the report itself excluded) — or, with no origin to diff against, any
 *       uncommitted tracked edit — except a path that a checkout or merge
 *       after the run rewrote with identical bytes (HEAD moved and the file
 *       equals its blob at both HEADs; T13567, T13569). A bare touch still
 *       stales: without a run-time fingerprint it looks like a revert;
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
 *     prove nothing) — `tool:test` runs it. A path outside every package
 *     in a top-level directory with test files (a `tooling/` beside the
 *     workspace) is not workspace-wide: the report must pass every test file
 *     outside the packages under that top-level directory (T13754). A
 *     report with no passed test at all is refused before any of this.
 *     A standalone project (no workspace declared, T13403) is one package,
 *     its root: a change inside the root is that package's, never
 *     workspace-wide, and since that package is the whole project the report
 *     must also have passed every test file the change adds or edits.
 *     Docs-only changes, and checkouts with no origin to diff against, are
 *     not judged. The `test-run:` reports of one evidence write are judged
 *     together: a vitest report and a Playwright report ({@link playwrightTestRun})
 *     cover a change's unit and e2e files between them (T14031).
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
import type { EvidenceAtom } from '@cleocode/contracts';
import { discoveryEnv } from '../git/work-tree.js';
import { TARGETED_RUN_COVERAGE } from '../release/ci-evidence.js';
import {
  cleoConfigSchemaFor,
  dependentsClosure,
  deriveAffectedPackages,
  inPackageDir,
  listWorkspacePackages,
  originDefaultMergeBase,
  type ScopedChangedPaths,
  scopedChangedPaths,
  TEST_FILE,
  typecheckOnlyPackages,
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

/**
 * A report adapted to the vitest shape the binding and the counter checks
 * read: Playwright JSON (T14031), JUnit XML and libtest JSON (T14084).
 */
export type AdaptedTestRun = {
  readonly startTime?: number;
  readonly testResults: Array<{
    status: string;
    name: string;
    assertionResults: Array<{ status: string }>;
  }>;
  readonly numTotalTests: number;
  readonly numPassedTests: number;
  readonly numFailedTests: number;
  readonly numPendingTests: number;
  readonly numTodoTests: number;
};

/** An adapted report that cannot stand as test-run evidence, and why. */
export interface AdaptedTestRunRefusal {
  readonly refusal: string;
  readonly codeName: 'E_EVIDENCE_INVALID' | 'E_EVIDENCE_TESTS_FAILED';
}

/** A Playwright JSON report in the vitest shape (T14031). */
export type PlaywrightTestRun = AdaptedTestRun;

/** A Playwright report that cannot stand as test-run evidence (T14031). */
export type PlaywrightTestRunRefusal = AdaptedTestRunRefusal;

/** Playwright's per-test outcome, as a vitest assertion status. */
const PLAYWRIGHT_STATUS = {
  expected: 'passed',
  flaky: 'passed',
  unexpected: 'failed',
  skipped: 'skipped',
} as const;

/** A Playwright test outcome (`tests[].status`). */
type PlaywrightStatus = keyof typeof PLAYWRIGHT_STATUS;

/** Every {@link PlaywrightStatus}, in `stats` key order. */
const PLAYWRIGHT_STATUSES: readonly PlaywrightStatus[] = [
  'expected',
  'skipped',
  'unexpected',
  'flaky',
];

function isPlaywrightStatus(value: unknown): value is PlaywrightStatus {
  return PLAYWRIGHT_STATUSES.some((status) => status === value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Adapt a Playwright JSON report (`--reporter=json`) to the vitest shape, so
 * an e2e spec can be test-run evidence (T14031); null when `report` is not
 * one (no `suites` array and numeric `stats.expected`).
 *
 * The files run are the suites' `file`s (each spec's own `file` when set),
 * resolved against `config.rootDir`, which Playwright makes them relative to.
 * Counts come from the spec results, one per test and project: `expected`
 * and `flaky` (passed on retry) pass, `unexpected` fails, `skipped` is
 * pending. They must equal `stats`, and the run time is `stats.startTime`. A
 * report listing top-level `errors` (no tests found, a config or global setup
 * failure) is refused; the rest — vacuous, skipped-only or failing runs — is
 * refused by the same checks as a vitest report.
 *
 * @param report - A parsed test-run report.
 * @returns The adapted report, a refusal, or null when it is not Playwright's.
 * @task T14031
 */
export function playwrightTestRun(
  report: Readonly<Record<string, unknown>>,
): PlaywrightTestRun | PlaywrightTestRunRefusal | null {
  const { stats, suites, config, errors } = report;
  if (!Array.isArray(suites) || !isRecord(stats) || typeof stats.expected !== 'number') return null;
  if (Array.isArray(errors) && errors.length > 0) {
    const first =
      isRecord(errors[0]) && typeof errors[0].message === 'string' ? errors[0].message : '';
    return {
      refusal: `Playwright report lists ${errors.length} error(s)${first ? `: ${first.split('\n')[0]}` : ''}`,
      codeName: 'E_EVIDENCE_TESTS_FAILED',
    };
  }
  const files = new Map<string, PlaywrightStatus[]>();
  let badStatus: unknown;
  const walk = (suite: unknown, inherited: string | null): void => {
    if (!isRecord(suite)) return;
    const file = typeof suite.file === 'string' && suite.file !== '' ? suite.file : inherited;
    for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
      if (!isRecord(spec) || !Array.isArray(spec.tests)) continue;
      const specFile = typeof spec.file === 'string' && spec.file !== '' ? spec.file : file;
      if (specFile === null) continue;
      const statuses = files.get(specFile) ?? [];
      for (const test of spec.tests) {
        const status = isRecord(test) ? test.status : undefined;
        if (isPlaywrightStatus(status)) statuses.push(status);
        else badStatus ??= status ?? null;
      }
      files.set(specFile, statuses);
    }
    for (const child of Array.isArray(suite.suites) ? suite.suites : []) walk(child, file);
  };
  for (const suite of suites) walk(suite, null);
  if (badStatus !== undefined)
    return {
      refusal: `Playwright report has a test with status ${JSON.stringify(badStatus)}; expected one of ${PLAYWRIGHT_STATUSES.join(', ')}`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  const all = [...files.values()].flat();
  const count = (status: PlaywrightStatus): number => all.filter((s) => s === status).length;
  for (const key of PLAYWRIGHT_STATUSES) {
    if (stats[key] !== count(key))
      return {
        refusal: `Playwright report's stats.${key} is ${JSON.stringify(stats[key])}, but its spec results count ${count(key)}`,
        codeName: 'E_EVIDENCE_INVALID',
      };
  }
  const rootDir = isRecord(config) && typeof config.rootDir === 'string' ? config.rootDir : null;
  const startTime = typeof stats.startTime === 'string' ? Date.parse(stats.startTime) : Number.NaN;
  return {
    ...(Number.isFinite(startTime) ? { startTime } : {}),
    numTotalTests: all.length,
    numPassedTests: count('expected') + count('flaky'),
    numFailedTests: count('unexpected'),
    numPendingTests: count('skipped'),
    numTodoTests: 0,
    testResults: [...files].map(([file, statuses]) => ({
      name: rootDir === null ? file : resolve(rootDir, file),
      status: statuses.includes('unexpected') ? 'failed' : 'passed',
      assertionResults: statuses.map((s) => ({ status: PLAYWRIGHT_STATUS[s] })),
    })),
  };
}

/** A JUnit testcase outcome, as a vitest assertion status. */
type JunitOutcome = 'passed' | 'failed' | 'skipped';

/** Decode the five predefined XML entities and numeric character references. */
function xmlText(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#([0-9]+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** The attributes of one XML start tag's attribute text. */
function xmlAttributes(text: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const match of text.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
    attrs.set(match[1]!, xmlText(match[2] ?? match[3] ?? ''));
  return attrs;
}

/** A count attribute, when present and a non-negative integer. */
function countAttribute(attrs: Map<string, string>, name: string): number | null {
  const raw = attrs.get(name);
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

/**
 * Adapt a JUnit XML report to the vitest shape, so a runner without a JSON
 * reporter can be test-run evidence (T14084): cargo nextest
 * (`[profile.*.junit]`), pytest `--junitxml`, and most other runners; null
 * when `text` is not JUnit XML (no `<testsuite` element).
 *
 * Each `<testcase>` is one test: a `<failure>` or `<error>` child fails it, a
 * `<skipped>` child makes it pending, otherwise it passed. Its file is the
 * testcase's `file` attribute, else its suite's, else the suite name (pytest
 * xunit1 and Jest record files; nextest and pytest xunit2 name binaries and
 * classes, which then cover no file). A `tests`, `failures`, `errors` or
 * `skipped` total the report states must equal its testcases, and the run
 * time is the earliest suite `timestamp`. Nested `<testsuite>` elements are
 * refused rather than undercounted.
 *
 * @param text - The report file's text.
 * @returns The adapted report, a refusal, or null when it is not JUnit XML.
 * @task T14084
 */
export function junitTestRun(text: string): AdaptedTestRun | AdaptedTestRunRefusal | null {
  const body = text.replace(/^﻿/, '').replace(/<!--[\s\S]*?-->/g, '');
  if (!/^\s*</.test(body) || !/<testsuite\b/.test(body)) return null;
  const files = new Map<string, JunitOutcome[]>();
  const stated = { tests: 0, failed: 0, skipped: 0, any: false };
  let startTime = Number.POSITIVE_INFINITY;
  const suites = body.matchAll(/<testsuite\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testsuite>)/g);
  for (const suite of suites) {
    // A nested suite would be cut at its first closing tag and undercounted.
    if (/<testsuite\b/.test(suite[2] ?? ''))
      return {
        refusal:
          'JUnit report nests <testsuite> elements, which CLEO does not read; write one level of ' +
          '<testsuite> under <testsuites> (pytest --junitxml, cargo nextest and jest-junit do)',
        codeName: 'E_EVIDENCE_INVALID',
      };
    const attrs = xmlAttributes(suite[1] ?? '');
    const tests = countAttribute(attrs, 'tests');
    if (tests !== null) {
      stated.any = true;
      stated.tests += tests;
      stated.failed +=
        (countAttribute(attrs, 'failures') ?? 0) + (countAttribute(attrs, 'errors') ?? 0);
      stated.skipped += countAttribute(attrs, 'skipped') ?? countAttribute(attrs, 'disabled') ?? 0;
    }
    const at = Date.parse(attrs.get('timestamp') ?? '');
    if (Number.isFinite(at)) startTime = Math.min(startTime, at);
    const suiteFile = attrs.get('file') || attrs.get('name') || 'junit';
    const cases = (suite[2] ?? '').matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g);
    for (const testcase of cases) {
      const caseAttrs = xmlAttributes(testcase[1] ?? '');
      const inner = testcase[2] ?? '';
      const outcome: JunitOutcome = /<(?:failure|error)\b/.test(inner)
        ? 'failed'
        : /<skipped\b/.test(inner)
          ? 'skipped'
          : 'passed';
      const file = caseAttrs.get('file') || suiteFile;
      files.set(file, [...(files.get(file) ?? []), outcome]);
    }
  }
  const all = [...files.values()].flat();
  const count = (outcome: JunitOutcome): number => all.filter((o) => o === outcome).length;
  if (
    stated.any &&
    (stated.tests !== all.length ||
      stated.failed !== count('failed') ||
      stated.skipped !== count('skipped'))
  )
    return {
      refusal:
        `JUnit report states ${stated.tests} tests (${stated.failed} failed or errored, ${stated.skipped} skipped), ` +
        `but its testcases count ${all.length} (${count('failed')} failed, ${count('skipped')} skipped)`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  return {
    ...(Number.isFinite(startTime) ? { startTime } : {}),
    numTotalTests: all.length,
    numPassedTests: count('passed'),
    numFailedTests: count('failed'),
    numPendingTests: count('skipped'),
    numTodoTests: 0,
    testResults: [...files].map(([file, outcomes]) => ({
      name: file,
      status: outcomes.includes('failed') ? 'failed' : 'passed',
      assertionResults: outcomes.map((status) => ({ status })),
    })),
  };
}

/** libtest's per-test events, as vitest assertion statuses. */
const LIBTEST_STATUS = { ok: 'passed', failed: 'failed', ignored: 'skipped' } as const;

/** A finished libtest test event. */
type LibtestEvent = keyof typeof LIBTEST_STATUS;

function isLibtestEvent(value: unknown): value is LibtestEvent {
  return value === 'ok' || value === 'failed' || value === 'ignored';
}

/**
 * Adapt libtest JSON lines to the vitest shape (T14084): `cargo test --
 * -Z unstable-options --format json --report-time`, or cargo nextest
 * `--message-format libtest-json`; null when `text` is not libtest JSON (a
 * line that is not a JSON object with `type` `suite` or `test`).
 *
 * Each finished `test` event is one test (`ok` passes, `failed` fails,
 * `ignored` is pending). Tests are grouped by their binary, the name before a
 * `$` (nextest) or `::`. Libtest names no files, so a report covers none. Each
 * suite's `passed`/`failed`/`ignored` summary must equal its test events, and
 * every `started` suite must finish with as many test events as its
 * `test_count`: a killed run is refused as truncated, never read as complete.
 * Suites are tracked per binary when nextest's `libtest-json-plus` names them
 * (its suites of parallel binaries interleave); otherwise one at a time.
 *
 * @param text - The report file's text.
 * @returns The adapted report, a refusal, or null when it is not libtest JSON.
 * @task T14084
 */
export function libtestTestRun(text: string): AdaptedTestRun | AdaptedTestRunRefusal | null {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const events: Array<Readonly<Record<string, unknown>>> = [];
  for (const line of lines) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return null;
    }
    if (!isRecord(event) || (event.type !== 'suite' && event.type !== 'test')) return null;
    events.push(event);
  }
  const groups = new Map<string, LibtestEvent[]>();
  const summary = { passed: 0, failed: 0, ignored: 0, any: false };
  // A killed run leaves a suite started and never finished; its partial
  // counts must not read as a complete run.
  const truncated = (detail: string): AdaptedTestRunRefusal => ({
    refusal: `the libtest report is truncated (a suite started but never finished): the run did not complete; ${detail}`,
    codeName: 'E_EVIDENCE_INVALID',
  });
  // cargo test and nextest's libtest-json write one suite at a time, but
  // nextest's libtest-json-plus streams suites of parallel binaries
  // interleaved; its suite events then name the binary (`nextest.crate` and
  // `nextest.test_binary`), as its test names do (`<crate>::<binary>$<test>`).
  const suiteKey = (event: Readonly<Record<string, unknown>>): string => {
    const meta = event.nextest;
    return isRecord(meta) && typeof meta.crate === 'string' && typeof meta.test_binary === 'string'
      ? `${meta.crate}::${meta.test_binary}`
      : '';
  };
  const keyed = events.some((event) => event.type === 'suite' && suiteKey(event) !== '');
  const open = new Map<string, { expected: number | null; seen: number }>();
  for (const event of events) {
    if (event.type === 'suite') {
      const key = keyed ? suiteKey(event) : '';
      if (event.event === 'started') {
        if (open.has(key))
          return truncated(
            `a suite${key ? ` of ${key}` : ''} started before the previous one finished`,
          );
        const expected = event.test_count;
        open.set(key, {
          expected: typeof expected === 'number' && Number.isInteger(expected) ? expected : null,
          seen: 0,
        });
        continue;
      }
      if (event.event !== 'ok' && event.event !== 'failed') continue;
      const suite = open.get(key);
      if (suite !== undefined && suite.expected !== null && suite.seen !== suite.expected)
        return truncated(
          `a suite${key ? ` of ${key}` : ''} started with test_count ${suite.expected} but reported ${suite.seen} finished tests`,
        );
      open.delete(key);
      summary.any = true;
      for (const field of ['passed', 'failed', 'ignored'] as const) {
        const value = event[field];
        if (typeof value === 'number' && Number.isInteger(value) && value >= 0)
          summary[field] += value;
      }
      continue;
    }
    if (!isLibtestEvent(event.event)) continue;
    const name = typeof event.name === 'string' ? event.name : '';
    const suite = open.get(keyed && name.includes('$') ? name.split('$')[0]! : '');
    if (suite !== undefined) suite.seen += 1;
    const binary = name.includes('$') ? name.split('$')[0]! : name.split('::')[0] || 'libtest';
    groups.set(binary, [...(groups.get(binary) ?? []), event.event]);
  }
  if (open.size > 0)
    return truncated(
      `${[...open.keys()].map((key) => key || 'the last suite').join(', ')} has no ok or failed event`,
    );
  const all = [...groups.values()].flat();
  const count = (event: LibtestEvent): number => all.filter((e) => e === event).length;
  if (
    summary.any &&
    (summary.passed !== count('ok') ||
      summary.failed !== count('failed') ||
      summary.ignored !== count('ignored'))
  )
    return {
      refusal:
        `libtest summary states ${summary.passed} passed, ${summary.failed} failed, ${summary.ignored} ignored, ` +
        `but its test events count ${count('ok')}, ${count('failed')}, ${count('ignored')}`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  return {
    numTotalTests: all.length,
    numPassedTests: count('ok'),
    numFailedTests: count('failed'),
    numPendingTests: count('ignored'),
    numTodoTests: 0,
    testResults: [...groups].map(([binary, outcomes]) => ({
      name: binary,
      status: outcomes.includes('failed') ? 'failed' : 'passed',
      assertionResults: outcomes.map((event) => ({ status: LIBTEST_STATUS[event] })),
    })),
  };
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

/**
 * The linked worktree of this repository that holds the report, when it is
 * not `root`'s own checkout; else null (T13579). A HEAD reflog is per
 * worktree, so a report produced in one worktree and verified from another
 * must be judged against the reflog of the worktree that ran it.
 */
function reportWorktree(root: string, reportPath: string): string | null {
  const dir = dirname(reportPath);
  const top = (cwd: string): string | null =>
    git(cwd, ['rev-parse', '--show-toplevel'])?.trim() || null;
  const common = (cwd: string): string | null =>
    git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])?.trim() || null;
  const reportTop = top(dir);
  const rootTop = top(root);
  if (reportTop === null || rootTop === null || realpathOr(reportTop) === realpathOr(rootTop))
    return null;
  const shared = common(dir);
  return shared !== null && shared === common(root) ? reportTop : null;
}

/** HEAD as of the run, from the reflog of the worktree that ran it ({@link reportWorktree}). */
function headAtRunFor(root: string, clock: RunClock): string | null {
  return headAtRun(reportWorktree(root, clock.reportPath) ?? root, clock.after);
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
 * The most recently modified of `paths` modified after the run, leaving out a
 * path that a checkout or merge after the run rewrote with the same bytes
 * (T13567, narrowed by T13569).
 *
 * A path is left out only when all hold: HEAD moved after the run (HEAD as of
 * the run, {@link headAtRun}, is not HEAD now), and the file's current blob
 * (`git hash-object`) equals its blob both at HEAD now and at HEAD as of the
 * run — the move rewrote it without changing it. Nothing else is exempt: a
 * bare `touch`, or a file that was dirty during the run and reverted to HEAD
 * afterwards, cannot be told apart without a run-time content fingerprint, and
 * a false pass is worse than a needless re-run, so its newer mtime still
 * stales the report. When the reflog does not reach the run, every mtime after
 * it counts.
 */
function modifiedAfterRun(
  root: string,
  paths: readonly string[],
  clock: RunClock,
): { path: string; at: number } | null {
  const after = paths
    .map((path) => ({ path, at: mtimeOf(resolve(root, path)) }))
    .filter((p): p is { path: string; at: number } => p.at !== null && clock.after(p.at))
    .sort((a, b) => b.at - a.at);
  if (after.length === 0) return null;
  const blob = (args: readonly string[]): string | null => git(root, args)?.trim() || null;
  const atRun = headAtRunFor(root, clock);
  const head = blob(['rev-parse', 'HEAD']);
  if (atRun === null || head === null || head === atRun) return after[0] ?? null;
  return (
    after.find((p) => {
      const now = blob(['hash-object', '--', p.path]);
      const at = (commit: string): string | null =>
        blob(['rev-parse', '--verify', '--quiet', `${commit}:./${p.path}`]);
      return now === null || now !== at(head) || now !== at(atRun);
    }) ?? null
  );
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
  const atRun = headAtRunFor(root, clock);
  if (atRun === null) {
    // T13702: name the reflog read. It is the one of the worktree holding the
    // report, so a receipt copied into another worktree is judged there.
    const tree = reportWorktree(root, clock.reportPath) ?? root;
    const log =
      git(tree, ['rev-parse', '--path-format=absolute', '--git-path', 'logs/HEAD'])?.trim() ||
      'its HEAD reflog';
    return (
      `HEAD as of the run is not in the reflog of ${tree} (${log}), so what the run saw is unknown. ` +
      'The reflog read is that of the worktree holding the report: keep a receipt in the worktree it ran in'
    );
  }
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

/**
 * HEAD as of the run, when every commit made after it is one that landed on
 * origin's default branch (T13784): HEAD is contained in origin's default
 * branch and HEAD as of the run is an ancestor of it — a pull of main, not a
 * commit of the change. Null otherwise.
 */
function landedSinceRun(root: string, clock: RunClock): string | null {
  const head = git(root, ['rev-parse', 'HEAD'])?.trim();
  if (!head || originDefaultMergeBase(root)?.trim() !== head) return null;
  const atRun = headAtRunFor(root, clock);
  if (atRun === null || atRun === head) return null;
  return git(root, ['merge-base', '--is-ancestor', atRun, head]) === null ? null : atRun;
}

/** The first package (of `packages`, longest directory first) whose directory holds `path`. */
function ownerOf(
  path: string,
  packages: readonly WorkspacePackage[],
): WorkspacePackage | undefined {
  return packages.find((p) => inPackageDir(path, p.dir));
}

/**
 * The changed paths that are test files still on disk (vitest and jest
 * naming), sorted: the tests a change adds or edits (T13403).
 *
 * @param root - Execution root.
 * @param changed - Root-relative changed paths.
 * @returns The changed test files that exist.
 * @task T13403
 */
export function changedTestFiles(root: string, changed: readonly string[]): string[] {
  return changed
    .filter((f) => TEST_FILE.test(f) && mtimeOf(resolve(root, f)) !== null)
    .map((f) => f.split('\\').join('/'))
    .sort();
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
      /** HEAD as of the run, when main moved on after it ({@link ReportFreshness}, T13784). */
      runHeadSha?: string;
      /** Changed CLEO config left to `tool:config-schema` (T13778). */
      configPaths?: string[];
      /** Dependents of a declared generated package left to a typecheck (T13783). */
      typecheckDirs?: string[];
      /** Untracked files outside the change, set aside at bind time (T14000). */
      untrackedSetAside?: string[];
    };

/** What the freshness check of a report or receipt decided. */
export type ReportFreshness =
  | {
      /** Older than the change. */
      ok: false;
      codeName: 'E_EVIDENCE_STALE';
      reason: string;
    }
  | {
      ok: true;
      /** False when the report has no run time at all, so nothing is judged. */
      judged: boolean;
      /** The change's scoped paths, or null outside git / with no origin. */
      changes: ScopedChangedPaths | null;
      /**
       * HEAD as of the run, when the only commits after it landed on origin's
       * default branch (T13784, `test-run` only): the run did not see them, so
       * the atom records it and the post-merge stand-in refuses the report when
       * they touched the change's files or the tests it ran.
       */
      runHeadSha?: string;
    };

/**
 * Whether a report (or receipt) ran after every part of the change it claims
 * to speak for — point 1 of the module doc, shared by `test-run:` and
 * `qa-run:` (T13427).
 *
 * @param startTime - The run's own start time (epoch ms), if it states one;
 *   else the file's mtime is the run time.
 * @param reportPath - Absolute path of the report file.
 * @param root - The task's checkout.
 * @param atom - The atom kind, named in the remedy.
 * @returns The stale refusal, or the change's scoped paths for the relevance check.
 * @task T12965
 * @task T13427
 */
export function reportFreshness(
  startTime: unknown,
  reportPath: string,
  root: string,
  atom: 'test-run' | 'qa-run',
): ReportFreshness {
  const ranAt =
    typeof startTime === 'number' && Number.isFinite(startTime) ? startTime : mtimeOf(reportPath);
  if (ranAt === null) return { ok: true, judged: false, changes: null };
  const clock: RunClock = {
    ranAt,
    after: (at) => at > ranAt + MTIME_SLACK_MS,
    reportPath: realpathOr(reportPath),
    reportRel: relative(realpathOr(root), realpathOr(reportPath)).split('\\').join('/'),
  };
  const stale = (reason: string): ReportFreshness => ({
    ok: false,
    codeName: 'E_EVIDENCE_STALE',
    reason,
  });
  const rerun =
    atom === 'test-run'
      ? RERUN
      : 'Re-run the check and record the fresh receipt (write receipts to a gitignored path or outside the checkout).';

  const commit = newestChangeCommit(root);
  let runHeadSha: string | undefined;
  if (commit !== null && clock.after(commit.at)) {
    // T13784: on the default branch, main moving on after the run is not the
    // change. Record HEAD as of the run; what those commits touched is judged
    // against the change's own files when the report stands in after merge.
    runHeadSha = (atom === 'test-run' ? landedSinceRun(root, clock) : null) ?? undefined;
    const unseen = runHeadSha ? null : committedAfterRunUnseen(root, clock);
    if (unseen !== null) {
      return stale(
        staleRefusal(
          ranAt,
          `commit ${commit.sha.slice(0, 12)} of the change was made`,
          commit.at,
          `It may hold content the run did not see: ${unseen}. Bind ${atom} before committing ` +
            `(cleo verify right after the run), or ${atom === 'test-run' ? 're-run the tests and record the fresh report' : 're-run the check and record the fresh receipt'}.`,
        ),
      );
    }
  }
  // T14000, T14125: untracked files are set aside (and recorded by the
  // binding), never judged as this change.
  const changes = scopedChangedPaths(root);
  const newest = modifiedAfterRun(
    root,
    (changes?.paths ?? dirtyTracked(root)).filter((p) => p !== clock.reportRel),
    clock,
  );
  if (newest !== null && clock.after(newest.at)) {
    return stale(staleRefusal(ranAt, `${newest.path} was modified`, newest.at, rerun));
  }
  const removed = deletedAfterRun(root, 'HEAD', clock);
  if (removed) {
    return stale(
      staleRefusal(
        ranAt,
        `${removed.path} was deleted or moved (its directory changed)`,
        removed.at,
        rerun,
      ),
    );
  }
  return { ok: true, judged: true, changes, ...(runHeadSha ? { runHeadSha } : {}) };
}

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
  const fresh = reportFreshness(report.startTime, reportPath, root, 'test-run');
  if (!fresh.ok) return fresh;
  if (!fresh.judged) return { ok: true, untestedPackages: [] };
  const run = fresh.runHeadSha ? { runHeadSha: fresh.runHeadSha } : {};
  const changes = fresh.changes;
  const changed = changes?.paths ?? null;
  const refuse = (reason: string): TestRunBinding => ({
    ok: false,
    codeName: 'E_EVIDENCE_INSUFFICIENT',
    reason,
  });

  // T13135: a change whose every path was set aside as out of scope has
  // nothing a targeted report can speak for; it must not pass vacuously.
  if (changes !== null && changes.paths.length === 0 && changes.excluded.length > 0) {
    return refuse(
      `Every path this change touches is excluded from evidence scope (${changes.excluded.slice(0, 5).join(', ')}${changes.excluded.length > 5 ? ', …' : ''}), ` +
        'so a test-run report cannot speak for it. Record tool:test, or ci:<pr> once the PR merges.',
    );
  }
  const setAside =
    changes !== null && changes.untrackedSetAside.length > 0
      ? { untrackedSetAside: changes.untrackedSetAside }
      : {};
  if (changed === null || changed.length === 0)
    return { ok: true, untestedPackages: [], ...run, ...setAside };
  const covered = testRunCoversChange(root, changed, testFiles);
  return covered.ok ? { ...covered, ...run, ...setAside } : covered;
}

/**
 * Whether the test files a report ran cover a change — point 2 of the module
 * doc, applied to an explicit list of changed paths. {@link bindTestRunReport}
 * passes the branch's diff; `cleo complete` passes a merged change's own files
 * when it judges a run recorded after the merge (T13623).
 *
 * CLEO-owned config files are left to `tool:config-schema` (T13778): the
 * report is judged over the rest, and a binding names them as `configPaths`,
 * which the gate then requires a config-schema result for.
 *
 * @param root - The checkout the test files are relative to.
 * @param changed - The change's paths, relative to `root` (non-empty).
 * @param testFiles - Test files the report ran with a passing test.
 * @returns The refusal, or the binding with the affected packages left untested.
 * @task T12965
 * @task T13623
 * @task T13778
 */
export function testRunCoversChange(
  root: string,
  changed: readonly string[],
  testFiles: readonly string[],
): TestRunBinding {
  const need = testRunRequirement(root, changed);
  const covered = testRunMeetsRequirement(root, need, testFiles);
  return covered.ok && need.configPaths.length > 0
    ? { ...covered, configPaths: need.configPaths }
    : covered;
}

/**
 * What a targeted test-run report must run to speak for a change — point 2 of
 * the module doc as data. {@link testRunCoversChange} judges a report against
 * it, and `cleo tasks changeset --test-plan` reports it, so the two cannot
 * drift (T13795).
 *
 * - `configPaths`: CLEO config files, left to `tool:config-schema` (T13778).
 * - `full`: the rest is workspace-wide; no test-run report speaks for it.
 * - `targeted`: the report must pass every file of `outsideTests` and of
 *   `everyChangedTest`, and at least one test file of every package in
 *   `required`. `direct` lists the changed packages; `untestedPackages` the
 *   affected ones with no test; `typecheckDirs` the typecheck-only dependents
 *   left to a typecheck (T13783). `standalone` marks a single-package project.
 */
export type TestRunRequirement =
  | { kind: 'full'; reason: string; configPaths: string[] }
  | {
      kind: 'targeted';
      configPaths: string[];
      direct: string[];
      required: string[];
      untestedPackages: string[];
      typecheckDirs: string[];
      outsideTests: string[];
      everyChangedTest: string[];
      standalone: boolean;
    };

/**
 * The {@link TestRunRequirement} of a change.
 *
 * @param root - The checkout the change is relative to.
 * @param changed - The change's paths, relative to `root`.
 * @returns What a covering report must run.
 * @task T13795
 */
export function testRunRequirement(root: string, changed: readonly string[]): TestRunRequirement {
  const configPaths = changed.filter((p) => cleoConfigSchemaFor(p) !== null);
  const code = changed.filter((p) => cleoConfigSchemaFor(p) === null);
  const none = {
    kind: 'targeted' as const,
    configPaths,
    direct: [],
    required: [],
    untestedPackages: [],
    typecheckDirs: [],
    outsideTests: [],
    everyChangedTest: [],
    standalone: false,
  };
  if (code.length === 0) return none;
  const scope = deriveAffectedPackages(root, code, { outsideTests: true });
  if (scope.scope === 'full') return { kind: 'full', reason: scope.reason, configPaths };
  const outsideTests = scope.outsideTests ?? [];
  if (scope.direct.length === 0) return { ...none, outsideTests };
  // Longest directory first, so a file belongs to its innermost package.
  const workspace = listWorkspacePackages(root).sort((a, b) => b.dir.length - a.dir.length);
  const withTests = packagesWithTestFiles(root, workspace, code);
  // T13783 (owner decision): a dependent reached only through changed
  // packages whose every changed path the default branch declares
  // typecheck-only (evidence.typecheckOnlyDependents: a generated client,
  // seed data) owes a typecheck naming it, not a test file. Its own changed
  // source, or a path through any other changed package, keeps it owing tests.
  const generated = typecheckOnlyPackages(root, code, workspace);
  const viaCode =
    generated.size > 0
      ? dependentsClosure(
          workspace,
          scope.direct.filter((name) => !generated.has(name)),
        )
      : null;
  const typecheckOnly = viaCode
    ? scope.packages.filter(
        (name) => !scope.direct.includes(name) && !viaCode.has(name) && withTests.has(name),
      )
    : [];
  // T13403: in a standalone project the one package is the whole project, so
  // one test file of it says nothing about the change; T13783: a run that
  // leaves dependents to a typecheck runs every edited test file too.
  const standalone = workspace.length === 1 && workspace[0]?.dir === '';
  return {
    ...none,
    direct: scope.direct,
    required: scope.packages.filter((name) => withTests.has(name) && !typecheckOnly.includes(name)),
    untestedPackages: scope.packages.filter((name) => !withTests.has(name)),
    typecheckDirs: typecheckOnly
      .map((name) => workspace.find((p) => p.name === name)?.dir ?? name)
      .sort(),
    outsideTests,
    everyChangedTest: standalone || typecheckOnly.length > 0 ? changedTestFiles(root, code) : [],
    standalone,
  };
}

/**
 * Why the CLEO config and the rest of a change are not covered together in
 * one gate write (T13778), or null. A test, QA or affected run that left CLEO
 * config to `tool:config-schema` (`configPaths`) needs a config-schema result
 * that validated those files; a config-schema result on a change with other
 * paths (`otherPaths`) needs another verification result for them, so a
 * config edit never stands in for an untested source change. Merged CI
 * (`ci:`) covers the whole change on its own.
 *
 * @param atoms - The validated atoms of one gate write.
 * @returns The refusal naming the composed route, or null.
 * @task T13778
 */
export function configSchemaCompositionGap(atoms: readonly EvidenceAtom[]): string | null {
  if (atoms.some((a) => a.kind === 'ci')) return null;
  const validated = new Set(
    atoms.flatMap((a) => (a.kind === 'tool' && a.configSchema ? a.configSchema : [])),
  );
  const left = new Set(
    atoms.flatMap((a) =>
      a.kind === 'test-run' || a.kind === 'qa-run' || (a.kind === 'tool' && !a.configSchema)
        ? (a.configPaths ?? [])
        : [],
    ),
  );
  const unvalidated = [...left].filter((p) => !validated.has(p));
  if (unvalidated.length > 0)
    return (
      `This change also edits CLEO config (${unvalidated.join(', ')}), which no test or QA run ` +
      'checks. Add tool:config-schema to the same write, e.g. --evidence ' +
      '"test-run:<report>;tool:config-schema".'
    );
  const rest = atoms.flatMap((a) =>
    a.kind === 'tool' && a.configSchema ? (a.otherPaths ?? []) : [],
  );
  const otherResult = atoms.some(
    (a) =>
      a.kind === 'test-run' ||
      a.kind === 'qa-run' ||
      (a.kind === 'tool' && !a.configSchema && a.notApplicable !== true),
  );
  if (rest.length > 0 && !otherResult)
    return (
      `tool:config-schema checks only the CLEO config of this change; the rest ` +
      `(${[...new Set(rest)].slice(0, 5).join(', ')}${rest.length > 5 ? ', …' : ''}) needs its own ` +
      'result in the same write: a test-run: of the changed test files for testsPassed, or ' +
      'qa-run: receipts for qaPassed, e.g. --evidence "test-run:<report>;tool:config-schema".'
    );
  return null;
}

/** Judge a report's test files against a {@link TestRunRequirement}. */
function testRunMeetsRequirement(
  root: string,
  need: TestRunRequirement,
  testFiles: readonly string[],
): TestRunBinding {
  const refuse = (reason: string): TestRunBinding => ({
    ok: false,
    codeName: 'E_EVIDENCE_INSUFFICIENT',
    reason,
  });
  if (need.kind === 'full') {
    // A workspace-wide change can break any package: only a full-suite run
    // speaks for it, and no report shows it ran the whole suite.
    return refuse(
      `The change is workspace-wide (${need.reason}), so only a full-suite run speaks for it, ` +
        'and a test-run report cannot show that it ran the whole suite (test configs exclude ' +
        'tracked test files, so file counts prove nothing). Record tool:test, which runs the ' +
        'full suite for a workspace-wide change, or ci:<pr> once the PR merges (when the merge ' +
        "commit's CI is not green, a green push run of the required CI on the default branch's " +
        'current HEAD, descending from the merge, stands in: T14032).',
    );
  }
  // T13754: a non-workspace path is spoken for only by passing every test file
  // outside the packages under its top-level directory (edited ones included).
  const ran = new Set(testFiles);
  const outsideUnrun = need.outsideTests.filter((f) => !ran.has(f));
  if (outsideUnrun.length > 0) {
    return refuse(
      `test-run report does not run ${outsideUnrun.slice(0, 5).join(', ')}` +
        `${outsideUnrun.length > 5 ? `, … (${outsideUnrun.length} files)` : ''}. The change ` +
        'touches paths outside every workspace package, so a targeted report must pass every ' +
        'test file outside the packages under their top-level directories. Run them and record the report, or record ' +
        'tool:test-affected.',
    );
  }
  if (need.direct.length === 0) return { ok: true, untestedPackages: [] };
  const { required, untestedPackages } = need;
  const typecheck = need.typecheckDirs.length > 0 ? { typecheckDirs: need.typecheckDirs } : {};
  if (required.length === 0) {
    return refuse(
      `No test file exists in the changed package(s) ${someNames(need.direct)} or in any package ` +
        'that depends on them, so a targeted test-run cannot cover the change. Record tool:test.',
    );
  }
  const workspace = listWorkspacePackages(root).sort((a, b) => b.dir.length - a.dir.length);
  const covered = new Set(testFiles.flatMap((f) => ownerOf(f, workspace)?.name ?? []));
  const missing = required.filter((name) => !covered.has(name));
  if (missing.length === 0) {
    const unrun = need.everyChangedTest.filter((f) => !ran.has(f));
    if (unrun.length === 0) return { ok: true, untestedPackages, ...typecheck };
    return refuse(
      `test-run report does not run the changed test file(s) ${unrun.slice(0, 5).join(', ')}` +
        `${unrun.length > 5 ? `, … (${unrun.length} files)` : ''}. ${
          need.standalone
            ? 'In a single-package project the package is the whole project'
            : 'Dependents of a generated package are left to a typecheck'
        }, so a targeted report must run every test file the ` +
        'change adds or edits (passing). Run them and record the report, or record tool:test.',
    );
  }
  const labelled = missing.map((name) =>
    need.direct.includes(name) ? `${name} (changed)` : `${name} (depends on a changed package)`,
  );
  return refuse(
    `${
      testFiles.length === 0
        ? 'test-run report lists no test files, so it covers no test file of'
        : 'test-run report covers no test file of'
    } ${someNames(labelled)}. A targeted report must cover ${TARGETED_RUN_COVERAGE}. ` +
      'Run those tests and record the report, or record tool:test-affected (or tool:test).',
  );
}
