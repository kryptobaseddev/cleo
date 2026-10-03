/**
 * Tests for scripts/release-promote.mjs and the workflow that runs it (T13144).
 *
 * The registry is a fake that answers the three documents an install reads
 * (per-version metadata, tarball, dist-tags) from a mutable table, so a fake
 * `npm dist-tag add` can move `latest` and the convergence wait observes it.
 * GitHub is a fake `gh` that answers by subcommand.
 *
 * The workflow guards at the bottom hold the owner's conditions: only
 * release-promote.yml may reference the `npm-promote` environment or
 * NPM_TOKEN, the token lives only in the approval-gated job, and release.yml
 * publishes a stable version under `canary`.
 *
 * @task T13144
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  decideMode,
  evaluateVerdict,
  main,
  movePointers,
  parseArgs,
  planPromotion,
  readVerdict,
  VERDICT_JOB,
  waitForLatest,
} from '../release-promote.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOWS = path.join(REPO_ROOT, '.github/workflows');
const NEW = '2026.10.5';
const OLD = '2026.10.4';
const PACKAGES = ['contracts', 'core', 'cleo'];

/**
 * A fake npm registry.
 *
 * @param {object} opts
 * @param {Record<string, Record<string, string>>} opts.tags - dist-tags by package.
 * @param {Record<string, string[]>} [opts.published] - Versions by package; defaults
 *   to OLD and NEW for every package in `tags`.
 * @param {Set<string>} [opts.missingTarball] - `pkg@version` whose tarball 404s.
 * @param {Set<string>} [opts.brokenTags] - Packages whose dist-tags endpoint 500s.
 */
function fakeRegistry({ tags, published, missingTarball = new Set(), brokenTags = new Set() }) {
  const versions =
    published ?? Object.fromEntries(Object.keys(tags).map((pkg) => [pkg, [OLD, NEW]]));
  const res = (status, body) => ({ ok: status < 300, status, json: async () => body });
  /** @type {typeof fetch} */
  const fetchImpl = async (url) => {
    const u = String(url);
    let m = /\/-\/package\/@cleocode%2f([^/]+)\/dist-tags$/.exec(u);
    if (m) return brokenTags.has(m[1]) ? res(500, {}) : res(200, { ...tags[m[1]] });
    m = /\/@cleocode\/([^/]+)\/-\/[^/]+-(\d[^/]*)\.tgz$/.exec(u);
    if (m) return res(missingTarball.has(`${m[1]}@${m[2]}`) ? 404 : 200, null);
    m = /\/@cleocode\/([^/]+)\/(\d[^/]*)$/.exec(u);
    if (m) {
      if (!versions[m[1]]?.includes(m[2])) return res(404, {});
      return res(200, {
        version: m[2],
        dist: { tarball: `https://registry.npmjs.org/@cleocode/${m[1]}/-/${m[1]}-${m[2]}.tgz` },
      });
    }
    throw new Error(`unexpected URL ${u}`);
  };
  return { fetchImpl, tags };
}

/** Machine state of a tracking issue, as release-verdict.mjs and the watcher write it. */
function trackerBody(version, outcome, coverage = 'current') {
  const state = {
    version,
    distTag: 'canary',
    lastObservation: { outcome, coverage, observedAt: '2026-10-05T10:00:00.000Z' },
  };
  return `v${version} published\n\n<!-- release-installability-state\n${JSON.stringify(state)}\n-->`;
}

const BOT = { login: 'app/github-actions', is_bot: true };

/**
 * A fake `gh`.
 *
 * @param {object} [opts]
 * @param {Array<object>} [opts.issues]
 * @param {Array<object>} [opts.tagRuns] - Returned for `run list --branch`.
 * @param {Array<object>} [opts.dispatchRuns] - Returned for `run list --event workflow_dispatch`.
 * @param {Array<object>} [opts.jobs] - Verdict job lines for `api`.
 */
function fakeGh(opts = {}) {
  const {
    issues = [],
    tagRuns = [
      {
        databaseId: 7,
        headBranch: `v${NEW}`,
        displayTitle: `Release v${NEW}`,
        status: 'completed',
        conclusion: 'success',
        createdAt: '2026-10-05T09:00:00Z',
      },
    ],
    dispatchRuns = [],
    jobs = [{ status: 'completed', conclusion: 'success' }],
  } = opts;
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'issue') return JSON.stringify(issues);
    if (args[0] === 'run' && args.includes('--branch')) {
      const branch = args[args.indexOf('--branch') + 1];
      return JSON.stringify(tagRuns.filter((r) => r.headBranch === branch));
    }
    if (args[0] === 'run') return JSON.stringify(dispatchRuns);
    if (args[0] === 'api') return jobs.map((j) => JSON.stringify(j)).join('\n');
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { gh, calls };
}

/** Tags with NEW soaking in canary and OLD on latest. */
const soaking = () => Object.fromEntries(PACKAGES.map((p) => [p, { canary: NEW, latest: OLD }]));

describe('parseArgs', () => {
  it('accepts plan and promote with a stable version, with or without a leading v', () => {
    expect(parseArgs(['plan', '--version', NEW])).toEqual({ command: 'plan', version: NEW });
    expect(parseArgs(['promote', '--version', `v${NEW}`])).toEqual({
      command: 'promote',
      version: NEW,
    });
  });

  it('rejects prereleases, junk, missing versions and unknown commands', () => {
    expect(parseArgs(['plan', '--version', `${NEW}-beta.1`]).error).toBeDefined();
    expect(parseArgs(['plan', '--version', `${NEW};rm`]).error).toBeDefined();
    expect(parseArgs(['plan']).error).toBeDefined();
    expect(parseArgs(['publish', '--version', NEW]).error).toBeDefined();
    expect(parseArgs(['plan', '--version', NEW, '--force']).error).toBeDefined();
  });
});

describe('decideMode', () => {
  it('promotes a version newer than every latest', () => {
    expect(decideMode(NEW, [OLD, OLD])).toBe('promote');
  });

  it('rolls back to a version older than latest', () => {
    expect(decideMode(OLD, [NEW, NEW])).toBe('rollback');
  });

  it('does nothing when latest is already the version everywhere', () => {
    expect(decideMode(NEW, [NEW, NEW])).toBe('noop');
  });

  it('keeps the mode on a re-run after a partial move', () => {
    expect(decideMode(NEW, [NEW, OLD])).toBe('promote');
    expect(decideMode(OLD, [OLD, NEW])).toBe('rollback');
  });

  it('treats an absent latest as something to set', () => {
    expect(decideMode(NEW, [NEW, null])).toBe('promote');
  });
});

describe('evaluateVerdict', () => {
  const run = { databaseId: 7, status: 'completed', conclusion: 'failure' };

  it('is green when the newest tracking observation is installable', () => {
    const v = evaluateVerdict({
      version: NEW,
      trackers: [{ number: 5, body: trackerBody(NEW, 'installable') }],
    });
    expect(v.green).toBe(true);
    expect(v.source).toBe('tracking issue #5');
  });

  it('is not green while the tracker is pending, or its coverage is partial', () => {
    for (const body of [trackerBody(NEW, 'pending'), trackerBody(NEW, 'installable', 'partial')])
      expect(evaluateVerdict({ version: NEW, trackers: [{ number: 5, body }] }).green).toBe(false);
  });

  it('reads the newest tracker, not the first', () => {
    const v = evaluateVerdict({
      version: NEW,
      trackers: [
        { number: 5, body: trackerBody(NEW, 'installable') },
        { number: 9, body: trackerBody(NEW, 'pending') },
      ],
    });
    expect(v.green).toBe(false);
    expect(v.source).toBe('tracking issue #9');
  });

  it('without a tracker, follows the release run verdict job', () => {
    const job = (conclusion) => ({ status: 'completed', conclusion });
    expect(
      evaluateVerdict({ version: NEW, trackers: [], run, verdictJob: job('success') }).green,
    ).toBe(true);
    expect(
      evaluateVerdict({ version: NEW, trackers: [], run, verdictJob: job('failure') }).green,
    ).toBe(false);
    expect(evaluateVerdict({ version: NEW, trackers: [], run, verdictJob: null }).green).toBe(
      false,
    );
    expect(
      evaluateVerdict({
        version: NEW,
        trackers: [],
        run: { ...run, status: 'in_progress' },
        verdictJob: job('success'),
      }).green,
    ).toBe(false);
    expect(evaluateVerdict({ version: NEW, trackers: [], run: null }).green).toBe(false);
  });
});

describe('readVerdict', () => {
  it('ignores a tracker anyone but the workflow bot opened', () => {
    const { gh } = fakeGh({
      issues: [
        {
          number: 3,
          body: trackerBody(NEW, 'installable'),
          author: { login: 'someone', is_bot: false },
        },
      ],
      jobs: [{ status: 'completed', conclusion: 'failure' }],
    });
    const v = readVerdict(NEW, gh);
    expect(v.green).toBe(false);
    expect(v.source).toBe('release.yml run 7');
  });

  it('matches the version exactly, not by prefix', () => {
    const { gh } = fakeGh({
      issues: [{ number: 3, body: trackerBody(`${NEW}0`, 'pending'), author: BOT }],
    });
    expect(readVerdict(NEW, gh)).toMatchObject({ green: true, source: 'release.yml run 7' });
  });

  it('prefers a trusted tracker over the run', () => {
    const { gh } = fakeGh({
      issues: [{ number: 4, body: trackerBody(NEW, 'pending'), author: BOT }],
    });
    expect(readVerdict(NEW, gh)).toMatchObject({ green: false, source: 'tracking issue #4' });
  });

  it('reads the newest run, counting a break-glass dispatch by its run name', () => {
    const { gh, calls } = fakeGh({
      dispatchRuns: [
        {
          databaseId: 8,
          headBranch: 'main',
          displayTitle: `Release v${NEW}`,
          status: 'completed',
          conclusion: 'success',
          createdAt: '2026-10-05T11:00:00Z',
        },
        {
          databaseId: 9,
          headBranch: 'main',
          displayTitle: `Release v${OLD}`,
          status: 'completed',
          conclusion: 'success',
          createdAt: '2026-10-05T12:00:00Z',
        },
      ],
    });
    expect(readVerdict(NEW, gh).source).toBe('release.yml run 8');
    const api = calls.find((c) => c[0] === 'api');
    expect(api).toContain('--paginate');
    expect(api?.find((a) => a.includes('/actions/runs/8/jobs'))).toContain('per_page=100');
    expect(api?.find((a) => a.includes(VERDICT_JOB))).toBeDefined();
  });
});

describe('planPromotion', () => {
  it('plans a promotion of the current canary', async () => {
    const { fetchImpl } = fakeRegistry({ tags: soaking() });
    const plan = await planPromotion({
      version: NEW,
      packages: PACKAGES,
      fetchImpl,
      gh: fakeGh().gh,
    });
    expect(plan.blockers).toEqual([]);
    expect(plan).toMatchObject({ ok: true, mode: 'promote', moves: PACKAGES });
  });

  it('a re-run after a partial move moves only what is left', async () => {
    const tags = soaking();
    tags.contracts.latest = NEW;
    const { fetchImpl } = fakeRegistry({ tags });
    const plan = await planPromotion({
      version: NEW,
      packages: PACKAGES,
      fetchImpl,
      gh: fakeGh().gh,
    });
    expect(plan).toMatchObject({ ok: true, mode: 'promote', moves: ['core', 'cleo'] });
  });

  it('blocks a promotion when any package canary is not the version', async () => {
    const tags = soaking();
    tags.core.canary = '2026.10.6';
    const { fetchImpl } = fakeRegistry({ tags });
    const plan = await planPromotion({
      version: NEW,
      packages: PACKAGES,
      fetchImpl,
      gh: fakeGh().gh,
    });
    expect(plan.ok).toBe(false);
    expect(plan.blockers.join('\n')).toContain('@cleocode/core: canary is 2026.10.6');
  });

  it('blocks when a package does not resolve at the version', async () => {
    const { fetchImpl } = fakeRegistry({
      tags: soaking(),
      missingTarball: new Set([`cleo@${NEW}`]),
    });
    const plan = await planPromotion({
      version: NEW,
      packages: PACKAGES,
      fetchImpl,
      gh: fakeGh().gh,
    });
    expect(plan.ok).toBe(false);
    expect(plan.blockers.join('\n')).toMatch(
      /@cleocode\/cleo@2026\.10\.5 does not resolve \(tarball/,
    );
  });

  it('plans a rollback without requiring the canary', async () => {
    const tags = Object.fromEntries(PACKAGES.map((p) => [p, { canary: '2026.10.6', latest: NEW }]));
    const { fetchImpl } = fakeRegistry({ tags });
    const { gh } = fakeGh({
      tagRuns: [
        {
          databaseId: 6,
          headBranch: `v${OLD}`,
          displayTitle: 'release: prepare',
          status: 'completed',
          conclusion: 'success',
          createdAt: '2026-10-04T09:00:00Z',
        },
      ],
    });
    const plan = await planPromotion({ version: OLD, packages: PACKAGES, fetchImpl, gh });
    expect(plan.blockers).toEqual([]);
    expect(plan).toMatchObject({ ok: true, mode: 'rollback', moves: PACKAGES });
  });

  it('blocks with an unknown mode when dist-tags cannot be read', async () => {
    const { fetchImpl } = fakeRegistry({ tags: soaking(), brokenTags: new Set(['core']) });
    const plan = await planPromotion({
      version: NEW,
      packages: PACKAGES,
      fetchImpl,
      gh: fakeGh().gh,
    });
    expect(plan.mode).toBe('unknown');
    expect(plan.blockers.join('\n')).toContain('@cleocode/core: dist-tags unreadable');
  });

  it('blocks when the verdict cannot be read', async () => {
    const { fetchImpl } = fakeRegistry({ tags: soaking() });
    const gh = () => {
      throw new Error('HTTP 403');
    };
    const plan = await planPromotion({ version: NEW, packages: PACKAGES, fetchImpl, gh });
    expect(plan.ok).toBe(false);
    expect(plan.blockers.join('\n')).toContain('could not read the verdict: HTTP 403');
  });
});

describe('movePointers', () => {
  const noSleep = async () => {};

  it('moves latest for each package with the exact npm arguments, retrying a transient failure', async () => {
    const calls = [];
    let failures = 1;
    const npm = (args) => {
      calls.push(args);
      if (args[2] === `@cleocode/core@${NEW}` && failures-- > 0) throw new Error('ETIMEDOUT');
      return '';
    };
    const results = await movePointers(PACKAGES, NEW, { npm, sleepImpl: noSleep });
    expect(results.every((r) => r.ok)).toBe(true);
    expect(calls).toEqual([
      ['dist-tag', 'add', `@cleocode/contracts@${NEW}`, 'latest'],
      ['dist-tag', 'add', `@cleocode/core@${NEW}`, 'latest'],
      ['dist-tag', 'add', `@cleocode/core@${NEW}`, 'latest'],
      ['dist-tag', 'add', `@cleocode/cleo@${NEW}`, 'latest'],
    ]);
  });

  it('records a persistent failure and still moves the rest', async () => {
    const npm = (args) => {
      if (args[2].startsWith('@cleocode/core@'))
        throw Object.assign(new Error('fail'), { stderr: 'npm error code E403' });
      return '';
    };
    const results = await movePointers(PACKAGES, NEW, { npm, sleepImpl: noSleep });
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(results[1].detail).toContain('E403');
  });
});

describe('waitForLatest', () => {
  it('waits until latest resolves for every package', async () => {
    const tags = soaking();
    const { fetchImpl } = fakeRegistry({ tags });
    let polls = 0;
    const sleepImpl = async () => {
      polls++;
      for (const p of PACKAGES) tags[p].latest = NEW;
    };
    const results = await waitForLatest(PACKAGES, NEW, { fetchImpl, sleepImpl });
    expect(polls).toBe(1);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('gives up at the deadline and names what did not converge', async () => {
    const { fetchImpl } = fakeRegistry({ tags: soaking() });
    let t = 0;
    const results = await waitForLatest(PACKAGES, NEW, {
      fetchImpl,
      timeoutMs: 1000,
      intervalMs: 400,
      now: () => t,
      sleepImpl: async (ms) => {
        t += ms;
      },
    });
    expect(results.some((r) => r.ok)).toBe(false);
    expect(results[0].detail).toContain('dist-tag');
  });
});

describe('main', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_STEP_SUMMARY', '');
    vi.stubEnv('GITHUB_OUTPUT', '');
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /**
   * Run main against the fakes, with an npm that moves the fake registry's tags.
   *
   * @param {string[]} argv
   * @param {object} [opts]
   */
  async function runMain(argv, { tags = soaking(), gh = fakeGh().gh, whoamiFails = false } = {}) {
    const { fetchImpl } = fakeRegistry({ tags });
    const npmCalls = [];
    const npm = (args) => {
      npmCalls.push(args);
      if (args[0] === 'whoami') {
        if (whoamiFails) throw new Error('E401');
        return 'cleocode-bot';
      }
      const [, , spec, tag] = args;
      const [, pkg, version] = /^@cleocode\/(.+)@(.+)$/.exec(spec) ?? [];
      tags[pkg][tag] = version;
      return '';
    };
    const code = await main(argv, {
      fetchImpl,
      gh,
      npm,
      sleepImpl: async () => {},
      readPackages: async () => PACKAGES,
    });
    return { code, npmCalls, tags };
  }

  it('promotes: checks the token, moves in publish order with cleo last, and converges', async () => {
    const { code, npmCalls, tags } = await runMain(['promote', '--version', NEW]);
    expect(code).toBe(0);
    expect(npmCalls[0]).toEqual(['whoami']);
    expect(npmCalls.slice(1).map((c) => c[2])).toEqual(
      PACKAGES.map((p) => `@cleocode/${p}@${NEW}`),
    );
    expect(Object.values(tags).every((t) => t.latest === NEW)).toBe(true);
  });

  it('rolls back with the same command and the previous version', async () => {
    const tags = Object.fromEntries(PACKAGES.map((p) => [p, { canary: NEW, latest: NEW }]));
    const { gh } = fakeGh({
      tagRuns: [
        {
          databaseId: 6,
          headBranch: `v${OLD}`,
          displayTitle: 'x',
          status: 'completed',
          conclusion: 'success',
          createdAt: '2026-10-04T09:00:00Z',
        },
      ],
    });
    const { code } = await runMain(['promote', '--version', OLD], { tags, gh });
    expect(code).toBe(0);
    expect(Object.values(tags).every((t) => t.latest === OLD)).toBe(true);
  });

  it('moves nothing when the plan is blocked', async () => {
    const { gh } = fakeGh({ jobs: [{ status: 'completed', conclusion: 'failure' }] });
    const { code, npmCalls } = await runMain(['promote', '--version', NEW], { gh });
    expect(code).toBe(1);
    expect(npmCalls).toEqual([]);
  });

  it('never calls npm for a plan', async () => {
    const { code, npmCalls } = await runMain(['plan', '--version', NEW]);
    expect(code).toBe(0);
    expect(npmCalls).toEqual([]);
  });

  it('moves nothing when npm rejects the token', async () => {
    const { code, npmCalls, tags } = await runMain(['promote', '--version', NEW], {
      whoamiFails: true,
    });
    expect(code).toBe(1);
    expect(npmCalls).toEqual([['whoami']]);
    expect(Object.values(tags).every((t) => t.latest === OLD)).toBe(true);
  });

  it('refuses an empty package list', async () => {
    const code = await main(['plan', '--version', NEW], { readPackages: async () => [] });
    expect(code).toBe(2);
  });
});

describe('workflow guards (owner conditions)', () => {
  const workflowFiles = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));
  const promoteText = readFileSync(path.join(WORKFLOWS, 'release-promote.yml'), 'utf8');
  const promote = parseYaml(promoteText);

  it('release-promote.yml runs only on workflow_dispatch', () => {
    expect(Object.keys(promote.on)).toEqual(['workflow_dispatch']);
  });

  it('only the promote job uses the npm-promote environment, and only after plan', () => {
    const withEnv = Object.entries(promote.jobs).filter(([, job]) => job.environment);
    expect(withEnv.map(([id]) => id)).toEqual(['promote']);
    expect(promote.jobs.promote.environment.name).toBe('npm-promote');
    expect(promote.jobs.promote.needs).toEqual(['plan']);
  });

  it('NPM_TOKEN appears only in the promote job', () => {
    const jobsWithToken = Object.entries(promote.jobs)
      .filter(([, job]) => JSON.stringify(job).includes('secrets.NPM_TOKEN'))
      .map(([id]) => id);
    expect(jobsWithToken).toEqual(['promote']);
  });

  it('no other workflow references the npm-promote environment or NPM_TOKEN', () => {
    const offenders = workflowFiles
      .filter((f) => f !== 'release-promote.yml')
      .filter((f) => {
        // Parsed, so comments that explain the absence of a token do not count.
        const code = JSON.stringify(parseYaml(readFileSync(path.join(WORKFLOWS, f), 'utf8')));
        return code.includes('npm-promote') || code.includes('NPM_TOKEN');
      });
    expect(offenders).toEqual([]);
  });

  it('no job or step in release-promote.yml continues on error (gh#1474)', () => {
    const units = Object.values(promote.jobs).flatMap((job) => [job, ...job.steps]);
    expect(units.filter((u) => 'continue-on-error' in u)).toEqual([]);
  });

  it('the version input reaches shell steps only through env', () => {
    const runs = Object.values(promote.jobs).flatMap((job) =>
      job.steps.filter((s) => typeof s.run === 'string').map((s) => s.run),
    );
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) expect(run).not.toMatch(/\$\{\{/);
  });

  it('release.yml publishes a stable version under canary', () => {
    const release = parseYaml(readFileSync(path.join(WORKFLOWS, 'release.yml'), 'utf8'));
    const step = release.jobs['build-verify'].steps.find((s) => s.id === 'version');
    const dir = mkdtempSync(path.join(tmpdir(), 'release-version-step-'));
    try {
      const tagFor = (version) => {
        const out = path.join(dir, `${version}.out`);
        execFileSync('bash', ['-eo', 'pipefail', '-c', step.run], {
          env: { PATH: process.env.PATH, INPUT_VERSION: version, GITHUB_OUTPUT: out },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        return /^dist_tag=(.*)$/m.exec(readFileSync(out, 'utf8'))?.[1];
      };
      expect(tagFor(NEW)).toBe('canary');
      expect(tagFor(`${NEW}-beta.1`)).toBe('beta');
      expect(tagFor(`${NEW}-alpha.1`)).toBe('dev');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('release.yml names each run after its version, which readVerdict matches', () => {
    const release = parseYaml(readFileSync(path.join(WORKFLOWS, 'release.yml'), 'utf8'));
    expect(release['run-name']).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, compared literally
      "Release ${{ github.event_name == 'workflow_dispatch' && format('v{0}', inputs.version) || github.ref_name }}",
    );
  });
});
