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
 *   - The release's installability verdict is green, read only from what the
 *     release run on the tag produced: its job conclusions and its own
 *     `postdeploy-<version>` artifact, which nobody can edit after the run.
 *     The newest release.yml run on `v<version>` (the tag push, a re-run of it,
 *     or a dispatch on the tag ref) must have a successful `Release Verdict`
 *     job, or a successful `Publish` job and a deploy summary whose verdict was
 *     `pending` at its deadline (published, no package serving a wrong
 *     version); the live resolution check above then decides. A run on any
 *     other ref never counts, and the installability tracking issue is not
 *     read: its body is editable (T13144 review).
 *   - Promotion (the version is newer than the current `latest`): every
 *     package's `canary` is the version. The canary that was soaked is the one
 *     promoted; an older canary superseded before promotion is not. A promotion
 *     already under way (some package's `latest` is the version) finishes
 *     without that check, so a newer canary cannot strand it half-moved.
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
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { checkPackage, REGISTRY, readPublishedPackages } from './execute-payload.mjs';
import { isMain } from './lib/is-main.mjs';
import { compareVersions } from './release-installability-watch.mjs';

/** Only stable CalVer versions are promoted; prereleases keep their own tags. */
export const STABLE_VERSION = /^\d{4}\.\d{1,2}\.\d+$/;

/** The release.yml job that renders the installability verdict. */
export const VERDICT_JOB = 'Release Verdict';

/** The release.yml job that publishes every package. */
export const PUBLISH_JOB = 'Publish';

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
 * @typedef {object} ReleaseRun
 * @property {number} databaseId
 * @property {string} headBranch - The ref the run ran on; a tag push runs on the tag.
 * @property {string} status
 * @property {string | null} conclusion
 * @property {string} createdAt
 */

/**
 * Decide the installability verdict from what the release run on the tag
 * produced.
 *
 * @param {object} input
 * @param {string} input.version
 * @param {ReleaseRun | null} input.run - The newest release.yml run on `v<version>`.
 * @param {Record<string, { status: string, conclusion: string | null }>} [input.jobs] -
 *   That run's jobs by name (latest attempt).
 * @param {{ verdict?: unknown } | null} [input.summary] - Its deploy summary, read from
 *   the run's `postdeploy-<version>` artifact; null when unread or unreadable.
 * @returns {Verdict}
 */
export function evaluateVerdict({ version, run, jobs = {}, summary = null }) {
  const tag = `v${version}`;
  if (!run || run.headBranch !== tag)
    return { green: false, source: 'release.yml', detail: `no release.yml run on the tag ${tag}` };
  const source = `release.yml run ${run.databaseId}`;
  if (run.status !== 'completed')
    return { green: false, source, detail: `the release run is still ${run.status}` };
  const verdictJob = jobs[VERDICT_JOB];
  if (!verdictJob)
    return { green: false, source, detail: `the release run has no "${VERDICT_JOB}" job` };
  if (verdictJob.conclusion === 'success')
    return { green: true, source, detail: `"${VERDICT_JOB}" concluded success` };
  const red = `"${VERDICT_JOB}" concluded ${verdictJob.conclusion ?? verdictJob.status}`;
  const publish = jobs[PUBLISH_JOB];
  if (publish?.conclusion !== 'success')
    return {
      green: false,
      source,
      detail: `${red}, and "${PUBLISH_JOB}" concluded ${publish?.conclusion ?? 'nothing'}`,
    };
  // A red verdict over a successful publish is usually `pending`: published and
  // accepted, not yet resolvable inside the run's budget. That never becomes a
  // defect by waiting, and the live check of every package decides now. A
  // `defect` (a package served a wrong version) or an unreadable summary stays red.
  if (summary?.verdict === 'pending')
    return {
      green: true,
      source,
      detail: `${red} with a pending deploy summary (published, no wrong version); the live resolution check decides`,
    };
  return {
    green: false,
    source,
    detail: summary
      ? `${red}; its deploy summary verdict is ${String(summary.verdict)}`
      : `${red}, and its deploy summary (artifact postdeploy-${version}) could not be read`,
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
 * Download a release run's deploy summary from its own artifact.
 *
 * @param {number} runId
 * @param {string} version
 * @param {(args: string[]) => string} [gh]
 * @returns {{ verdict?: unknown } | null} Null when the artifact is missing, expired or unparseable.
 */
export function readDeploySummary(runId, version, gh = runGh) {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-promote-'));
  try {
    gh(['run', 'download', String(runId), '-n', `postdeploy-${version}`, '-D', dir]);
    const summary = JSON.parse(
      readFileSync(path.join(dir, `deploy-summary-${version}.json`), 'utf8'),
    );
    return summary && typeof summary === 'object' && !Array.isArray(summary) ? summary : null;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Read the installability verdict for a version from its release run on the tag.
 *
 * @param {string} version
 * @param {(args: string[]) => string} [gh] - Returns stdout; injected for tests.
 * @param {typeof readDeploySummary} [readSummary] - Injected for tests.
 * @returns {Verdict}
 */
export function readVerdict(version, gh = runGh, readSummary = readDeploySummary) {
  const tag = `v${version}`;
  /** @type {ReleaseRun[]} */
  const runs = JSON.parse(
    gh([
      'run',
      'list',
      '--workflow',
      'release.yml',
      '--branch',
      tag,
      '--limit',
      '20',
      '--json',
      'databaseId,headBranch,status,conclusion,createdAt',
    ]),
  );
  // Only a run on the tag itself: a dispatch from any other ref runs that ref's
  // workflow file, which anyone with write access can edit (T13144 review).
  const run =
    runs
      .filter((r) => r.headBranch === tag)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null;
  if (!run || run.status !== 'completed') return evaluateVerdict({ version, run });
  /** @type {Record<string, { status: string, conclusion: string | null }>} */
  const jobs = {};
  for (const line of gh([
    'api',
    '--paginate',
    `repos/{owner}/{repo}/actions/runs/${run.databaseId}/jobs?per_page=100`,
    '--jq',
    `.jobs[] | select(.name == "${VERDICT_JOB}" or .name == "${PUBLISH_JOB}") | {name, status, conclusion}`,
  ])
    .split('\n')
    .filter((l) => l.trim())) {
    const job = JSON.parse(line);
    jobs[job.name] = { status: job.status, conclusion: job.conclusion };
  }
  const needsSummary =
    jobs[VERDICT_JOB] &&
    jobs[VERDICT_JOB].conclusion !== 'success' &&
    jobs[PUBLISH_JOB]?.conclusion === 'success';
  const summary = needsSummary ? readSummary(run.databaseId, version, gh) : null;
  return evaluateVerdict({ version, run, jobs, summary });
}

/**
 * Check every requirement and work out which packages must move.
 *
 * @param {object} opts
 * @param {string} opts.version
 * @param {string[]} opts.packages - Short package names, in publish order.
 * @param {typeof fetch} [opts.fetchImpl] - Injected for tests.
 * @param {(args: string[]) => string} [opts.gh] - Injected for tests.
 * @param {typeof readDeploySummary} [opts.readSummary] - Injected for tests.
 * @returns {Promise<Plan>}
 */
export async function planPromotion({
  version,
  packages,
  fetchImpl = fetch,
  gh = runGh,
  readSummary = readDeploySummary,
}) {
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
  // A promotion already under way finishes without the canary check: the
  // version was approved once, and a newer canary must not strand it half-moved.
  const underWay = rows.some((r) => r.latest === version);
  if (mode === 'promote' && !underWay) {
    for (const row of rows.filter((r) => r.canary !== version))
      blockers.push(
        `@cleocode/${row.pkg}: canary is ${row.canary ?? '(absent)'}, not ${version}. ` +
          'Only the current canary is promoted; an older version is a rollback only when it is older than latest.',
      );
  }

  /** @type {Verdict} */
  let verdict;
  try {
    verdict = readVerdict(version, gh, readSummary);
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
 * @param {typeof readDeploySummary} [deps.readSummary]
 * @returns {Promise<number>} Process exit code.
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const {
    fetchImpl = fetch,
    gh = runGh,
    npm = runNpm,
    sleepImpl = sleep,
    readPackages = readPublishedPackages,
    readSummary = readDeploySummary,
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

  const plan = await planPromotion({ version, packages, fetchImpl, gh, readSummary });
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
