/**
 * Tests for {@link decidePreflightSkips} — which `release-prepare` preflight
 * test suites `cleo release open` may skip, decided from CI results GitHub
 * already holds for the same commit. `gh` is stubbed; every "skip" case is
 * paired with the nearby case that must NOT skip, because a check that
 * always skipped would pass the skip cases.
 */

import { describe, expect, it } from 'vitest';

import {
  decidePreflightSkips,
  isReleasePlanPath,
  MAX_EQUIVALENT_ANCESTORS,
  PREFLIGHT_CHECK_TIMEOUT_MS,
  PREFLIGHT_IN_FLIGHT_POLL_MS,
  type PreflightGhRunner,
  type PreflightSkipDecision,
  retargetPreflightSkips,
} from '../preflight-skip.js';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

interface RunFixture {
  id: number;
  head_sha?: string;
  status?: string;
  conclusion?: string | null;
  event?: string;
  /** Workflow file (default `.github/workflows/ci.yml`). */
  path?: string;
}

interface StubOptions {
  sha?: string | Error;
  pushRuns?: RunFixture[] | Error;
  jobs?: Record<number, Array<{ name: string; conclusion: string | null }>>;
  /** Override `total_count` per run id (default: the number of jobs). */
  jobTotals?: Record<number, number>;
  /** First parent per commit (`commits/<sha> --jq .parents[0].sha`); absent → the call fails. */
  parents?: Record<string, string>;
  /** Files a commit changes against its parent (compare API); absent → a release-plan commit. */
  files?: Record<string, string[]>;
}

/** What a release-plan PR's merge changes. */
const PLAN_FILES = [
  '.cleo/release/v2026.10.4.plan.json',
  'CHANGELOG.md',
  '.changeset/shipped/v2026.10.3/a.md',
];

/** Every Linux Unit Tests shard green — what a push run that TESTED the tree carries. */
const LINUX_GREEN = [1, 2, 3, 4].map((n) => ({
  name: `Unit Tests (ubuntu-latest, shard ${n})`,
  conclusion: 'success',
}));

function runsBody(runs: RunFixture[]): string {
  return JSON.stringify({
    workflow_runs: runs.map((r) => ({
      id: r.id,
      head_sha: r.head_sha ?? SHA,
      status: r.status ?? 'completed',
      conclusion: r.conclusion === undefined ? 'success' : r.conclusion,
      event: r.event ?? 'push',
      path: r.path ?? '.github/workflows/ci.yml',
      html_url: `https://github.com/o/r/actions/runs/${r.id}`,
    })),
  });
}

function makeGh(opts: StubOptions): PreflightGhRunner & { calls: string[][]; timeouts: number[] } {
  const calls: string[][] = [];
  const timeouts: number[] = [];
  const answer = <T>(value: T | Error | undefined, render: (v: T) => string): string => {
    if (value instanceof Error) throw value;
    if (value === undefined) return JSON.stringify({ workflow_runs: [] });
    return render(value);
  };
  const gh: PreflightGhRunner = (args, _cwd, timeoutMs) => {
    calls.push([...args]);
    timeouts.push(timeoutMs);
    const endpoint = args[1] ?? '';
    if (endpoint.includes('/commits/') && args.includes('.parents[0].sha')) {
      const child = endpoint.slice(endpoint.lastIndexOf('/') + 1);
      const parent = opts.parents?.[child];
      if (parent === undefined) throw new Error(`no parent stubbed for ${child}`);
      return `${parent}\n`;
    }
    if (endpoint.includes('/commits/')) {
      if (opts.sha instanceof Error) throw opts.sha;
      return `${opts.sha ?? SHA}\n`;
    }
    if (endpoint.includes('/compare/')) {
      const commit = endpoint.slice(endpoint.lastIndexOf('...') + 3);
      return JSON.stringify(opts.files?.[commit] ?? PLAN_FILES);
    }
    if (endpoint.includes('/actions/workflows/ci.yml/runs')) {
      return answer(opts.pushRuns, runsBody);
    }
    const jobsMatch = /actions\/runs\/(\d+)\/jobs/.exec(endpoint);
    if (jobsMatch) {
      const id = Number(jobsMatch[1]);
      const all = opts.jobs?.[id] ?? [];
      // Pages of 100, as the jobs API serves them; a forced total repeats page 1.
      const page = Number(/[?&]page=(\d+)/.exec(endpoint)?.[1] ?? '1');
      const jobs =
        opts.jobTotals?.[id] === undefined ? all.slice((page - 1) * 100, page * 100) : all;
      return JSON.stringify({ total_count: opts.jobTotals?.[id] ?? all.length, jobs });
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  return Object.assign(gh, { calls, timeouts });
}

describe('decidePreflightSkips — Linux shards', () => {
  it('skips when main push CI for the SAME sha is green, and says so', () => {
    const gh = makeGh({ pushRuns: [{ id: 10 }], jobs: { 10: LINUX_GREEN } });
    const d = decidePreflightSkips(gh, '/repo', 'main');
    expect(d.verifiedSha).toBe(SHA);
    expect(d.skipTests).toBe(true);
    expect(d.reason).toContain('Linux tests skipped');
    expect(d.reason).toContain('runs/10');
    // Queried for the push event on main at exactly this sha.
    const query = gh.calls.find((c) => c[1]?.includes('/actions/workflows/ci.yml/runs'));
    expect(query?.[1]).toContain(`head_sha=${SHA}`);
    expect(query?.[1]).toContain('event=push');
    expect(query?.[1]).toContain('branch=main');
  });

  it('runs when the push run failed, is in progress, or is for another sha', () => {
    for (const pushRuns of [
      [{ id: 10, conclusion: 'failure' }],
      [{ id: 10, status: 'in_progress', conclusion: null }],
      [{ id: 10, head_sha: OTHER_SHA }],
      [],
    ] satisfies RunFixture[][]) {
      const d = decidePreflightSkips(makeGh({ pushRuns }), '/repo', 'main');
      expect(d.skipTests, JSON.stringify(pushRuns)).toBe(false);
      expect(d.reason).toContain('Linux tests run');
    }
  });

  it('runs when the green push run did not actually run every Linux shard green', () => {
    const cases: Array<[string, Array<{ name: string; conclusion: string | null }>]> = [
      // Docs-only push: `changes` gated Unit Tests off, the run is still green.
      ['no Unit Tests jobs', [{ name: 'Lint & Format', conclusion: 'success' }]],
      ['skipped matrix', [{ name: 'Unit Tests (, shard )', conclusion: 'skipped' }]],
      [
        'one shard skipped',
        LINUX_GREEN.map((j, i) => (i === 2 ? { ...j, conclusion: 'skipped' } : j)),
      ],
      ['a shard missing', LINUX_GREEN.filter((_, i) => i !== 1)],
      ['only macOS ran', [{ name: 'Unit Tests (macos-latest, shard 1)', conclusion: 'success' }]],
    ];
    for (const [label, jobs] of cases) {
      const d = decidePreflightSkips(
        makeGh({ pushRuns: [{ id: 10 }], jobs: { 10: jobs } }),
        '/repo',
        'main',
      );
      expect(d.skipTests, label).toBe(false);
      expect(d.reason, label).toContain('Linux tests run');
    }
  });

  it('runs when the job list is partial (total_count exceeds the page)', () => {
    const d = decidePreflightSkips(
      makeGh({ pushRuns: [{ id: 10 }], jobs: { 10: LINUX_GREEN }, jobTotals: { 10: 150 } }),
      '/repo',
      'main',
    );
    expect(d.skipTests).toBe(false);
    expect(d.reason).toContain('could not be read');
  });

  it('reads a job list longer than one page (a ci.yml run with its shards lists 102+ jobs)', () => {
    const filler = Array.from({ length: 96 }, (_, i) => ({
      name: `Gate ${i}`,
      conclusion: 'success',
    }));
    const d = decidePreflightSkips(
      makeGh({ pushRuns: [{ id: 10 }], jobs: { 10: [...filler, ...LINUX_GREEN, ...LINUX_GREEN] } }),
      '/repo',
      'main',
    );
    expect(d).toMatchObject({ skipTests: true, testedSha: SHA, testedRunId: 10 });
  });

  it('judges the NEWEST run for the sha (a failed re-run supersedes a green one)', () => {
    const d = decidePreflightSkips(
      makeGh({ pushRuns: [{ id: 10 }, { id: 11, conclusion: 'failure' }] }),
      '/repo',
      'main',
    );
    expect(d.skipTests).toBe(false);
  });
});

describe('decidePreflightSkips — waits for an in-flight push run (T13823)', () => {
  /** A gh runner whose ci.yml push run for SHA completes after `pending` polls. */
  function inFlight(pending: number) {
    const done = makeGh({ pushRuns: [{ id: 10 }], jobs: { 10: LINUX_GREEN } });
    const running = makeGh({ pushRuns: [{ id: 10, status: 'queued', conclusion: null }] });
    let polls = 0;
    const gh: PreflightGhRunner = (args, cwd, timeoutMs) => {
      if (args[1]?.includes('/actions/workflows/ci.yml/runs?head_sha=')) {
        polls += 1;
        if (polls <= pending) return running(args, cwd, timeoutMs);
      }
      return done(args, cwd, timeoutMs);
    };
    return gh;
  }

  it('polls a queued run until it completes, then skips and names the run', () => {
    const sleeps: number[] = [];
    const d = decidePreflightSkips(inFlight(3), '/repo', 'main', {
      inFlightWaitMs: 10 * 60_000,
      sleep: (ms) => sleeps.push(ms),
    });
    expect(d).toMatchObject({ skipTests: true, testedSha: SHA, testedRunId: 10 });
    expect(sleeps).toEqual([
      PREFLIGHT_IN_FLIGHT_POLL_MS,
      PREFLIGHT_IN_FLIGHT_POLL_MS,
      PREFLIGHT_IN_FLIGHT_POLL_MS,
    ]);
  });

  it('runs the tests when the run is still unfinished after the wait budget', () => {
    const sleeps: number[] = [];
    const d = decidePreflightSkips(inFlight(1000), '/repo', 'main', {
      inFlightWaitMs: 75_000,
      sleep: (ms) => sleeps.push(ms),
    });
    expect(d).toMatchObject({ skipTests: false, testedRunId: null });
    expect(d.reason).toContain('is queued');
    expect(d.reason).toContain('after waiting 75s');
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(75_000);
  });

  it('never waits without a budget (the default)', () => {
    const sleeps: number[] = [];
    const d = decidePreflightSkips(inFlight(1), '/repo', 'main', {
      sleep: (ms) => sleeps.push(ms),
    });
    expect(d.skipTests).toBe(false);
    expect(sleeps).toEqual([]);
  });
});

/**
 * T13140: the release's HEAD is the merge of the release-plan PR (plan file,
 * CHANGELOG, changesets). Its push run is green but CI gated every Unit Tests
 * shard off, so the tested run belongs to an ancestor CI judged equivalent.
 */
describe('decidePreflightSkips — a tested ancestor CI judged equivalent (T13140)', () => {
  /** What a push run CI judged test-irrelevant carries: Detect Changes green, the matrix skipped. */
  const GATED_OFF = [
    { name: 'Detect Changes', conclusion: 'success' },
    { name: 'Lint & Format', conclusion: 'success' },
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal name GitHub renders for a matrix job its `if:` skipped
    { name: 'Unit Tests (${{ matrix.os }}, shard ${{ matrix.shard }})', conclusion: 'skipped' },
  ];
  const P1 = 'c'.repeat(40);
  const P2 = 'd'.repeat(40);

  it("skips on the parent's tested run when HEAD's push CI ran no Unit Tests, and names both commits", () => {
    const d = decidePreflightSkips(
      makeGh({
        pushRuns: [
          { id: 10, head_sha: SHA },
          { id: 9, head_sha: P1 },
        ],
        jobs: { 10: GATED_OFF, 9: LINUX_GREEN },
        parents: { [SHA]: P1 },
      }),
      '/repo',
      'main',
    );
    expect(d).toMatchObject({ verifiedSha: SHA, skipTests: true, testedSha: P1, testedRunId: 9 });
    expect(d.reason).toContain('Linux tests skipped');
    expect(d.reason).toContain(`${P1.slice(0, 12)} (an ancestor of ${SHA.slice(0, 12)})`);
    expect(d.reason).toContain('differs from it only by 1 release-plan commit(s)');
  });

  it('walks several non-code commits, but stops at a step CI did not judge test-irrelevant', () => {
    const walked = decidePreflightSkips(
      makeGh({
        pushRuns: [
          { id: 10, head_sha: SHA },
          { id: 9, head_sha: P1 },
          { id: 8, head_sha: P2 },
        ],
        jobs: { 10: GATED_OFF, 9: GATED_OFF, 8: LINUX_GREEN },
        parents: { [SHA]: P1, [P1]: P2 },
      }),
      '/repo',
      'main',
    );
    expect(walked).toMatchObject({ skipTests: true, testedSha: P2 });

    // No Detect Changes job: nothing says the skipped matrix was CI's own judgment.
    const noGate = decidePreflightSkips(
      makeGh({
        pushRuns: [
          { id: 10, head_sha: SHA },
          { id: 9, head_sha: P1 },
        ],
        jobs: { 10: GATED_OFF.filter((j) => j.name !== 'Detect Changes'), 9: LINUX_GREEN },
        parents: { [SHA]: P1 },
      }),
      '/repo',
      'main',
    );
    expect(noGate).toMatchObject({ skipTests: false, testedSha: null });
    expect(noGate.reason).toContain('Linux tests run');
  });

  it("runs when the ancestor's run failed, has no run, or the parent cannot be resolved", () => {
    const cases: Array<[string, Parameters<typeof makeGh>[0]]> = [
      [
        'ancestor failed',
        {
          pushRuns: [
            { id: 10, head_sha: SHA },
            { id: 9, head_sha: P1, conclusion: 'failure' },
          ],
          jobs: { 10: GATED_OFF, 9: LINUX_GREEN },
          parents: { [SHA]: P1 },
        },
      ],
      [
        'ancestor has no push run',
        { pushRuns: [{ id: 10, head_sha: SHA }], jobs: { 10: GATED_OFF }, parents: { [SHA]: P1 } },
      ],
      ['parent unresolvable', { pushRuns: [{ id: 10, head_sha: SHA }], jobs: { 10: GATED_OFF } }],
    ];
    for (const [label, opts] of cases) {
      const d = decidePreflightSkips(makeGh(opts), '/repo', 'main');
      expect(d.skipTests, label).toBe(false);
      expect(d.testedSha, label).toBeNull();
      expect(d.reason, label).toContain('Linux tests run');
    }
  });

  it(`gives up after ${MAX_EQUIVALENT_ANCESTORS} non-code commits`, () => {
    const chain = Array.from({ length: MAX_EQUIVALENT_ANCESTORS + 2 }, (_, i) =>
      i === 0 ? SHA : i.toString(16).padStart(40, '0'),
    );
    const pushRuns = chain.map((sha, i) => ({ id: 100 - i, head_sha: sha }));
    const jobs = Object.fromEntries(
      pushRuns.map((r, i) => [r.id, i === chain.length - 1 ? LINUX_GREEN : GATED_OFF]),
    );
    const parents = Object.fromEntries(chain.slice(0, -1).map((sha, i) => [sha, chain[i + 1]]));
    const d = decidePreflightSkips(makeGh({ pushRuns, jobs, parents }), '/repo', 'main');
    expect(d.skipTests).toBe(false);
    expect(d.reason).toContain(`within ${MAX_EQUIVALENT_ANCESTORS} release-plan commits`);
  });
});

describe('decidePreflightSkips — only release-plan commits are stepped past (T13140 review)', () => {
  const GATED_OFF = [
    { name: 'Detect Changes', conclusion: 'success' },
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal name GitHub renders for a matrix job its `if:` skipped
    { name: 'Unit Tests (${{ matrix.os }}, shard ${{ matrix.shard }})', conclusion: 'skipped' },
  ];
  const P1 = 'c'.repeat(40);
  const base = {
    pushRuns: [
      { id: 10, head_sha: SHA },
      { id: 9, head_sha: P1 },
    ],
    jobs: { 10: GATED_OFF, 9: LINUX_GREEN },
    parents: { [SHA]: P1 },
  };

  it('a release-plan path is the plan file, a changeset or a changelog, nothing a test reads', () => {
    for (const p of PLAN_FILES) expect(isReleasePlanPath(p), p).toBe(true);
    for (const p of [
      '.cleo/adrs/ADR-1.md',
      '.cleo/cant/agents/x.cant',
      '.cleo/deprecations.yml',
      'packages/core/CHANGELOG.mdx',
      'docs/x.md',
      // T13825: whole-path allowlist, no prefix that could reach code or config.
      '.cleo/release/v1.json',
      '.cleo/release/nested/v1.plan.json',
      '.cleo/release/run.ts',
      '.changeset/config.json',
      '.changeset/x.ts',
      'x/.changeset/a.md',
      'x/.cleo/release/v1.plan.json',
      'CHANGELOG.md.ts',
    ]) {
      expect(isReleasePlanPath(p), p).toBe(false);
    }
  });

  it('does not borrow across a gated-off commit that changes anything else (the code filter can miss test inputs)', () => {
    const d = decidePreflightSkips(
      makeGh({ ...base, files: { [SHA]: ['.cleo/adrs/ADR-099.md'] } }),
      '/repo',
      'main',
    );
    expect(d).toMatchObject({ skipTests: false, testedSha: null });
    expect(d.reason).toContain('is not a release-plan commit (.cleo/adrs/ADR-099.md)');
    // A rename's old path is listed too, so a code file moved into .changeset/ is refused.
    const compare = makeGh(base);
    decidePreflightSkips(compare, '/repo', 'main');
    const call = compare.calls.find((c) => c[1]?.includes('/compare/'));
    expect(call).toContain('[.files[] | .filename, (.previous_filename // empty)]');
  });

  it('does not borrow when the changed files cannot be listed or may be truncated', () => {
    const many = Array.from({ length: 300 }, (_, i) => `.changeset/c${i}.md`);
    expect(
      decidePreflightSkips(makeGh({ ...base, files: { [SHA]: many } }), '/repo', 'main').skipTests,
    ).toBe(false);
  });

  it('stops at the overall deadline and runs the tests', () => {
    let t = 0;
    const gh = makeGh(base);
    const slow: PreflightGhRunner = (args, cwd, timeoutMs) => {
      t += 20_000;
      return gh(args, cwd, timeoutMs);
    };
    const d = decidePreflightSkips(slow, '/repo', 'main', { deadlineMs: 60_000, now: () => t });
    expect(d.skipTests).toBe(false);
    expect(d.reason).toContain('budget for these checks ran out');
    // No call is ever given more time than is left.
    expect(Math.max(...gh.timeouts)).toBeLessThanOrEqual(PREFLIGHT_CHECK_TIMEOUT_MS);
  });
});

describe('decidePreflightSkips — failure is never a skip', () => {
  it('runs everything when HEAD cannot be resolved', () => {
    for (const sha of [new Error('gh: timeout'), 'not-a-sha']) {
      const d = decidePreflightSkips(makeGh({ sha, pushRuns: [{ id: 10 }] }), '/repo', 'main');
      expect(d).toMatchObject({ verifiedSha: null, skipTests: false });
    }
  });

  it('runs everything when the run queries fail', () => {
    const d = decidePreflightSkips(makeGh({ pushRuns: new Error('HTTP 502') }), '/repo', 'main');
    expect(d.verifiedSha).toBe(SHA);
    expect(d.skipTests).toBe(false);
  });

  it('never asks GitHub about macOS: release waits on no macOS runner (T14104)', () => {
    const gh = makeGh({ pushRuns: [{ id: 10 }], jobs: { 10: LINUX_GREEN } });
    const d = decidePreflightSkips(gh, '/repo', 'main');
    expect(d.skipTests).toBe(true);
    expect(d).not.toHaveProperty('skipMacosTests');
    expect(gh.calls.flat().join(' ')).not.toMatch(
      /macos|head_sha=[^&]*&per_page=50|event=schedule/i,
    );
  });

  it('bounds every gh call with the preflight timeout', () => {
    const gh = makeGh({ pushRuns: [{ id: 10 }], jobs: { 10: LINUX_GREEN } });
    decidePreflightSkips(gh, '/repo', 'main');
    expect(gh.timeouts.length).toBeGreaterThan(0);
    expect(new Set(gh.timeouts)).toEqual(new Set([PREFLIGHT_CHECK_TIMEOUT_MS]));
  });
});

describe('retargetPreflightSkips — the single release PR plan branch (T13825)', () => {
  const REF_SHA = 'e'.repeat(40);
  const main: PreflightSkipDecision = {
    verifiedSha: SHA,
    skipTests: true,
    testedSha: SHA,
    testedRunId: 10,
    reason: 'Linux tests skipped.',
  };
  /** A gh runner answering only the compare of SHA...REF_SHA. */
  const compareGh =
    (body: unknown): PreflightGhRunner =>
    (args) => {
      if (args[1] !== `repos/{owner}/{repo}/compare/${SHA}...${REF_SHA}`) {
        throw new Error(`unexpected gh call: ${args.join(' ')}`);
      }
      if (body instanceof Error) throw body;
      return JSON.stringify(body);
    };

  it('keeps the skips, re-keyed to the plan branch, when it adds release-plan files only', () => {
    const d = retargetPreflightSkips(
      main,
      compareGh({ status: 'ahead', files: ['.cleo/release/v1.plan.json', 'CHANGELOG.md'] }),
      '/repo',
      'release/plan-v1',
      REF_SHA,
    );
    expect(d).toMatchObject({
      verifiedSha: REF_SHA,
      skipTests: true,
      testedRunId: 10,
    });
    expect(d.reason).toContain('carry over');
  });

  it('drops every skip when the branch carries anything else, diverged, or cannot be compared', () => {
    for (const body of [
      { status: 'ahead', files: ['CHANGELOG.md', 'packages/core/src/x.ts'] },
      { status: 'diverged', files: ['CHANGELOG.md'] },
      { status: 'identical', files: [] },
      { status: 'ahead', files: Array.from({ length: 300 }, (_, i) => `.changeset/c${i}.md`) },
      new Error('HTTP 404'),
    ]) {
      const d = retargetPreflightSkips(main, compareGh(body), '/repo', 'release/plan-v1', REF_SHA);
      expect(d, JSON.stringify(body)).toMatchObject({
        verifiedSha: REF_SHA,
        skipTests: false,
        testedRunId: null,
      });
      expect(d.reason).toContain('Every preflight suite runs on release/plan-v1');
    }
  });

  it('re-keys a decision with no skips without asking GitHub', () => {
    const none = {
      ...main,
      skipTests: false,
      testedSha: null,
      testedRunId: null,
    };
    const calls: string[][] = [];
    const d = retargetPreflightSkips(
      none,
      (args) => {
        calls.push([...args]);
        return '';
      },
      '/repo',
      'r',
      REF_SHA,
    );
    expect(d).toMatchObject({ verifiedSha: REF_SHA, skipTests: false, reason: main.reason });
    expect(calls).toEqual([]);
  });
});
