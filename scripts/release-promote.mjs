#!/usr/bin/env node
/**
 * release-promote.mjs — move npm `latest` to a soaked canary, or back to a previous version (T13144).
 *
 * ## Blue/green by dist-tag
 *
 * release.yml publishes every stable version under `canary`. Users install
 * `latest`, so a new version reaches nobody until this script moves `latest`
 * to it. A rollback is the same move pointed at the previous version: the old
 * tarballs never left the registry, so `latest` flips back in seconds and
 * nothing is republished.
 *
 * Every @cleocode package pins its @cleocode dependencies to its own exact
 * version, so each package's `latest` can move on its own and a consumer still
 * never resolves a mixed set: `@cleocode/cleo@X` always installs
 * `@cleocode/core@X`. Packages move in publish order (release.yml
 * `publish_pkg`), so `@cleocode/cleo`, the package users type, moves last.
 *
 * ## Two commands, two jobs
 *
 *   plan     Read-only. release-promote.yml runs it in the `plan` job, before
 *            the owner's approval, so the reviewer approves a plan they can read.
 *   promote  Re-runs every plan check (the approval may come hours later), runs
 *            `npm dist-tag add @cleocode/<pkg>@<version> latest` for each
 *            package not already there, then waits until `latest` resolves to
 *            the version for every package. Runs in the `npm-promote`
 *            environment, the only place NPM_TOKEN exists. npm's trusted
 *            publishing (OIDC) covers `npm publish` only, so moving a dist-tag
 *            needs a token.
 *
 * ## What the plan requires
 *
 *   - The version is a stable CalVer version.
 *   - Every package resolves at that version: the per-version metadata and the
 *     tarball an install downloads (execute-payload.mjs `checkPackage`).
 *   - The release's installability verdict is green. When a tracking issue
 *     exists for the version, its newest recorded observation is `installable`
 *     (release-installability-watch.mjs). With no tracking issue, the newest
 *     release.yml run for the version has a successful `Release Verdict` job.
 *   - Promotion (the version is newer than the current `latest`): every
 *     package's `canary` is the version. The canary that was soaked is the one
 *     promoted; an older canary superseded before promotion is not.
 *   - Rollback (the version is older than the current `latest`): no canary
 *     requirement.
 *
 * Exit codes: 0 done, or nothing to do; 1 a requirement failed, a move failed
 * or `latest` did not converge; 2 bad arguments or no package list.
 *
 * @task T13144
 * @epic T13139
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { checkPackage, REGISTRY, readPublishedPackages } from './execute-payload.mjs';
import { isMain } from './lib/is-main.mjs';
import { compareVersions, parseState } from './release-installability-watch.mjs';

/** Only stable CalVer versions are promoted; prereleases keep their own tags. */
export const STABLE_VERSION = /^\d{4}\.\d{1,2}\.\d+$/;

/** The release.yml job that renders the installability verdict. */
export const VERDICT_JOB = 'Release Verdict';

/** Label on the installability tracking issues release-verdict.mjs opens. */
export const TRACKING_LABEL = 'release-installability';

/** Only issues the workflow bot opened carry a verdict; anyone can open an issue. */
const TRUSTED_AUTHOR = /^(app\/)?github-actions(\[bot\])?$/;

/** How long to wait for `latest` to resolve after the moves. */
export const CONVERGE_TIMEOUT_MS = 10 * 60_000;

/** Poll interval while waiting for `latest`. */
export const CONVERGE_INTERVAL_MS = 15_000;

/** Attempts per `npm dist-tag add`. */
export const MOVE_ATTEMPTS = 3;

/**
 * @typedef {object} Verdict
 * @property {boolean} green
 * @property {string} source - Where the verdict was read.
 * @property {string} detail
 */

/**
 * @typedef {object} PlanRow
 * @property {string} pkg - Short package name.
 * @property {boolean} resolves - Metadata and tarball resolve at the version.
 * @property {string} [detail] - Why it does not resolve.
 * @property {string | null} canary - Current `canary`, null when absent or unreadable.
 * @property {string | null} latest - Current `latest`, null when absent or unreadable.
 * @property {string} [tagsError] - Why the dist-tags could not be read.
 */

/**
 * @typedef {object} Plan
 * @property {string} version
 * @property {'promote' | 'rollback' | 'noop' | 'unknown'} mode
 * @property {PlanRow[]} rows - In publish order.
 * @property {Verdict} verdict
 * @property {string[]} moves - Packages whose `latest` must move, in publish order.
 * @property {string[]} blockers - Every failed requirement.
 * @property {boolean} ok
 */

/**
 * Parse command-line arguments.
 *
 * @param {string[]} argv
 * @returns {{ command?: 'plan' | 'promote', version?: string, error?: string }}
 */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== 'plan' && command !== 'promote')
    return { error: 'usage: release-promote.mjs <plan|promote> --version <YYYY.M.PATCH>' };
  /** @type {string | undefined} */
  let version;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--version') version = String(rest[++i] ?? '').replace(/^v/, '');
    else return { command, error: `unknown argument: ${rest[i]}` };
  }
  if (!version) return { command, error: '--version is required' };
  if (!STABLE_VERSION.test(version))
    return { command, version, error: `not a stable CalVer version: ${version}` };
  return { command, version };
}

/**
 * Read a package's dist-tags from the registry's dedicated endpoint.
 *
 * @param {string} pkg - Short package name.
 * @param {typeof fetch} [fetchImpl] - Injected for tests.
 * @returns {Promise<Record<string, string>>} Throws when the tags cannot be read.
 */
export async function readTags(pkg, fetchImpl = fetch) {
  const res = await fetchImpl(
    `${REGISTRY}/-/package/@cleocode%2f${encodeURIComponent(pkg)}/dist-tags`,
    { headers: { accept: 'application/json' } },
  );
  if (!res.ok) throw new Error(`dist-tags HTTP ${res.status}`);
  const tags = await res.json();
  if (!tags || typeof tags !== 'object' || Array.isArray(tags))
    throw new Error('dist-tags body is not an object');
  return tags;
}

/**
 * Decide whether moving `latest` to `version` is a promotion, a rollback or
 * nothing at all.
 *
 * Compared with the NEWEST current `latest` across packages, so a re-run after
 * a partial move keeps its mode: half-promoted packages still sit below the
 * version, half-rolled-back ones still sit above it.
 *
 * @param {string} version
 * @param {Array<string | null>} latest - Each package's current `latest`; null when absent.
 * @returns {'promote' | 'rollback' | 'noop'}
 */
export function decideMode(version, latest) {
  if (latest.length > 0 && latest.every((v) => v === version)) return 'noop';
  const known = latest.filter((v) => typeof v === 'string');
  if (known.length === 0) return 'promote';
  const newest = known.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
  return compareVersions(version, newest) >= 0 ? 'promote' : 'rollback';
}

/**
 * Decide the installability verdict from what the release left behind.
 *
 * @param {object} input
 * @param {string} input.version
 * @param {Array<{ number: number, body: string }>} input.trackers - Trusted tracking
 *   issues whose machine state names exactly this version.
 * @param {{ databaseId: number, status: string, conclusion: string | null } | null} [input.run] -
 *   The newest release.yml run for the version.
 * @param {{ status: string, conclusion: string | null } | null} [input.verdictJob] - That
 *   run's `Release Verdict` job.
 * @returns {Verdict}
 */
export function evaluateVerdict({ version, trackers, run = null, verdictJob = null }) {
  if (trackers.length > 0) {
    // A tracking issue exists only when the release run could not prove
    // installability in its budget, and the watcher keeps observing until it
    // can. Its newest observation outranks the run's red.
    const issue = [...trackers].sort((a, b) => b.number - a.number)[0];
    const observation = parseState(issue.body)?.lastObservation;
    const source = `tracking issue #${issue.number}`;
    if (observation?.outcome === 'installable' && observation.coverage === 'current')
      return {
        green: true,
        source,
        detail: `watcher observed every package installable at ${observation.observedAt}`,
      };
    return {
      green: false,
      source,
      detail: `latest watcher observation is ${observation?.outcome ?? 'absent'}${observation?.coverage ? ` (coverage ${observation.coverage})` : ''}`,
    };
  }
  if (!run)
    return {
      green: false,
      source: 'release.yml',
      detail: `no release.yml run found for v${version}`,
    };
  const source = `release.yml run ${run.databaseId}`;
  if (run.status !== 'completed')
    return { green: false, source, detail: `the release run is still ${run.status}` };
  if (!verdictJob)
    return { green: false, source, detail: `the release run has no "${VERDICT_JOB}" job` };
  if (verdictJob.conclusion === 'success')
    return { green: true, source, detail: `"${VERDICT_JOB}" concluded success` };
  return {
    green: false,
    source,
    detail: `"${VERDICT_JOB}" concluded ${verdictJob.conclusion ?? verdictJob.status}`,
  };
}

/**
 * Run `gh` and return its stdout.
 *
 * @param {string[]} args
 * @returns {string}
 */
function runGh(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Read the installability verdict for a version from GitHub.
 *
 * @param {string} version
 * @param {(args: string[]) => string} [gh] - Returns stdout; injected for tests.
 * @returns {Verdict}
 */
export function readVerdict(version, gh = runGh) {
  /** @type {Array<{ number: number, body?: string, author?: { login?: string, is_bot?: boolean } }>} */
  const issues = JSON.parse(
    gh([
      'issue',
      'list',
      '--label',
      TRACKING_LABEL,
      '--state',
      'all',
      '--search',
      `v${version} in:title`,
      '--limit',
      '100',
      '--json',
      'number,body,author',
    ]),
  );
  const trackers = issues
    .filter((i) => i.author?.is_bot === true && TRUSTED_AUTHOR.test(i.author.login ?? '') && i.body)
    .filter((i) => parseState(String(i.body))?.version === version)
    .map((i) => ({ number: i.number, body: String(i.body) }));
  if (trackers.length > 0) return evaluateVerdict({ version, trackers });

  const fields = 'databaseId,headBranch,displayTitle,status,conclusion,createdAt';
  /** @type {Array<{ databaseId: number, headBranch: string, displayTitle: string, status: string, conclusion: string | null, createdAt: string }>} */
  const runs = [
    // A tag push runs on the tag.
    ...JSON.parse(
      gh([
        'run',
        'list',
        '--workflow',
        'release.yml',
        '--branch',
        `v${version}`,
        '--limit',
        '20',
        '--json',
        fields,
      ]),
    ),
    // A break-glass dispatch runs on main; release.yml's run-name carries the version.
    ...JSON.parse(
      gh([
        'run',
        'list',
        '--workflow',
        'release.yml',
        '--event',
        'workflow_dispatch',
        '--limit',
        '100',
        '--json',
        fields,
      ]),
    ),
  ].filter((r) => r.headBranch === `v${version}` || r.displayTitle === `Release v${version}`);
  const run = runs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null;
  /** @type {{ status: string, conclusion: string | null } | null} */
  let verdictJob = null;
  if (run && run.status === 'completed') {
    const lines = gh([
      'api',
      '--paginate',
      `repos/{owner}/{repo}/actions/runs/${run.databaseId}/jobs?per_page=100`,
      '--jq',
      `.jobs[] | select(.name == "${VERDICT_JOB}") | {status, conclusion}`,
    ])
      .split('\n')
      .filter((line) => line.trim());
    verdictJob = lines.length > 0 ? JSON.parse(lines[lines.length - 1]) : null;
  }
  return evaluateVerdict({ version, trackers: [], run, verdictJob });
}

/**
 * Check every requirement and work out which packages must move.
 *
 * @param {object} opts
 * @param {string} opts.version
 * @param {string[]} opts.packages - Short package names, in publish order.
 * @param {typeof fetch} [opts.fetchImpl] - Injected for tests.
 * @param {(args: string[]) => string} [opts.gh] - Injected for tests.
 * @returns {Promise<Plan>}
 */
export async function planPromotion({ version, packages, fetchImpl = fetch, gh = runGh }) {
  /** @type {PlanRow[]} */
  const rows = await Promise.all(
    packages.map(async (pkg) => {
      const [resolution, tags] = await Promise.all([
        checkPackage(pkg, version, fetchImpl),
        readTags(pkg, fetchImpl).catch((error) => ({
          error: error instanceof Error ? error.message : String(error),
        })),
      ]);
      const tagsError = typeof tags.error === 'string' ? tags.error : undefined;
      const tag = (name) =>
        !tagsError && typeof tags[name] === 'string' ? String(tags[name]) : null;
      return {
        pkg,
        resolves: resolution.state === 'ok',
        ...(resolution.state === 'ok'
          ? {}
          : { detail: `${resolution.rung}: ${resolution.detail ?? resolution.state}` }),
        canary: tag('canary'),
        latest: tag('latest'),
        ...(tagsError ? { tagsError } : {}),
      };
    }),
  );

  const blockers = [];
  for (const row of rows) {
    if (!row.resolves)
      blockers.push(`@cleocode/${row.pkg}@${version} does not resolve (${row.detail})`);
    if (row.tagsError)
      blockers.push(`@cleocode/${row.pkg}: dist-tags unreadable (${row.tagsError})`);
  }
  const mode = rows.some((r) => r.tagsError)
    ? 'unknown'
    : decideMode(
        version,
        rows.map((r) => r.latest),
      );
  if (mode === 'promote') {
    for (const row of rows.filter((r) => r.canary !== version))
      blockers.push(
        `@cleocode/${row.pkg}: canary is ${row.canary ?? '(absent)'}, not ${version}. ` +
          'Only the current canary is promoted; an older version is a rollback only when it is older than latest.',
      );
  }

  /** @type {Verdict} */
  let verdict;
  try {
    verdict = readVerdict(version, gh);
  } catch (error) {
    verdict = {
      green: false,
      source: 'GitHub',
      detail: `could not read the verdict: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!verdict.green)
    blockers.push(`installability verdict (${verdict.source}): ${verdict.detail}`);

  return {
    version,
    mode,
    rows,
    verdict,
    moves: rows.filter((r) => r.latest !== version).map((r) => r.pkg),
    blockers,
    ok: blockers.length === 0,
  };
}

/**
 * Render a plan as Markdown for the job summary the reviewer reads.
 *
 * @param {Plan} plan
 * @returns {string}
 */
export function renderPlan(plan) {
  const heading = {
    promote: `Promote v${plan.version} from canary to latest`,
    rollback: `ROLLBACK: move latest back to v${plan.version}`,
    noop: `latest is already v${plan.version}`,
    unknown: `Move latest to v${plan.version}`,
  }[plan.mode];
  const rows = plan.rows.map(
    (r) =>
      `| @cleocode/${r.pkg} | ${r.resolves ? 'yes' : `**no** (${r.detail})`} | ${r.canary ?? '—'} | ${r.latest ?? '—'} | ${plan.moves.includes(r.pkg) ? `move to ${plan.version}` : 'already there'} |`,
  );
  return [
    `## ${heading}`,
    '',
    `Installability verdict: ${plan.verdict.green ? 'green' : '**not green**'} (${plan.verdict.source}: ${plan.verdict.detail})`,
    '',
    '| package | resolves | canary | latest now | action |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    plan.ok
      ? `Plan ok: ${plan.moves.length} package(s) to move.`
      : `**Blocked** (${plan.blockers.length}):\n\n${plan.blockers.map((b) => `- ${b}`).join('\n')}`,
    '',
  ].join('\n');
}

/**
 * Run `npm` and return its stdout. The token reaches npm only through the
 * `.npmrc` setup-node writes, which reads NODE_AUTH_TOKEN; it is never an
 * argument and never printed.
 *
 * @param {string[]} args
 * @returns {string}
 */
function runNpm(args) {
  return execFileSync('npm', args, {
    encoding: 'utf8',
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Point `latest` at `version` for each package, in order, retrying transient
 * failures. Keeps going after a failure: the exact pins keep a mixed state
 * coherent, and a re-run skips what already moved.
 *
 * @param {string[]} packages - In publish order.
 * @param {string} version
 * @param {object} [opts]
 * @param {(args: string[]) => string} [opts.npm] - Injected for tests.
 * @param {(ms: number) => Promise<unknown>} [opts.sleepImpl] - Injected for tests.
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<Array<{ pkg: string, ok: boolean, detail: string }>>}
 */
export async function movePointers(packages, version, opts = {}) {
  const { npm = runNpm, sleepImpl = sleep, log = () => {} } = opts;
  const results = [];
  for (const pkg of packages) {
    let detail = '';
    let ok = false;
    for (let attempt = 1; attempt <= MOVE_ATTEMPTS && !ok; attempt++) {
      try {
        npm(['dist-tag', 'add', `@cleocode/${pkg}@${version}`, 'latest']);
        ok = true;
        detail = `latest -> ${version}`;
      } catch (error) {
        const stderr =
          error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
        detail = `attempt ${attempt}: ${(stderr || (error instanceof Error ? error.message : String(error))).trim().slice(-300)}`;
        if (attempt < MOVE_ATTEMPTS) await sleepImpl(attempt * 5_000);
      }
    }
    log(`${ok ? 'moved ' : 'FAILED'} @cleocode/${pkg}: ${detail}`);
    results.push({ pkg, ok, detail });
  }
  return results;
}

/**
 * Wait until `latest` resolves to `version` for every package: metadata,
 * tarball and the dist-tag itself (execute-payload.mjs `checkPackage`).
 *
 * @param {string[]} packages
 * @param {string} version
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.intervalMs]
 * @param {(ms: number) => Promise<unknown>} [opts.sleepImpl]
 * @param {() => number} [opts.now]
 * @returns {Promise<Array<{ pkg: string, ok: boolean, detail: string }>>}
 */
export async function waitForLatest(packages, version, opts = {}) {
  const {
    fetchImpl = fetch,
    timeoutMs = CONVERGE_TIMEOUT_MS,
    intervalMs = CONVERGE_INTERVAL_MS,
    sleepImpl = sleep,
    now = Date.now,
  } = opts;
  const deadline = now() + timeoutMs;
  /** @type {Map<string, { pkg: string, ok: boolean, detail: string }>} */
  const state = new Map(packages.map((pkg) => [pkg, { pkg, ok: false, detail: 'not checked' }]));
  for (;;) {
    const pending = [...state.values()].filter((r) => !r.ok).map((r) => r.pkg);
    const checked = await Promise.all(
      pending.map(async (pkg) => [pkg, await checkPackage(pkg, version, fetchImpl, 'latest')]),
    );
    for (const [pkg, r] of checked)
      state.set(pkg, {
        pkg,
        ok: r.state === 'ok',
        detail: r.state === 'ok' ? `latest resolves to ${version}` : `${r.rung}: ${r.detail}`,
      });
    if ([...state.values()].every((r) => r.ok) || now() >= deadline) break;
    await sleepImpl(intervalMs);
  }
  return packages.map(
    (pkg) => /** @type {{ pkg: string, ok: boolean, detail: string }} */ (state.get(pkg)),
  );
}

/**
 * Append Markdown to the job summary, or to stderr outside Actions.
 *
 * @param {string} text
 */
function summary(text) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${text}\n`);
  else process.stderr.write(`${text}\n`);
}

/**
 * Run a command from the command line.
 *
 * @param {string[]} [argv]
 * @param {object} [deps] - Injected for tests.
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {(args: string[]) => string} [deps.gh]
 * @param {(args: string[]) => string} [deps.npm]
 * @param {(ms: number) => Promise<unknown>} [deps.sleepImpl]
 * @param {() => Promise<string[]>} [deps.readPackages]
 * @returns {Promise<number>} Process exit code.
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const {
    fetchImpl = fetch,
    gh = runGh,
    npm = runNpm,
    sleepImpl = sleep,
    readPackages = readPublishedPackages,
  } = deps;
  const args = parseArgs(argv);
  if (args.error || !args.version) {
    process.stderr.write(`release-promote: ${args.error}\n`);
    return 2;
  }
  const version = args.version;
  const packages = await readPackages();
  // Fail closed: an empty list would move nothing and report success.
  if (packages.length === 0) {
    process.stderr.write('release-promote: the publish_pkg list in release.yml is empty\n');
    return 2;
  }

  const plan = await planPromotion({ version, packages, fetchImpl, gh });
  summary(renderPlan(plan));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `mode=${plan.mode}\n`);
  process.stdout.write(`${JSON.stringify(plan)}\n`);
  if (!plan.ok) return 1;
  if (args.command === 'plan') return 0;

  /** @type {Array<{ pkg: string, ok: boolean, detail: string }>} */
  let moved = [];
  if (plan.moves.length > 0) {
    try {
      npm(['whoami']);
    } catch {
      summary(
        '**npm rejected the token.** NPM_TOKEN in the `npm-promote` environment is missing, expired or lacks write access to @cleocode. Nothing moved.',
      );
      return 1;
    }
    moved = await movePointers(plan.moves, version, {
      npm,
      sleepImpl,
      log: (line) => process.stderr.write(`${line}\n`),
    });
  }
  const converged = await waitForLatest(packages, version, { fetchImpl, sleepImpl });
  const failedMoves = moved.filter((m) => !m.ok);
  const notConverged = converged.filter((c) => !c.ok);
  summary(
    [
      `### ${failedMoves.length === 0 && notConverged.length === 0 ? `latest is v${version}` : `latest is NOT fully v${version}`}`,
      '',
      ...moved.map((m) => `- move @cleocode/${m.pkg}: ${m.ok ? 'ok' : `**failed** (${m.detail})`}`),
      ...notConverged.map((c) => `- @cleocode/${c.pkg}: latest does not resolve yet (${c.detail})`),
      failedMoves.length > 0 || notConverged.length > 0
        ? '\nRe-run this workflow with the same version: packages already moved are skipped.'
        : '',
    ].join('\n'),
  );
  process.stdout.write(`${JSON.stringify({ version, moved, converged })}\n`);
  return failedMoves.length === 0 && notConverged.length === 0 ? 0 : 1;
}

if (isMain(import.meta.url)) process.exit(await main());
