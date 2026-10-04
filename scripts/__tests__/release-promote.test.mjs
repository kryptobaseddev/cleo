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
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  PUBLISH_JOB,
  parseArgs,
  planPromotion,
  readDeploySummary,
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

/** A release.yml run as `gh run list --json` reports it. */
const runOn = (
  databaseId,
  headBranch,
  createdAt = '2026-10-05T09:00:00Z',
  status = 'completed',
) => ({
  databaseId,
  headBranch,
  status,
  conclusion: 'success',
  createdAt,
});

/**
 * A fake `gh`. `run list` returns `runs` UNFILTERED on purpose: readVerdict
 * must keep only runs on the tag itself.
 *
 * @param {object} [opts]
 * @param {Array<object>} [opts.runs]
 * @param {Record<string, string>} [opts.jobs] - Conclusion by job name, for `api`.
 */
function fakeGh(opts = {}) {
  const {
    runs = [runOn(7, `v${NEW}`), runOn(6, `v${OLD}`, '2026-10-04T09:00:00Z')],
    jobs = { [VERDICT_JOB]: 'success', [PUBLISH_JOB]: 'success' },
  } = opts;
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'run' && args[1] === 'list') return JSON.stringify(runs);
    if (args[0] === 'api')
      return Object.entries(jobs)
        .map(([name, conclusion]) => JSON.stringify({ name, status: 'completed', conclusion }))
        .join('\n');
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { gh, calls };
}

/** A readSummary that must not be called. */
const noSummary = () => {
  throw new Error('the deploy summary was read');
};

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
  const run = runOn(7, `v${NEW}`);
  const jobs = (verdict, publish = 'success') => ({
    [VERDICT_JOB]: { status: 'completed', conclusion: verdict },
    [PUBLISH_JOB]: { status: 'completed', conclusion: publish },
  });

  it('is green when the tag run renders a successful verdict', () => {
    expect(evaluateVerdict({ version: NEW, run, jobs: jobs('success') })).toMatchObject({
      green: true,
      source: 'release.yml run 7',
    });
  });

  it('is not green without a completed run on the tag, or without a verdict job', () => {
    expect(evaluateVerdict({ version: NEW, run: null }).green).toBe(false);
    expect(
      evaluateVerdict({ version: NEW, run: runOn(9, 'main'), jobs: jobs('success') }).green,
    ).toBe(false);
    expect(
      evaluateVerdict({
        version: NEW,
        run: runOn(7, `v${NEW}`, undefined, 'in_progress'),
        jobs: jobs('success'),
      }).green,
    ).toBe(false);
    expect(evaluateVerdict({ version: NEW, run, jobs: {} }).green).toBe(false);
  });

  it('accepts a red verdict over a successful publish only with a pending deploy summary', () => {
    const red = jobs('failure');
    expect(
      evaluateVerdict({ version: NEW, run, jobs: red, summary: { verdict: 'pending' } }).green,
    ).toBe(true);
    expect(
      evaluateVerdict({ version: NEW, run, jobs: red, summary: { verdict: 'defect' } }).green,
    ).toBe(false);
    expect(evaluateVerdict({ version: NEW, run, jobs: red, summary: null }).green).toBe(false);
    expect(
      evaluateVerdict({
        version: NEW,
        run,
        jobs: jobs('failure', 'failure'),
        summary: { verdict: 'pending' },
      }).green,
    ).toBe(false);
  });
});

describe('readVerdict', () => {
  it('ignores a run on any ref but the tag, even a newer green one (review probe)', () => {
    const { gh } = fakeGh({ runs: [runOn(99, 'evil-branch', '2026-10-06T00:00:00Z')] });
    expect(readVerdict(NEW, gh, noSummary)).toMatchObject({ green: false, source: 'release.yml' });
    const both = fakeGh({
      runs: [runOn(99, 'evil-branch', '2026-10-06T00:00:00Z'), runOn(7, `v${NEW}`)],
    });
    expect(readVerdict(NEW, both.gh, noSummary).source).toBe('release.yml run 7');
  });

  it('reads the newest run on the tag and both jobs, paginated', () => {
    const { gh, calls } = fakeGh({
      runs: [runOn(7, `v${NEW}`), runOn(8, `v${NEW}`, '2026-10-05T11:00:00Z')],
    });
    expect(readVerdict(NEW, gh, noSummary).source).toBe('release.yml run 8');
    expect(calls[0]).toEqual(expect.arrayContaining(['--branch', `v${NEW}`]));
    const api = calls.find((c) => c[0] === 'api');
    expect(api).toContain('--paginate');
    expect(api?.find((a) => a.includes('/actions/runs/8/jobs'))).toContain('per_page=100');
    const jq = api?.find((a) => a.includes(VERDICT_JOB));
    expect(jq).toContain(PUBLISH_JOB);
  });

  it('reads the deploy summary only for a red verdict over a successful publish', () => {
    const asked = [];
    const readSummary = (id, version) => {
      asked.push([id, version]);
      return { verdict: 'pending' };
    };
    const red = fakeGh({ jobs: { [VERDICT_JOB]: 'failure', [PUBLISH_JOB]: 'success' } });
    expect(readVerdict(NEW, red.gh, readSummary).green).toBe(true);
    expect(asked).toEqual([[7, NEW]]);
    const failedPublish = fakeGh({ jobs: { [VERDICT_JOB]: 'failure', [PUBLISH_JOB]: 'failure' } });
    expect(readVerdict(NEW, failedPublish.gh, noSummary).green).toBe(false);
  });
});

describe('readDeploySummary', () => {
  it("reads the run's own postdeploy artifact, and is null when it cannot", () => {
    const gh = (args) => {
      expect(args.slice(0, 5)).toEqual(['run', 'download', '7', '-n', `postdeploy-${NEW}`]);
      const dir = args[args.indexOf('-D') + 1];
      writeFileSync(path.join(dir, `deploy-summary-${NEW}.json`), '{"verdict":"pending"}');
      return '';
    };
    expect(readDeploySummary(7, NEW, gh)).toEqual({ verdict: 'pending' });
    expect(
      readDeploySummary(7, NEW, () => {
        throw new Error('no artifact');
      }),
    ).toBeNull();
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

  it('finishes a promotion already under way even after a newer canary arrived', async () => {
    const tags = Object.fromEntries(
      PACKAGES.map((p) => [p, { canary: '2026.10.6', latest: p === 'contracts' ? NEW : OLD }]),
    );
    const { fetchImpl } = fakeRegistry({ tags });
    const plan = await planPromotion({
      version: NEW,
      packages: PACKAGES,
      fetchImpl,
      gh: fakeGh().gh,
    });
    expect(plan.blockers).toEqual([]);
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
    const { gh } = fakeGh();
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
      readSummary: noSummary,
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
    const { code } = await runMain(['promote', '--version', OLD], { tags });
    expect(code).toBe(0);
    expect(Object.values(tags).every((t) => t.latest === OLD)).toBe(true);
  });

  it('moves nothing when the plan is blocked', async () => {
    const { gh } = fakeGh({ jobs: { [VERDICT_JOB]: 'failure', [PUBLISH_JOB]: 'failure' } });
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
});
