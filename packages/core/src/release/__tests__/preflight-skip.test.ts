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
  MAX_EQUIVALENT_ANCESTORS,
  PREFLIGHT_CHECK_TIMEOUT_MS,
  type PreflightGhRunner,
} from '../preflight-skip.js';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

interface RunFixture {
  id: number;
  head_sha?: string;
  status?: string;
  conclusion?: string | null;
  event?: string;
}

interface StubOptions {
  sha?: string | Error;
  pushRuns?: RunFixture[] | Error;
  scheduleRuns?: RunFixture[] | Error;
  jobs?: Record<number, Array<{ name: string; conclusion: string | null }>>;
  /** Override `total_count` per run id (default: the number of jobs). */
  jobTotals?: Record<number, number>;
  /** First parent per commit (`commits/<sha> --jq .parents[0].sha`); absent → the call fails. */
  parents?: Record<string, string>;
}

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
    if (endpoint.includes('/actions/workflows/ci.yml/runs')) {
      return answer(opts.pushRuns, runsBody);
    }
    if (endpoint.includes('event=schedule')) {
      return answer(opts.scheduleRuns, runsBody);
    }
    const jobsMatch = /actions\/runs\/(\d+)\/jobs/.exec(endpoint);
    if (jobsMatch) {
      const id = Number(jobsMatch[1]);
      const jobs = opts.jobs?.[id] ?? [];
      return JSON.stringify({ total_count: opts.jobTotals?.[id] ?? jobs.length, jobs });
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

  it('judges the NEWEST run for the sha (a failed re-run supersedes a green one)', () => {
    const d = decidePreflightSkips(
      makeGh({ pushRuns: [{ id: 10 }, { id: 11, conclusion: 'failure' }] }),
      '/repo',
      'main',
    );
    expect(d.skipTests).toBe(false);
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
    expect(d).toMatchObject({ verifiedSha: SHA, skipTests: true, testedSha: P1 });
    expect(d.reason).toContain('Linux tests skipped');
    expect(d.reason).toContain(`${P1.slice(0, 12)} (an ancestor of ${SHA.slice(0, 12)})`);
    expect(d.reason).toContain('differs from it only by 1 commit(s)');
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
    expect(d.reason).toContain(`within ${MAX_EQUIVALENT_ANCESTORS} non-code commits`);
  });

  it('accepts a green nightly macOS run of an equivalent ancestor, never of one past the tested commit', () => {
    const macosGreen = [{ name: 'Unit Tests (macos-latest, shard 1)', conclusion: 'success' }];
    const onParent = decidePreflightSkips(
      makeGh({
        pushRuns: [
          { id: 10, head_sha: SHA },
          { id: 9, head_sha: P1 },
        ],
        scheduleRuns: [{ id: 30, head_sha: P1, event: 'schedule' }],
        jobs: { 10: GATED_OFF, 9: LINUX_GREEN, 30: macosGreen },
        parents: { [SHA]: P1 },
      }),
      '/repo',
      'main',
    );
    expect(onParent.skipMacosTests).toBe(true);
    expect(onParent.reason).toContain(`schedule run for ${P1.slice(0, 12)}`);

    // P2 is older than the tested commit P1: code changed in between.
    const pastTested = decidePreflightSkips(
      makeGh({
        pushRuns: [
          { id: 10, head_sha: SHA },
          { id: 9, head_sha: P1 },
        ],
        scheduleRuns: [{ id: 30, head_sha: P2, event: 'schedule' }],
        jobs: { 10: GATED_OFF, 9: LINUX_GREEN, 30: macosGreen },
        parents: { [SHA]: P1, [P1]: P2 },
      }),
      '/repo',
      'main',
    );
    expect(pastTested.skipMacosTests).toBe(false);
  });
});

describe('decidePreflightSkips — macOS shards', () => {
  it('skips when every macOS job of the nightly run for the sha succeeded', () => {
    const d = decidePreflightSkips(
      makeGh({
        scheduleRuns: [{ id: 20, event: 'schedule', conclusion: 'failure' }],
        jobs: {
          20: [
            { name: 'Unit Tests (macos-latest, shard 1)', conclusion: 'success' },
            { name: 'Unit Tests (macos-latest, shard 2)', conclusion: 'success' },
            // A non-macOS failure in the same run does not block the macOS skip.
            { name: 'Unit Tests (ubuntu-latest, shard 1)', conclusion: 'failure' },
          ],
        },
      }),
      '/repo',
      'main',
    );
    expect(d.skipMacosTests).toBe(true);
    expect(d.reason).toContain('macOS tests skipped');
    // The Linux decision is independent: no push run, so Linux tests run.
    expect(d.skipTests).toBe(false);
  });

  it('runs when any macOS job failed, or the run had no macOS jobs', () => {
    const failed = decidePreflightSkips(
      makeGh({
        scheduleRuns: [{ id: 20, event: 'schedule' }],
        jobs: {
          20: [
            { name: 'Unit Tests (macos-latest, shard 1)', conclusion: 'success' },
            { name: 'Unit Tests (macos-latest, shard 2)', conclusion: 'cancelled' },
          ],
        },
      }),
      '/repo',
      'main',
    );
    expect(failed.skipMacosTests).toBe(false);
    expect(failed.reason).toContain('did not succeed');

    const linuxOnly = decidePreflightSkips(
      makeGh({
        scheduleRuns: [{ id: 20, event: 'schedule' }],
        jobs: { 20: [{ name: 'Unit Tests (ubuntu-latest, shard 1)', conclusion: 'success' }] },
      }),
      '/repo',
      'main',
    );
    expect(linuxOnly.skipMacosTests).toBe(false);
  });

  it('accepts green macOS jobs from the main push run for the sha', () => {
    const d = decidePreflightSkips(
      makeGh({
        pushRuns: [{ id: 10 }],
        jobs: {
          10: [
            ...LINUX_GREEN,
            { name: 'Unit Tests (macos-latest, shard 1)', conclusion: 'success' },
          ],
        },
      }),
      '/repo',
      'main',
    );
    expect(d.skipTests).toBe(true);
    expect(d.skipMacosTests).toBe(true);
  });

  it('ignores a nightly run that is still in progress', () => {
    const d = decidePreflightSkips(
      makeGh({
        scheduleRuns: [{ id: 20, event: 'schedule', status: 'in_progress', conclusion: null }],
        jobs: { 20: [{ name: 'Unit Tests (macos-latest, shard 1)', conclusion: 'success' }] },
      }),
      '/repo',
      'main',
    );
    expect(d.skipMacosTests).toBe(false);
  });
});

describe('decidePreflightSkips — failure is never a skip', () => {
  it('runs everything when HEAD cannot be resolved', () => {
    for (const sha of [new Error('gh: timeout'), 'not-a-sha']) {
      const d = decidePreflightSkips(makeGh({ sha, pushRuns: [{ id: 10 }] }), '/repo', 'main');
      expect(d).toMatchObject({ verifiedSha: null, skipTests: false, skipMacosTests: false });
    }
  });

  it('runs everything when the run queries fail', () => {
    const d = decidePreflightSkips(
      makeGh({ pushRuns: new Error('HTTP 502'), scheduleRuns: new Error('HTTP 502') }),
      '/repo',
      'main',
    );
    expect(d.verifiedSha).toBe(SHA);
    expect(d.skipTests).toBe(false);
    expect(d.skipMacosTests).toBe(false);
  });

  it('bounds every gh call with the preflight timeout', () => {
    const gh = makeGh({ pushRuns: [{ id: 10 }], jobs: { 10: LINUX_GREEN } });
    decidePreflightSkips(gh, '/repo', 'main');
    expect(gh.timeouts.length).toBeGreaterThan(0);
    expect(new Set(gh.timeouts)).toEqual(new Set([PREFLIGHT_CHECK_TIMEOUT_MS]));
  });
});
