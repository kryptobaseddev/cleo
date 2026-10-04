/**
 * Tests for the CI flaky-test quarantine (T13145): the report parsing, the
 * flake/quarantine/blocking decision, the issue plans, and the `run` and
 * `file` subcommands end to end against a stand-in vitest and `gh`.
 *
 * @task T13145
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  bodyOf,
  classify,
  EXPIRE_AFTER_DAYS,
  keyOf,
  MAX_QUARANTINE,
  MAX_RERUN_FILES,
  parseIssue,
  parseVitestReport,
  planExpiry,
  planFiling,
  rowsFromGraphql,
  titleOf,
  trustedIssues,
  UNHANDLED_LINE,
  WHOLE_FILE,
  withoutShard,
} from '../ci-flaky-quarantine.mjs';

/** The author `gh issue list --json author` reports for an issue GitHub Actions filed. */
const BOT = { login: 'app/github-actions', is_bot: true };

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../ci-flaky-quarantine.mjs',
);
const ROOT = '/repo';
const A = { file: 'packages/core/src/a.test.ts', test: 'a > works' };
const B = { file: 'packages/core/src/b.test.ts', test: 'b > works' };

/** A vitest JSON report whose `failing` tests failed and every other listed test passed. */
function report(failing, passing = [], fileErrors = []) {
  const byFile = new Map();
  for (const [t, status] of [
    ...failing.map((t) => [t, 'failed']),
    ...passing.map((t) => [t, 'passed']),
  ]) {
    if (!byFile.has(t.file)) byFile.set(t.file, []);
    byFile.get(t.file).push({
      fullName: t.test,
      title: t.test,
      status,
      failureMessages: status === 'failed' ? ['Error: boom\n at x'] : [],
    });
  }
  const testResults = [...byFile].map(([file, assertionResults]) => ({
    name: path.join(ROOT, file),
    status: assertionResults.some((a) => a.status === 'failed') ? 'failed' : 'passed',
    assertionResults,
  }));
  for (const file of fileErrors) {
    testResults.push({
      name: path.join(ROOT, file),
      status: 'failed',
      message: 'SyntaxError: nope',
      assertionResults: [],
    });
  }
  return JSON.stringify({ success: failing.length === 0 && fileErrors.length === 0, testResults });
}

describe('parseVitestReport', () => {
  it('reads failing tests with repo-relative files, and a whole-file failure as *', () => {
    const parsed = parseVitestReport(report([A], [B], ['packages/x/broken.test.ts']), ROOT);
    expect(parsed?.failures).toEqual([A, { file: 'packages/x/broken.test.ts', test: WHOLE_FILE }]);
    expect(parsed?.messages.get(keyOf(A))).toBe('Error: boom');
  });

  it('returns null for anything that is not a vitest report', () => {
    expect(parseVitestReport('not json', ROOT)).toBeNull();
    expect(parseVitestReport('{"numTotalTests":1}', ROOT)).toBeNull();
  });
});

describe('classify', () => {
  it('a failure that passes on the re-run is a flake; one that fails again blocks', () => {
    expect(classify([A, B], [], [B])).toMatchObject({ flaky: [A], blocking: [B], quarantined: [] });
  });

  it('a quarantined test that fails its re-run too does not block; one that passes on it is a flake', () => {
    expect(classify([A, B], [A], [A])).toMatchObject({
      quarantined: [A],
      flaky: [B],
      blocking: [],
    });
    expect(classify([A], [A], [])).toMatchObject({ quarantined: [], flaky: [A], blocking: [] });
  });

  it('a whole-file entry excuses only a whole-file failure, never a test added to that file', () => {
    const whole = { file: B.file, test: WHOLE_FILE };
    expect(classify([B], [whole], [B])).toMatchObject({ blocking: [B], quarantined: [] });
    expect(classify([whole], [whole], [whole])).toMatchObject({
      blocking: [],
      quarantined: [whole],
    });
  });

  it('no readable re-run means every failure counts as failing twice', () => {
    expect(classify([A, B], [B], null)).toMatchObject({
      blocking: [A],
      quarantined: [B],
      flaky: [],
    });
  });

  it('a test that fails only in the re-run blocks', () => {
    expect(classify([A], [], [B]).blocking).toEqual([B]);
  });
});

describe('helpers', () => {
  it('withoutShard drops both spellings of --shard', () => {
    expect(withoutShard(['--shard=2/4', '--retry=2'])).toEqual(['--retry=2']);
    expect(withoutShard(['--shard', '2/4', '--retry=2'])).toEqual(['--retry=2']);
  });

  it('an issue body carries its state, and titles are bounded', () => {
    const state = {
      ...A,
      firstSeenAt: '2026-10-01T00:00:00.000Z',
      lastSeenAt: '2026-10-02T00:00:00.000Z',
      observations: 2,
    };
    expect(
      parseIssue({ number: 7, title: titleOf(A), body: bodyOf(state, 'flaky on abc') }).state,
    ).toEqual(state);
    expect(parseIssue({ number: 8, title: 'x', body: 'no marker' }).state).toBeNull();
    expect(titleOf({ file: 'f.test.ts', test: 'x'.repeat(400) }).length).toBeLessThanOrEqual(240);
  });
});

describe('trustedIssues and unhandled errors', () => {
  const stateOf = (t) => ({
    ...t,
    firstSeenAt: '2026-10-01T00:00:00.000Z',
    lastSeenAt: '2026-10-01T00:00:00.000Z',
    observations: 1,
  });
  it('counts only issues GitHub Actions filed, and each test once (the oldest issue)', () => {
    const body = bodyOf(stateOf(A), 'x');
    const { issues, duplicates } = trustedIssues([
      { number: 9, title: titleOf(A), body, author: BOT },
      {
        number: 3,
        title: titleOf(A),
        body,
        author: { login: 'github-actions[bot]', is_bot: true },
      },
      {
        number: 5,
        title: titleOf(B),
        body: bodyOf(stateOf(B), 'x'),
        author: { login: 'someone', is_bot: false },
      },
      {
        number: 6,
        title: titleOf(B),
        body: bodyOf(stateOf(B), 'x'),
        author: { login: 'github-actions', is_bot: false },
      },
    ]);
    expect(issues.map((i) => i.number)).toEqual([3]);
    expect(duplicates).toEqual([{ number: 9, of: 3 }]);
  });

  it('ignores a bot issue whose body someone else edited, or whose title names another test', () => {
    const critical = { file: 'packages/core/src/critical.test.ts', test: 'the test my PR breaks' };
    const human = { login: 'someone', is_bot: false };
    const { issues } = trustedIssues([
      // The review probe: a bot issue for one test, its body state re-targeted.
      { number: 4, title: titleOf(A), body: bodyOf(stateOf(critical), 'x'), author: BOT },
      // Title and state edited consistently, but the last body edit was not the bot's.
      {
        number: 5,
        title: titleOf(critical),
        body: bodyOf(stateOf(critical), 'x'),
        author: BOT,
        editor: human,
      },
      // The bot's own renewals edit the body; those count.
      { number: 6, title: titleOf(B), body: bodyOf(stateOf(B), 'x'), author: BOT, editor: BOT },
    ]);
    expect(issues.map((i) => i.number)).toEqual([6]);
  });

  it('reads issue rows from GraphQL, where a bot is an actor of type Bot', () => {
    const line = (n, author, editor) =>
      JSON.stringify({ number: n, title: 't', body: 'b', author, editor });
    const rows = rowsFromGraphql(
      [
        line(1, { __typename: 'Bot', login: 'github-actions' }, null),
        line(2, { __typename: 'Bot', login: 'github-actions' }, { __typename: 'User', login: 'x' }),
        '',
      ].join('\n'),
    );
    expect(rows).toEqual([
      {
        number: 1,
        title: 't',
        body: 'b',
        author: { login: 'github-actions', is_bot: true },
        editor: null,
      },
      {
        number: 2,
        title: 't',
        body: 'b',
        author: { login: 'github-actions', is_bot: true },
        editor: { login: 'x', is_bot: false },
      },
    ]);
  });

  it("recognises vitest's report of an error outside any test", () => {
    for (const line of [
      ' Errors  1 error',
      '\u001b[31m Errors  2 errors\u001b[39m',
      '⎯⎯⎯ Unhandled Errors ⎯⎯⎯',
      'Unhandled Rejection',
    ]) {
      expect(UNHANDLED_LINE.test(line.replace(/\x1b\[[0-9;]*m/g, '')), line).toBe(true);
    }
    expect(UNHANDLED_LINE.test(' Tests  3 passed (3)')).toBe(false);
  });
});

describe('planFiling and planExpiry', () => {
  const now = '2026-10-03T00:00:00.000Z';
  const stateOf = (t, lastSeenAt, observations = 1) => ({
    ...t,
    firstSeenAt: '2026-09-01T00:00:00.000Z',
    lastSeenAt,
    observations,
  });
  const issueOf = (n, state) =>
    parseIssue({ number: n, title: titleOf(state), body: bodyOf(state, 'x') });

  it('files a new test once and updates an existing issue with the new observation', () => {
    const open = [issueOf(1, stateOf(A, '2026-09-20T00:00:00.000Z', 3))];
    const plan = planFiling(
      [
        // A quarantined failure in one shard and a confirmed flake in another: the flake renews.
        { kind: 'quarantined', ...A, message: 'boom' },
        { kind: 'flaky', ...A, message: 'boom' },
        { kind: 'flaky', ...B, message: '' },
        { kind: 'flaky', ...B, message: '' },
      ],
      open,
      now,
      'abc (run)',
    );
    expect(plan.create).toHaveLength(1);
    expect(plan.create[0].title).toBe(titleOf(B));
    expect(parseIssue({ number: 0, title: '', body: plan.create[0].body }).state).toMatchObject({
      ...B,
      observations: 1,
    });
    expect(plan.update).toHaveLength(1);
    expect(parseIssue({ number: 1, title: '', body: plan.update[0].body }).state).toMatchObject({
      lastSeenAt: now,
      observations: 4,
    });
  });

  it('a quarantined test failing twice is recorded but never renews its quarantine (T13145 review HIGH)', () => {
    // Flaky once on day 0, then failing EVERY main run: it must leave quarantine within the expiry.
    let open = [issueOf(1, stateOf(A, '2026-09-01T00:00:00.000Z'))];
    for (let day = 1; day <= 20; day++) {
      const at = new Date(Date.parse('2026-09-01T00:00:00.000Z') + day * 86_400_000).toISOString();
      const plan = planFiling([{ kind: 'quarantined', ...A, message: 'boom' }], open, at, 'run');
      expect(plan.create).toEqual([]);
      open = plan.update.map((u) => parseIssue({ number: u.number, title: '', body: u.body }));
      expect(open[0].state).toMatchObject({
        lastSeenAt: '2026-09-01T00:00:00.000Z',
        observations: 1,
      });
    }
    const day20 = new Date(Date.parse('2026-09-21T00:00:00.000Z'));
    expect(planExpiry(open, new Set(), day20).map((i) => i.number)).toEqual([1]);
    // A quarantined failure with no issue files nothing.
    expect(planFiling([{ kind: 'quarantined', ...B, message: '' }], [], now, 'run')).toEqual({
      create: [],
      update: [],
    });
  });

  it(`expires an issue with no observation for ${EXPIRE_AFTER_DAYS} days, and nothing else`, () => {
    const old = issueOf(1, stateOf(A, '2026-09-01T00:00:00.000Z'));
    const recent = issueOf(2, stateOf(B, '2026-10-01T00:00:00.000Z'));
    const oldButSeen = issueOf(
      3,
      stateOf({ file: 'c.test.ts', test: 'c' }, '2026-09-01T00:00:00.000Z'),
    );
    const noState = parseIssue({ number: 4, title: 'x', body: '' });
    const close = planExpiry(
      [old, recent, oldButSeen, noState],
      new Set([keyOf(oldButSeen.state)]),
      new Date(now),
    );
    expect(close.map((i) => i.number)).toEqual([1]);
  });
});

describe('the run and file subcommands', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'flaky-quarantine-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /**
   * A stand-in vitest: reads its attempt number, writes the JSON report the
   * scenario lists for that attempt (or none), and exits with its code.
   */
  function fakeVitest(attempts) {
    const script = path.join(dir, 'fake-vitest.mjs');
    writeFileSync(
      script,
      `import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const counter = ${JSON.stringify(path.join(dir, 'attempts'))};
const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
writeFileSync(counter, String(n + 1));
writeFileSync(${JSON.stringify(path.join(dir, 'args'))} + n, JSON.stringify(process.argv.slice(2)));
const attempts = ${JSON.stringify(attempts)};
const a = attempts[Math.min(n, attempts.length - 1)];
const out = process.argv.find((x) => x.startsWith('--outputFile.json=')).slice('--outputFile.json='.length);
if (a.report !== null) writeFileSync(out, a.report);
console.log('fake vitest attempt ' + n);
if (a.stdout) console.log(a.stdout);
process.exit(a.code);
`,
    );
    return JSON.stringify([process.execPath, script]);
  }

  /**
   * A stand-in gh: answers the open-issues GraphQL query from `issues` (one
   * node per line, as `--jq '...nodes[]'` prints them), logs every call.
   */
  function fakeGh(issues) {
    const script = path.join(dir, 'fake-gh');
    const actor = (a) =>
      a ? { __typename: a.is_bot ? 'Bot' : 'User', login: a.login.replace(/^app\//, '') } : null;
    const nodes = issues
      .map((i) =>
        JSON.stringify({
          number: i.number,
          title: i.title,
          body: i.body,
          author: actor(i.author),
          editor: actor(i.editor),
        }),
      )
      .join('\n');
    writeFileSync(
      script,
      `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(path.join(dir, 'gh-calls'))}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv[2] === 'api' && process.argv[3] === 'graphql') process.stdout.write(${JSON.stringify(nodes)});
`,
    );
    chmodSync(script, 0o755);
    return script;
  }

  const ghCalls = () =>
    existsSync(path.join(dir, 'gh-calls'))
      ? readFileSync(path.join(dir, 'gh-calls'), 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l))
      : [];
  const attempts = () => Number(readFileSync(path.join(dir, 'attempts'), 'utf8'));

  function run(vitest, issues = [], extraEnv = {}) {
    const out = path.join(dir, 'flaky.json');
    const r = spawnSync(
      process.execPath,
      [
        SCRIPT,
        'run',
        '--log',
        path.join(dir, 'log'),
        '--report',
        out,
        '--',
        '--shard=1/4',
        '--retry=2',
      ],
      {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          FLAKY_VITEST_COMMAND: vitest,
          FLAKY_QUARANTINE_GH: fakeGh(issues),
          GITHUB_STEP_SUMMARY: '',
          GITHUB_EVENT_NAME: '',
          ...extraEnv,
        },
      },
    );
    return {
      code: r.status,
      out: r.stdout + r.stderr,
      report: existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null,
    };
  }

  // The fake reports name files relative to the cwd the script runs in (dir).
  const rel = (t) => ({ file: t.file, test: t.test });
  const rep = (failing, passing = []) =>
    JSON.stringify({
      testResults: [...failing.map((t) => [t, 'failed']), ...passing.map((t) => [t, 'passed'])].map(
        ([t, status]) => ({
          name: t.file,
          status,
          assertionResults: [
            {
              fullName: t.test,
              status,
              failureMessages: status === 'failed' ? ['Error: boom'] : [],
            },
          ],
        }),
      ),
    });

  it('passes straight through when vitest passes, teeing its output to --log', () => {
    const r = run(fakeVitest([{ code: 0, report: rep([], [A]) }]));
    expect(r.code).toBe(0);
    expect(attempts()).toBe(1);
    expect(readFileSync(path.join(dir, 'log'), 'utf8')).toContain('fake vitest attempt 0');
    expect(r.report).toBeNull();
  });

  it('a test that fails, then passes on a re-run of its file, is a flake: exit 0 and reported', () => {
    const r = run(
      fakeVitest([
        { code: 1, report: rep([A], [B]) },
        { code: 0, report: rep([], [A]) },
      ]),
    );
    expect(r.code).toBe(0);
    expect(attempts()).toBe(2);
    // The re-run names the failing file and drops --shard, keeping the other flags.
    const rerunArgs = JSON.parse(readFileSync(path.join(dir, 'args1'), 'utf8'));
    expect(rerunArgs).toContain(A.file);
    expect(rerunArgs).toContain('--retry=2');
    expect(rerunArgs.some((a) => a.startsWith('--shard'))).toBe(false);
    expect(r.report.observations).toEqual([{ kind: 'flaky', ...rel(A), message: 'Error: boom' }]);
  });

  it('a test that fails on the re-run too blocks', () => {
    const r = run(
      fakeVitest([
        { code: 1, report: rep([A]) },
        { code: 1, report: rep([A]) },
      ]),
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain('failed on the re-run too');
  });

  it('a crash with no report blocks and is not retried', () => {
    const r = run(fakeVitest([{ code: 137, report: null }]));
    expect(r.code).toBe(137);
    expect(attempts()).toBe(1);
    expect(r.out).toContain('without a readable JSON report');
  });

  it('a quarantined test is re-run too; failing twice does not block (and does not renew it)', () => {
    const state = {
      ...A,
      firstSeenAt: '2026-10-01T00:00:00.000Z',
      lastSeenAt: '2026-10-01T00:00:00.000Z',
      observations: 1,
    };
    const issues = [{ number: 5, title: titleOf(A), body: bodyOf(state, 'x'), author: BOT }];
    const r = run(
      fakeVitest([
        { code: 1, report: rep([A]) },
        { code: 1, report: rep([A]) },
      ]),
      issues,
    );
    expect(r.code).toBe(0);
    expect(attempts()).toBe(2);
    expect(r.report.observations).toEqual([
      { kind: 'quarantined', ...rel(A), message: 'Error: boom' },
    ]);
  });

  it('an issue body someone else edited quarantines nothing: failing twice blocks', () => {
    const state = {
      ...A,
      firstSeenAt: '2026-10-01T00:00:00.000Z',
      lastSeenAt: '2026-10-01T00:00:00.000Z',
      observations: 1,
    };
    const issues = [
      {
        number: 5,
        title: titleOf(A),
        body: bodyOf(state, 'x'),
        author: BOT,
        editor: { login: 'someone', is_bot: false },
      },
    ];
    const r = run(
      fakeVitest([
        { code: 1, report: rep([A]) },
        { code: 1, report: rep([A]) },
      ]),
      issues,
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain('failed on the re-run too');
  });

  it(`fails when more than ${MAX_QUARANTINE} tests are quarantined, even on a green run`, () => {
    const issues = Array.from({ length: MAX_QUARANTINE + 1 }, (_, i) => {
      const t = { file: `f${i}.test.ts`, test: 't' };
      const state = {
        ...t,
        firstSeenAt: '2026-10-01T00:00:00.000Z',
        lastSeenAt: '2026-10-01T00:00:00.000Z',
        observations: 1,
      };
      return { number: i + 1, title: titleOf(t), body: bodyOf(state, 'x'), author: BOT };
    });
    const r = run(fakeVitest([{ code: 0, report: rep([], [A]) }]), issues, {
      GITHUB_EVENT_NAME: 'push',
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('over budget');
    // A pull request only warns, so one bad day on main does not block every PR.
    rmSync(path.join(dir, 'attempts'));
    const pr = run(fakeVitest([{ code: 0, report: rep([], [A]) }]), issues, {
      GITHUB_EVENT_NAME: 'pull_request',
    });
    expect(pr.code).toBe(0);
    expect(pr.out).toContain('Warning only');
  });

  it('an error outside any test blocks, even when the failing test is a flake', () => {
    const r = run(
      fakeVitest([
        { code: 1, report: rep([A], [B]), stdout: ' Errors  1 error' },
        { code: 0, report: rep([], [A]) },
      ]),
    );
    expect(r.code).toBe(1);
    expect(attempts()).toBe(1);
    expect(r.out).toContain('error outside any test');
  });

  it(`more than ${MAX_RERUN_FILES} files with failures block without a re-run`, () => {
    const many = Array.from({ length: MAX_RERUN_FILES + 1 }, (_, i) => ({
      file: `f${i}.test.ts`,
      test: 't',
    }));
    const r = run(fakeVitest([{ code: 1, report: rep(many) }]));
    expect(r.code).toBe(1);
    expect(attempts()).toBe(1);
    expect(r.out).toContain('a broad failure, not a flake');
  });

  it('file creates, updates and (with --expire) closes issues, and never fails', () => {
    const reports = path.join(dir, 'reports', 'flaky-report-ubuntu-latest-1');
    spawnSync('mkdir', ['-p', reports]);
    writeFileSync(
      path.join(reports, 'flaky.json'),
      JSON.stringify({
        observations: [
          { kind: 'flaky', ...B, message: 'boom' },
          { kind: 'quarantined', ...A, message: 'boom' },
        ],
      }),
    );
    const seen = (t, lastSeenAt) => ({
      ...t,
      firstSeenAt: '2026-09-01T00:00:00.000Z',
      lastSeenAt,
      observations: 1,
    });
    const stale = { file: 'old.test.ts', test: 'old' };
    const recent = new Date(Date.now() - 86_400_000).toISOString();
    const issues = [
      { number: 1, title: titleOf(A), body: bodyOf(seen(A, recent), 'x'), author: BOT },
      {
        number: 2,
        title: titleOf(stale),
        body: bodyOf(seen(stale, '2026-01-01T00:00:00.000Z'), 'x'),
        author: BOT,
      },
      // A second main run filed A again: closed as a duplicate.
      { number: 7, title: titleOf(A), body: bodyOf(seen(A, recent), 'x'), author: BOT },
      // Not filed by GitHub Actions: ignored entirely.
      {
        number: 8,
        title: titleOf(stale),
        body: bodyOf(seen(stale, '2026-01-01T00:00:00.000Z'), 'x'),
        author: { login: 'human', is_bot: false },
      },
    ];
    const r = spawnSync(
      process.execPath,
      [
        SCRIPT,
        'file',
        '--reports',
        path.join(dir, 'reports'),
        '--run-url',
        'https://run/1',
        '--sha',
        'a'.repeat(40),
        '--expire',
      ],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, FLAKY_QUARANTINE_GH: fakeGh(issues) } },
    );
    expect(r.status).toBe(0);
    const calls = ghCalls();
    const verbs = calls.map((c) => `${c[0]} ${c[1]}`);
    expect(verbs).toEqual([
      'api graphql',
      'label create',
      'issue create',
      'issue edit',
      'issue close',
      'issue close',
    ]);
    expect(calls.find((c) => c[0] === 'issue' && c[1] === 'create')).toContain(titleOf(B));
    expect(calls.find((c) => c[0] === 'issue' && c[1] === 'edit')?.[2]).toBe('1');
    expect(calls.filter((c) => c[0] === 'issue' && c[1] === 'close').map((c) => c[2])).toEqual([
      '7',
      '2',
    ]);
    expect(r.stdout).toContain('1 filed, 1 updated, 1 expired');
  });
});

describe('ci.yml wiring (T13145)', () => {
  const ci = parseYaml(
    readFileSync(path.resolve(path.dirname(SCRIPT), '../.github/workflows/ci.yml'), 'utf8'),
  );

  it('runs every unit shard through the quarantine script and uploads its report', () => {
    const steps = ci.jobs['unit-tests'].steps;
    const run = steps.find(
      (s) => typeof s.run === 'string' && s.run.includes('ci-flaky-quarantine.mjs run'),
    );
    expect(run, 'the shard runs vitest through the script').toBeDefined();
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, matched literally in ci.yml
    expect(run.run).toContain('--log /tmp/vitest-shard${{ matrix.shard }}.log');
    // The shard count (#1822) and the PR-affected scope flags (#1821) reach vitest through the wrapper.
    expect(run.run).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, matched literally in ci.yml
      '-- --shard=${{ matrix.shard }}/${{ matrix.total }} $RETRY_FLAG $SCOPE_FLAGS',
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, matched literally in ci.yml
    expect(run.env?.AFFECTED_ARGS).toBe('${{ steps.affected.outputs.args }}');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, matched literally in ci.yml
    expect(run.env?.GH_TOKEN).toBe('${{ github.token }}');
    expect(
      steps.some((s) => typeof s.run === 'string' && /\bpnpm exec vitest run\b/.test(s.run)),
    ).toBe(false);
    const upload = steps.find(
      (s) =>
        s.uses?.startsWith('actions/upload-artifact') && s.with?.name?.startsWith('flaky-report-'),
    );
    expect(upload?.if).toBe('always()');
  });

  it('files only from main, may write issues, and is gated by the CI aggregate', () => {
    const job = ci.jobs['flaky-quarantine'];
    expect(job.if).toContain("github.ref == 'refs/heads/main'");
    expect(job.permissions.issues).toBe('write');
    expect(ci.jobs.ci.needs).toContain('flaky-quarantine');
  });
});
