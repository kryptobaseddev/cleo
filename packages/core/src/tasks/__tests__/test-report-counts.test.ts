/**
 * T14124 — one count reader for `test-run:` evidence and typed gates' minCount.
 *
 * Every format `test-run:` reads must count the same through a typed gate:
 * each fixture below is read by {@link readTestReport}, recorded as a
 * `test-run:` atom, and replayed on a gate's stdout with `minCount` set to its
 * pass count (passes) and one more (fails, naming the same count).
 *
 * @task T14124
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestGate } from '@cleocode/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateAtom } from '../evidence.js';
import { runGates } from '../gate-runner.js';
import { readTestReport, TEST_REPORT_FORMATS } from '../test-report-counts.js';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cleo-report-counts-'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'report-counts-fixture' }));
  await mkdir(join(root, '.cleo'));
  await writeFile(
    join(root, '.cleo/project-info.json'),
    JSON.stringify({ projectId: 'report-counts', projectHash: 'report-counts-path' }),
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const startTime = Date.now();
const passing = (n: number) => Array.from({ length: n }, () => ({ status: 'passed' }));

/**
 * VidaPeps T2373, PROVISIONAL until their redacted keys arrive: a Node event
 * reporter's JSON with per-file `testResults[].assertionResults` and no
 * top-level counter set; 7 cases passed across 3 files.
 */
const t2373 = {
  startTime,
  success: true,
  testResults: [
    { name: '/app/test/a.test.mjs', status: 'passed', assertionResults: passing(3) },
    { name: '/app/test/b.test.mjs', status: 'passed', assertionResults: passing(2) },
    { name: '/app/test/c.test.mjs', status: 'passed', assertionResults: passing(2) },
  ],
};

const vitest = {
  numTotalTests: 3,
  numPassedTests: 3,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  success: true,
  startTime,
  testResults: [{ name: '/app/src/a.test.ts', status: 'passed', assertionResults: passing(3) }],
};

const playwright = {
  config: { rootDir: '/app/e2e' },
  suites: [
    {
      file: 'home.spec.ts',
      specs: [{ tests: [{ status: 'expected' }] }, { tests: [{ status: 'flaky' }] }],
    },
  ],
  stats: { expected: 1, skipped: 0, unexpected: 0, flaky: 1, startTime: new Date().toISOString() },
  errors: [],
};

const junit =
  '<?xml version="1.0"?>\n<testsuites><testsuite name="pkg" tests="2" failures="0" errors="0" skipped="0">' +
  '<testcase name="a" file="tests/test_a.py"/><testcase name="b" file="tests/test_a.py"/>' +
  '</testsuite></testsuites>\n';

const libtest = [
  { type: 'suite', event: 'started', test_count: 2 },
  { type: 'test', event: 'ok', name: 'crate::a' },
  { type: 'test', event: 'ok', name: 'crate::b' },
  { type: 'suite', event: 'ok', passed: 2, failed: 0, ignored: 0 },
]
  .map((line) => JSON.stringify(line))
  .join('\n');

const tapFixture = fileURLToPath(new URL('./fixtures/node24-tap/pass.tap', import.meta.url));

/** Each format, its text, and the counts both paths must agree on. */
const cases = async (): Promise<
  Array<{
    format: (typeof TEST_REPORT_FORMATS)[number];
    text: string;
    passed: number;
    total: number;
  }>
> => [
  { format: 'vitest/jest JSON', text: JSON.stringify(vitest), passed: 3, total: 3 },
  { format: 'Node event JSON', text: JSON.stringify(t2373), passed: 7, total: 7 },
  {
    format: 'runner summary JSON',
    text: JSON.stringify({ total: 4, passed: 3, failed: 0, skipped: 1 }),
    passed: 3,
    total: 4,
  },
  {
    format: 'node --test summary JSON',
    text: JSON.stringify({ tests: 2, pass: 2, fail: 0 }),
    passed: 2,
    total: 2,
  },
  { format: 'Playwright JSON', text: JSON.stringify(playwright), passed: 2, total: 2 },
  { format: 'JUnit XML', text: junit, passed: 2, total: 2 },
  { format: 'libtest JSON lines', text: libtest, passed: 2, total: 2 },
  { format: 'node:test TAP', text: await readFile(tapFixture, 'utf-8'), passed: 2, total: 2 },
];

/** A typed gate replaying `text` on stdout. */
const replay = (text: string, minCount: number): TestGate => ({
  kind: 'test',
  description: 'report replay',
  command: process.execPath,
  args: ['-e', `process.stdout.write(${JSON.stringify(text)});`],
  expect: 'pass',
  minCount,
});

const runGate = async (gate: TestGate) => (await runGates([gate], { projectRoot: root }))[0];

describe('one count reader for test-run: and typed gates (T14124)', () => {
  it('AC2: every format reads as itself with its counts', async () => {
    for (const c of await cases()) {
      const read = readTestReport(c.text);
      expect(read?.ok, `${c.format}: ${JSON.stringify(read)}`).toBe(true);
      if (!read?.ok) continue;
      expect(read.format).toBe(c.format);
      expect([read.counts.passed, read.counts.total]).toEqual([c.passed, c.total]);
    }
  });

  it('AC1/AC2: a test-run: atom records the same pass count the reader reads', async () => {
    for (const [i, c] of (await cases()).entries()) {
      const file = `report-${i}.txt`;
      await writeFile(join(root, file), c.text);
      const r = await validateAtom({ kind: 'test-run', path: file }, root);
      expect(r.ok, `${c.format}: ${JSON.stringify(r)}`).toBe(true);
      expect(r.ok && r.atom.kind === 'test-run' && r.atom.passCount).toBe(c.passed);
    }
  });

  it('AC1/AC2: a typed gate counts the same: minCount = pass count passes, one more fails', async () => {
    for (const c of await cases()) {
      const met = await runGate(replay(c.text, c.passed));
      expect(met?.result, `${c.format}: ${met?.errorMessage}`).toBe('pass');
      const short = await runGate(replay(c.text, c.passed + 1));
      expect(short?.result, c.format).toBe('fail');
      expect(short?.errorMessage, c.format).toContain(`counts ${c.passed} passing tests`);
    }
  });

  it('AC3 (provisional T2373 shape): a Node event JSON report passes a minCount 7 gate', async () => {
    const result = await runGate(replay(JSON.stringify(t2373), 7));
    expect(result?.result, result?.errorMessage).toBe('pass');
  });

  it('AC4: with no parsable report, the minCount refusal names every format tried', async () => {
    const result = await runGate(replay('7 tests passed\n', 1));
    expect(result?.result).toBe('error');
    expect(result?.errorMessage).toContain(`Formats tried: ${TEST_REPORT_FORMATS.join(', ')}`);
  });

  it('counters that contradict the report’s own test results are refused on both paths', async () => {
    const lying = { ...vitest, numTotalTests: 5, numPassedTests: 5 };
    const read = readTestReport(JSON.stringify(lying));
    expect(read?.ok).toBe(false);
    expect(read !== null && !read.ok && read.reason).toMatch(/contradict its own test results/);
    await writeFile(join(root, 'lying.json'), JSON.stringify(lying));
    const atom = await validateAtom({ kind: 'test-run', path: 'lying.json' }, root);
    expect(!atom.ok && atom.reason).toMatch(/contradict its own test results/);
    const gate = await runGate(replay(JSON.stringify(lying), 1));
    expect(gate?.result).toBe('error');
    expect(gate?.errorMessage).toMatch(/contradict its own test results/);
  });

  it('a failing report still counts for a gate (and fails it), while test-run: refuses it', async () => {
    const failing = {
      ...vitest,
      numPassedTests: 2,
      numFailedTests: 1,
      success: false,
      testResults: [
        {
          name: '/app/src/a.test.ts',
          status: 'failed',
          assertionResults: [...passing(2), { status: 'failed' }],
        },
      ],
    };
    const gate = await runGate(replay(JSON.stringify(failing), 1));
    expect(gate?.result).toBe('fail');
    expect(gate?.errorMessage).toMatch(/counts 1 failing/);
    await writeFile(join(root, 'failing.json'), JSON.stringify(failing));
    const atom = await validateAtom({ kind: 'test-run', path: 'failing.json' }, root);
    expect(!atom.ok && atom.codeName).toBe('E_EVIDENCE_TESTS_FAILED');
  });
});
