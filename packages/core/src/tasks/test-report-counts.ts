/**
 * One reader for test-report counts, shared by `test-run:` evidence and typed
 * test gates' `minCount` (T14124).
 *
 * The two paths used to parse reports separately: a typed gate refused a
 * node:test event report with node-style counters (`tests`/`pass`/`fail`,
 * no `numTotalTests`; VidaPeps T2373) whose shape `test-run:` read, and
 * `test-run:` read JUnit, libtest and Playwright through adapters the gate
 * never saw. {@link readTestReport}
 * tries every format in {@link TEST_REPORT_FORMATS} order, adapts it to the
 * vitest shape, and returns its counts under one set of integrity rules:
 *
 * - counts are non-negative integers that add up to the total;
 * - when the report also lists per-test results, its counters must equal
 *   them ({@link assertionDisagreement}) — a report whose counters contradict
 *   its own assertions is not evidence.
 *
 * What each caller does with failures differs: `test-run:` refuses a report
 * with any failure; a typed gate reads the counts and fails the gate.
 *
 * @module tasks/test-report-counts
 * @task T14124
 */

import { resolve } from 'node:path';
import type { TestRunReport } from './test-run-binding.js';

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

/** A parsed `test-run:` report: the binding's fields plus whatever counters it carries. */
export type TestRunReportJson = TestRunReport & Readonly<Record<string, unknown>>;

/**
 * The counter sets a `test-run:` report may carry (gh#1804), tried in order;
 * the first whose total key is present is read. `failed` and `notRun` sum
 * their keys, and an absent count is 0.
 *
 * | Shape | Total | Passed | Failed | Skipped / todo |
 * |---|---|---|---|---|
 * | vitest `--reporter=json`, jest `--json` | `numTotalTests` | `numPassedTests` | `numFailedTests` | `numPendingTests`, `numTodoTests` |
 * | a runner's summary output (bun test, tsx --test) | `total` | `passed` | `failed` | `skipped`, `todo` |
 * | node --test summary (`# tests`, `# pass`, ...) | `tests` | `pass` | `fail`, `cancelled` | `skipped`, `todo` |
 *
 * Integrity (T13136 review): every count is a non-negative integer;
 * passed + failed + skipped/todo equals the total; a failure under ANY key
 * ({@link TEST_RUN_FAILURE_KEYS}) is reported as `failure`, whichever set
 * supplied the total, and `test-run:` refuses it;
 * a report's `exit` / `exitCode` must be a number, and a non-zero one is
 * refused. A `test-run:` atom proves only what its file says; `tool:test` and
 * `ci:<pr>` are what prove the run. `cleo verify --help` documents the same
 * sets.
 *
 * @task T13136
 */
export const TEST_RUN_COUNTER_SHAPES = [
  {
    name: 'vitest/jest',
    total: 'numTotalTests',
    passed: 'numPassedTests',
    failed: ['numFailedTests'],
    notRun: ['numPendingTests', 'numTodoTests'],
  },
  {
    name: 'summary',
    total: 'total',
    passed: 'passed',
    failed: ['failed'],
    notRun: ['skipped', 'todo'],
  },
  {
    name: 'node --test',
    total: 'tests',
    passed: 'pass',
    failed: ['fail', 'cancelled'],
    notRun: ['skipped', 'todo'],
  },
] as const;

/** The keys of each counter set, as the refusals name them. */
export const TEST_RUN_SHAPE_HINT = TEST_RUN_COUNTER_SHAPES.map(
  (s) => `${[s.total, s.passed, ...s.failed, ...s.notRun].join('/')} (${s.name})`,
).join(', ');

/** The counts a report states, and the counter set they came from. */
export interface TestRunCounts {
  readonly shape: (typeof TEST_RUN_COUNTER_SHAPES)[number];
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly notRun: number;
  /** A failure under any {@link TEST_RUN_FAILURE_KEYS} key (`numFailedTestSuites = 1`), when one is positive. */
  readonly failure?: string;
}

/**
 * Keys that name failures in any counter set, plus jest/vitest suite failures
 * and the mocha / JUnit spellings: a positive value under any of them refuses
 * the report, whichever set supplied the total.
 */
const TEST_RUN_FAILURE_KEYS = [
  'numFailedTests',
  'numFailedTestSuites',
  'numRuntimeErrorTestSuites',
  'failed',
  'fail',
  'cancelled',
  'failures',
  'errors',
] as const;

/** A refusal while reading a report's counts. */
export interface TestRunCountsRefusal {
  readonly reason: string;
  readonly codeName: 'E_EVIDENCE_INVALID' | 'E_EVIDENCE_TESTS_FAILED';
}

/** A present, non-null JSON value. */
export const present = (value: unknown): boolean => value !== undefined && value !== null;

/** A non-negative integer, or `undefined` when the value is anything else. */
const countOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;

/**
 * Read a report's counts from the first counter set it carries, enforcing
 * their integrity; `null` when it carries none.
 *
 * @param report - A report in the vitest shape (adapted when it was another format).
 * @returns The counts, an integrity refusal, or null when no counter set is present.
 * @task T13136
 * @task T14124
 */
export function reportCounts(
  report: TestRunReportJson,
): TestRunCounts | TestRunCountsRefusal | null {
  const shape = TEST_RUN_COUNTER_SHAPES.find((s) => present(report[s.total]));
  if (shape === undefined) return null;
  const invalid = (key: string): TestRunCountsRefusal => ({
    reason: `test-run report's "${key}" is ${JSON.stringify(report[key])}; every count must be a non-negative integer`,
    codeName: 'E_EVIDENCE_INVALID',
  });
  const read = (key: string): number | TestRunCountsRefusal => {
    if (!present(report[key])) return 0;
    return countOf(report[key]) ?? invalid(key);
  };
  const total = read(shape.total);
  if (typeof total !== 'number') return total;
  const keys = [shape.passed, ...shape.failed, ...shape.notRun];
  const values: number[] = [];
  for (const key of keys) {
    const v = read(key);
    if (typeof v !== 'number') return v;
    values.push(v);
  }
  let failure: string | undefined;
  for (const key of TEST_RUN_FAILURE_KEYS) {
    if (!present(report[key])) continue;
    const v = countOf(report[key]);
    if (v === undefined) return invalid(key);
    if (v > 0) failure ??= `${key} = ${v}`;
  }
  const [passed = 0, ...rest] = values;
  const failed = rest.slice(0, shape.failed.length).reduce((a, b) => a + b, 0);
  const notRun = rest.slice(shape.failed.length).reduce((a, b) => a + b, 0);
  if (passed + failed + notRun !== total) {
    return {
      reason:
        `test-run report's counts do not add up: ${shape.total} is ${total}, but ` +
        `${shape.passed} + ${[...shape.failed, ...shape.notRun].join(' + ')} = ${passed + failed + notRun}`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  }
  return { shape, total, passed, failed, notRun, ...(failure ? { failure } : {}) };
}

/**
 * Adapt node:test TAP output (`node --test --test-reporter=tap`, also via
 * `tsx --test`), which ships no JSON reporter (T14051), to the vitest shape. The run's LAST
 * top-level plan (`1..N` at column 0) must be followed by its `# tests N`,
 * `# pass N` and `# fail N` summary; `# cancelled N` counts as failed. Test
 * console output is re-emitted as indented or `# ` comment lines before that
 * plan, so it cannot forge the summary.
 *
 * TAP names no files, so the adapted report covers none.
 *
 * @param stdout - A run's captured stdout, or a TAP report file's text.
 * @returns The adapted report, a refusal, or null when the text is not TAP.
 * @task T14051
 * @task T14124
 */
export function tapTestRun(stdout: string): AdaptedTestRun | AdaptedTestRunRefusal | null {
  const lines = stdout.split(/\r?\n/);
  if (!lines.some((line) => /^TAP version \d+$/.test(line.trim()))) return null;
  if (lines.some((line) => /^\s*Bail out!/.test(line)))
    return { refusal: 'its TAP output contains "Bail out!"', codeName: 'E_EVIDENCE_TESTS_FAILED' };
  const plan = lines.findLastIndex((line) => /^1\.\.\d+(?:\s|$)/.test(line));
  if (plan === -1)
    return { refusal: 'its TAP output has no top-level 1..N plan', codeName: 'E_EVIDENCE_INVALID' };
  const summary = new Map<string, number>();
  for (const line of lines.slice(plan + 1)) {
    const match = line.match(/^# (tests|pass|fail|cancelled) (\d+)$/);
    if (match) summary.set(match[1]!, Number(match[2]));
  }
  const tests = summary.get('tests');
  const pass = summary.get('pass');
  const fail = summary.get('fail');
  if (tests === undefined || pass === undefined || fail === undefined)
    return {
      refusal: 'its TAP output has no "# tests", "# pass" and "# fail" summary after the plan',
      codeName: 'E_EVIDENCE_INVALID',
    };
  if (tests === 0 || /^1\.\.0(?:\s|$)/.test(lines[plan]!))
    return { refusal: 'its TAP output reports zero tests', codeName: 'E_EVIDENCE_TESTS_FAILED' };
  const failed = fail + (summary.get('cancelled') ?? 0);
  return {
    numTotalTests: tests,
    numPassedTests: pass,
    numFailedTests: failed,
    numPendingTests: tests - pass - failed,
    numTodoTests: 0,
    testResults: [],
  };
}

/**
 * Why a report's counters contradict its own per-test results, or null when
 * they agree or it lists none (T14124). Counted over `testResults[].
 * assertionResults[].status`: `passed`, `failed`, and every other status as
 * not run. Applies to every counter set.
 *
 * @param report - A report in the vitest shape.
 * @param counts - The counts read from its counter set.
 * @returns The disagreement, or null.
 * @task T14124
 */
export function assertionDisagreement(
  report: TestRunReportJson,
  counts: TestRunCounts,
): string | null {
  const files = report.testResults;
  if (!Array.isArray(files)) return null;
  const assertions = files.flatMap((f) =>
    isRecord(f) && Array.isArray(f.assertionResults) ? (f.assertionResults as unknown[]) : [],
  );
  if (assertions.length === 0) return null;
  const status = (a: unknown): unknown => (isRecord(a) ? a.status : undefined);
  const passed = assertions.filter((a) => status(a) === 'passed').length;
  const failed = assertions.filter((a) => status(a) === 'failed').length;
  if (assertions.length === counts.total && passed === counts.passed && failed === counts.failed)
    return null;
  return (
    `its counters (${counts.shape.total} ${counts.total}, ${counts.shape.passed} ${counts.passed}, ` +
    `failed ${counts.failed}) contradict its own test results (${assertions.length} tests, ` +
    `${passed} passed, ${failed} failed)`
  );
}

/** The report formats {@link readTestReport} tries, in order, as refusals name them. */
export const TEST_REPORT_FORMATS = [
  'JUnit XML',
  'Playwright JSON',
  'vitest/jest JSON',
  'runner summary JSON',
  'node --test summary JSON',
  'libtest JSON lines',
  'node:test TAP',
] as const;

/** One of {@link TEST_REPORT_FORMATS}. */
export type TestReportFormat = (typeof TEST_REPORT_FORMATS)[number];

/** A report {@link readTestReport} read. */
export interface ReadTestReport {
  readonly ok: true;
  /** The format it was read as. */
  readonly format: TestReportFormat;
  /** The report in the vitest shape. */
  readonly report: TestRunReportJson;
  /** Its counts. */
  readonly counts: TestRunCounts;
}

/** A report {@link readTestReport} recognised but refused. */
export interface RefusedTestReport {
  readonly ok: false;
  /** The format it was read as. */
  readonly format: TestReportFormat;
  readonly reason: string;
  readonly codeName: 'E_EVIDENCE_INVALID' | 'E_EVIDENCE_TESTS_FAILED';
}

/** Format of a vitest-shaped report by the counter set that supplied its counts. */
const FORMAT_BY_SHAPE: Record<(typeof TEST_RUN_COUNTER_SHAPES)[number]['name'], TestReportFormat> =
  {
    'vitest/jest': 'vitest/jest JSON',
    summary: 'runner summary JSON',
    'node --test': 'node --test summary JSON',
  };

/** Counts and cross-check for a report already in the vitest shape. */
function counted(
  report: TestRunReportJson,
  adaptedAs: TestReportFormat | null,
): ReadTestReport | RefusedTestReport | null {
  const counts = reportCounts(report);
  if (counts === null) return null;
  const format =
    adaptedAs ??
    ('shape' in counts ? FORMAT_BY_SHAPE[counts.shape.name] : null) ??
    'vitest/jest JSON';
  if (!('shape' in counts))
    return { ok: false, format, reason: counts.reason, codeName: counts.codeName };
  const disagreement = assertionDisagreement(report, counts);
  if (disagreement !== null)
    return {
      ok: false,
      format,
      reason: `the report is not evidence: ${disagreement}`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  return { ok: true, format, report, counts };
}

/** An adapter's result, counted. */
function adapted(
  result: AdaptedTestRun | AdaptedTestRunRefusal,
  format: TestReportFormat,
): ReadTestReport | RefusedTestReport | null {
  if ('refusal' in result)
    return { ok: false, format, reason: result.refusal, codeName: result.codeName };
  return counted(result as TestRunReportJson, format);
}

/**
 * Read a parsed JSON report: Playwright, then a counter set (vitest/jest,
 * runner summary, node --test summary; T14124).
 *
 * @param parsed - The parsed JSON value.
 * @returns The read report, a refusal, or null when it is none of these.
 * @task T14124
 */
export function readParsedTestReport(parsed: unknown): ReadTestReport | RefusedTestReport | null {
  if (!isRecord(parsed)) return null;
  if (
    present(parsed.testResults) &&
    (!Array.isArray(parsed.testResults) || parsed.testResults.some((tr) => !isRecord(tr)))
  )
    return {
      ok: false,
      format: 'vitest/jest JSON',
      reason: 'the report\'s "testResults" must be an array of objects',
      codeName: 'E_EVIDENCE_INVALID',
    };
  const playwright = playwrightTestRun(parsed);
  if (playwright !== null) return adapted(playwright, 'Playwright JSON');
  return counted(parsed as TestRunReportJson, null);
}

/**
 * Read a test report's text in any supported format (T14124): JUnit XML, a
 * JSON report ({@link readParsedTestReport}), libtest JSON lines, or node:test
 * TAP. Each is adapted to the vitest shape and counted under the same rules.
 *
 * @param text - The report's text (a file, or a run's captured output).
 * @returns The read report, a refusal, or null when no format matches.
 * @example
 * ```ts
 * const read = readTestReport(readFileSync('report.json', 'utf-8'));
 * if (read?.ok) console.log(read.format, read.counts.passed);
 * ```
 * @task T14124
 */
export function readTestReport(text: string): ReadTestReport | RefusedTestReport | null {
  const junit = junitTestRun(text);
  if (junit !== null) return adapted(junit, 'JUnit XML');
  let parsed: unknown;
  let isJson = true;
  try {
    parsed = JSON.parse(text);
  } catch {
    isJson = false;
  }
  // A one-line libtest report is a JSON object too; only a recognised JSON
  // report stops the search.
  const json = isJson ? readParsedTestReport(parsed) : null;
  if (json !== null) return json;
  const libtest = libtestTestRun(text);
  if (libtest !== null) return adapted(libtest, 'libtest JSON lines');
  const tap = tapTestRun(text);
  return tap === null ? null : adapted(tap, 'node:test TAP');
}
