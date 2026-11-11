#!/usr/bin/env node
/**
 * ci-phantom-cancel-watchdog.mjs — auto-recovery for phantom CI cancels (T12103).
 *
 * Observed failure mode: hosted runners cancel a job AFTER every step
 * (including "Complete job") reports success. The PR check rollup reads the
 * job conclusion `cancelled` as a failure and blocks the merge; each
 * occurrence costs a manual re-run. Logs show "Cleaning up orphan processes /
 * Terminate orphan process" right before cancellation — a runner-fleet issue
 * we cannot fix, but we CAN eliminate the manual-recovery cost.
 *
 * Detection signature (phantom cancel):
 *   - run conclusion is `cancelled`, AND
 *   - for at least one job: job conclusion is `cancelled` while EVERY step
 *     conclusion is `success` (post-job cleanup steps — names starting with
 *     "Post " or "Complete job" — are exempt from the all-success rule).
 * A job with a genuinely failed/cancelled mid-run step is NOT a phantom and
 * is left alone.
 *
 * Rerun guard (T14488): a run is only re-run if it is NOT superseded and is
 * no older than 7 days. A run is superseded when
 *   - a newer run exists for its exact (workflow, branch, sha) tuple (a newer
 *     attempt of the same commit), OR
 *   - a newer run of the same workflow on the same branch carries a DIFFERENT
 *     headSha (the branch/PR has moved on), OR
 *   - its headSha is no longer the head commit of its branch/PR, resolved with
 *     one cached `gh api .../commits/<branch>` call per distinct branch.
 *
 * Why the extra checks: all runs of a workflow share the concurrency group
 * `<workflow>-<ref>[-<sha>]`. Re-running a stale head re-enters that group and
 * GitHub CANCELS the PR's current-head run to make room (observed
 * 2026-11-11 on #2788: re-running 42932816902 at 6b26c850d cancelled
 * 42941492356 at 07f926e8c), leaving the PR with no run for its real head.
 *
 * Usage:
 *   node scripts/ci-phantom-cancel-watchdog.mjs             # execute reruns
 *   node scripts/ci-phantom-cancel-watchdog.mjs --dry-run   # print only
 *   node scripts/ci-phantom-cancel-watchdog.mjs --json      # machine output
 *   node scripts/ci-phantom-cancel-watchdog.mjs --limit 50  # scan 50 runs
 *
 * Exit codes: 0 always (automation, not a gate); 1 on API/usage errors.
 *
 * @task T12103
 * @task T14488
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Types (JSDoc — this is a plain .mjs script, no tsconfig)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} GhRun
 * @property {number} databaseId
 * @property {string} workflowName
 * @property {number} workflowDatabaseId
 * @property {string} headBranch
 * @property {string} headSha
 * @property {string} conclusion
 * @property {string} createdAt
 * @property {number} number
 * @property {string} url
 */

/**
 * @typedef {object} GhStep
 * @property {string} name
 * @property {string | null} conclusion
 */

/**
 * @typedef {object} GhJob
 * @property {number} databaseId
 * @property {string} name
 * @property {string} conclusion
 * @property {GhStep[]} steps
 */

/**
 * Exec function signature — injectable for tests. Receives argv (no shell)
 * and must return stdout as a string. Should throw on non-zero exit.
 *
 * @typedef {(argv: string[]) => string} ExecFn
 */

/** Maximum age of a run eligible for re-run, in days. */
export const MAX_AGE_DAYS = 7;

/** Step conclusions that never block the phantom signature. */
const BENIGN_STEP_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);

/**
 * A step name that denotes post-job cleanup machinery rather than real work.
 * GitHub renders post-action steps as "Post Run <action>" and the final
 * bookkeeping step as "Complete job"; these may legitimately report a
 * non-success conclusion during a phantom cancel.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isPostJobCleanupStep(name) {
  return /^post\b/i.test(name) || /^complete job$/i.test(name);
}

/**
 * Decide whether a job is a PHANTOM cancel: job conclusion `cancelled` while
 * every non-cleanup step concluded successfully (or was skipped/neutral).
 *
 * @param {GhJob} job
 * @returns {boolean}
 */
export function isPhantomCancelJob(job) {
  if (job.conclusion !== 'cancelled') return false;
  for (const step of job.steps ?? []) {
    const conclusion = step.conclusion ?? 'success';
    if (BENIGN_STEP_CONCLUSIONS.has(conclusion)) continue;
    if (isPostJobCleanupStep(step.name)) continue;
    // A genuinely failed/cancelled mid-run step — not a phantom.
    return false;
  }
  return true;
}

/**
 * Decide whether `run` is the latest run for its (workflow, branch, sha)
 * tuple within `allRuns`. Never re-run a superseded run — a newer attempt of
 * the same commit already exists.
 *
 * @param {GhRun} run
 * @param {GhRun[]} allRuns
 * @returns {boolean}
 */
export function isLatestForTuple(run, allRuns) {
  for (const other of allRuns) {
    if (other.databaseId === run.databaseId) continue;
    if (
      other.workflowDatabaseId === run.workflowDatabaseId &&
      other.headBranch === run.headBranch &&
      other.headSha === run.headSha &&
      other.number > run.number
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Decide whether the branch (or PR) `run` belongs to has moved on to a
 * different head commit: another run of the SAME workflow on the SAME branch
 * has a higher run `number` and a different `headSha`.
 *
 * This is the #2788 failure mode — the stale sha has no newer run of its own,
 * so the tuple guard alone waves it through while the branch already has a
 * current-head run that a re-run would cancel.
 *
 * @param {GhRun} run
 * @param {GhRun[]} allRuns
 * @returns {boolean}
 */
export function isSupersededByNewerHead(run, allRuns) {
  for (const other of allRuns) {
    if (other.databaseId === run.databaseId) continue;
    if (other.workflowDatabaseId !== run.workflowDatabaseId) continue;
    if (other.headBranch !== run.headBranch) continue;
    // Same sha is the tuple guard's job, not evidence the branch moved on.
    if (other.headSha === run.headSha) continue;
    if (other.number > run.number) return true;
  }
  return false;
}

/**
 * Decide whether `run.headSha` is no longer the head commit of its branch/PR.
 *
 * `headShas` holds the resolved head per branch (`null` when the lookup failed
 * or the head could not be read). An unknown head is NOT evidence of staleness
 * — failing soft keeps the watchdog useful when `gh api` is unavailable.
 *
 * @param {GhRun} run
 * @param {Map<string, string | null>} headShas
 * @returns {boolean}
 */
export function isStaleBranchHead(run, headShas) {
  const head = headShas.get(run.headBranch);
  if (typeof head !== 'string' || head.length === 0) return false;
  return head !== run.headSha;
}

/**
 * Decide whether a run is within the re-run age window.
 *
 * @param {GhRun} run
 * @param {Date} now
 * @returns {boolean}
 */
export function isWithinAgeWindow(run, now) {
  const createdMs = Date.parse(run.createdAt);
  if (Number.isNaN(createdMs)) return false;
  return now.getTime() - createdMs <= MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// gh CLI wrappers
// ---------------------------------------------------------------------------

/**
 * List recent completed workflow runs via `gh run list`.
 *
 * @param {ExecFn} exec
 * @param {number} limit
 * @returns {GhRun[]}
 */
function listRecentRuns(exec, limit) {
  const out = exec([
    'run',
    'list',
    '--status',
    'completed',
    '--limit',
    String(limit),
    '--json',
    'databaseId,workflowName,workflowDatabaseId,headBranch,headSha,conclusion,createdAt,number,url',
  ]);
  return JSON.parse(out);
}

/**
 * Fetch the jobs (with steps) for one run via `gh run view`.
 *
 * @param {ExecFn} exec
 * @param {number} runId
 * @returns {GhJob[]}
 */
function getRunJobs(exec, runId) {
  const out = exec(['run', 'view', String(runId), '--json', 'jobs']);
  const parsed = JSON.parse(out);
  return parsed.jobs ?? [];
}

/**
 * Re-run the failed/cancelled jobs of a run.
 *
 * @param {ExecFn} exec
 * @param {number} runId
 */
function rerunRun(exec, runId) {
  exec(['run', 'rerun', String(runId), '--failed']);
}

/**
 * Resolve the `owner/repo` slug used for `gh api` calls. In Actions the slug
 * comes from the default `GITHUB_REPOSITORY` env var, so no extra call is made.
 *
 * @param {ExecFn} exec
 * @returns {string}
 */
function resolveRepoSlug(exec) {
  const fromEnv = process.env.GITHUB_REPOSITORY;
  if (typeof fromEnv === 'string' && fromEnv.includes('/')) return fromEnv;
  const slug = String(
    exec(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']),
  ).trim();
  if (!slug.includes('/')) {
    throw new Error(`cannot resolve repository slug from "${slug}"`);
  }
  return slug;
}

/**
 * Resolve the current head sha of a branch (or any git ref) via `gh api`.
 *
 * @param {ExecFn} exec
 * @param {string} slug
 * @param {string} branch
 * @returns {string | null}
 */
function fetchBranchHeadSha(exec, slug, branch) {
  const sha = String(exec(['api', `repos/${slug}/commits/${branch}`, '--jq', '.sha'])).trim();
  return sha.length > 0 ? sha : null;
}

/**
 * Build a memoised branch-head resolver: at most ONE `gh api` call per
 * distinct branch for the whole scan, and any failure resolves to `null`
 * (unknown) so a probe error never crashes the watchdog or forces a rerun.
 *
 * @param {object} opts
 * @param {ExecFn} opts.exec
 * @param {string | undefined} opts.repo pre-resolved `owner/repo` slug
 * @returns {(branch: string) => string | null}
 */
function makeHeadResolver({ exec, repo }) {
  /** @type {Map<string, string | null>} */
  const cache = new Map();
  /** @type {string | null} */
  let slug = repo ?? null;
  return (branch) => {
    if (cache.has(branch)) return cache.get(branch) ?? null;
    let sha = null;
    try {
      if (slug === null) slug = resolveRepoSlug(exec);
      sha = fetchBranchHeadSha(exec, slug, branch);
    } catch {
      // Head lookup unavailable (permissions, deleted branch, offline) — fall
      // back to the run-list evidence instead of assuming staleness.
      sha = null;
    }
    cache.set(branch, sha);
    return sha;
  };
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Scan recent completed runs, detect phantom cancels, and re-run the
 * eligible ones (unless `dryRun`).
 *
 * A run is eligible only when it is a phantom cancel, is not superseded (by a
 * newer attempt of its sha, a newer run of the branch at another sha, or a
 * branch head that has moved past its sha), and is inside the age window.
 *
 * @param {object} opts
 * @param {ExecFn} opts.exec
 * @param {boolean} opts.dryRun
 * @param {number} opts.limit
 * @param {Date} [opts.now] injectable clock for tests
 * @param {string} [opts.repo] `owner/repo` slug; default: env, then `gh repo view`
 * @param {(branch: string) => string | null} [opts.resolveHeadSha] injectable
 *   branch-head lookup (default: cached `gh api .../commits/<branch>`)
 * @returns {Promise<{
 *   scanned: number,
 *   cancelledRuns: number,
 *   phantomRuns: Array<{ id: number, workflow: string, branch: string, url: string, phantomJobs: string[] }>,
 *   rerun: number[],
 *   skippedSuperseded: number[],
 *   skippedTooOld: number[],
 *   skippedNotPhantom: number[],
 * }>}
 */
export async function runWatchdog({ exec, dryRun, limit, now = new Date(), repo, resolveHeadSha }) {
  const runs = listRecentRuns(exec, limit);
  const cancelled = runs.filter((r) => r.conclusion === 'cancelled');

  const summary = {
    scanned: runs.length,
    cancelledRuns: cancelled.length,
    phantomRuns: [],
    rerun: [],
    skippedSuperseded: [],
    skippedTooOld: [],
    skippedNotPhantom: [],
  };

  /** Branch → resolved head sha (`null` = unknown); at most one lookup each. */
  const headShas = new Map();
  const resolveHead = resolveHeadSha ?? makeHeadResolver({ exec, repo });

  for (const run of cancelled) {
    const jobs = getRunJobs(exec, run.databaseId);
    const phantomJobs = jobs.filter(isPhantomCancelJob);
    if (phantomJobs.length === 0) {
      summary.skippedNotPhantom.push(run.databaseId);
      continue;
    }
    // Cheap evidence first: the run list alone often proves supersession.
    if (!isLatestForTuple(run, runs) || isSupersededByNewerHead(run, runs)) {
      summary.skippedSuperseded.push(run.databaseId);
      continue;
    }
    // Then ask the branch: a newer run may still be queued/in progress, so it
    // is absent from the completed-run list even though the branch moved on.
    if (!headShas.has(run.headBranch)) {
      headShas.set(run.headBranch, resolveHead(run.headBranch));
    }
    if (isStaleBranchHead(run, headShas)) {
      summary.skippedSuperseded.push(run.databaseId);
      continue;
    }
    if (!isWithinAgeWindow(run, now)) {
      summary.skippedTooOld.push(run.databaseId);
      continue;
    }
    summary.phantomRuns.push({
      id: run.databaseId,
      workflow: run.workflowName,
      branch: run.headBranch,
      url: run.url,
      phantomJobs: phantomJobs.map((j) => j.name),
    });
    if (!dryRun) {
      rerunRun(exec, run.databaseId);
      summary.rerun.push(run.databaseId);
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Default exec: shell out to the `gh` CLI (argv, no shell interpolation).
 *
 * @type {ExecFn}
 */
function ghExec(argv) {
  return execFileSync('gh', argv, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * Parse CLI args into an options object. Throws on unknown flags or a bad
 * --limit value (usage error → exit 1).
 *
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const opts = { dryRun: false, json: false, limit: 30 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--limit') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`--limit requires a positive integer, got "${argv[i]}"`);
      }
      opts.limit = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[ci-phantom-cancel-watchdog] usage error: ${err.message}`);
    process.exit(1);
  }

  let summary;
  try {
    summary = await runWatchdog({
      exec: ghExec,
      dryRun: opts.dryRun,
      limit: opts.limit,
    });
  } catch (err) {
    console.error(`[ci-phantom-cancel-watchdog] gh API error: ${err.message}`);
    process.exit(1);
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    const mode = opts.dryRun ? 'dry-run' : 'execute';
    console.log(
      `[ci-phantom-cancel-watchdog] (${mode}) scanned=${summary.scanned} ` +
        `cancelled=${summary.cancelledRuns} phantom=${summary.phantomRuns.length}`,
    );
    for (const p of summary.phantomRuns) {
      const action = opts.dryRun ? 'would rerun' : 'rerun triggered';
      console.log(
        `  ${action}: run ${p.id} (${p.workflow} @ ${p.branch}) — jobs: ${p.phantomJobs.join(', ')}`,
      );
    }
    if (summary.skippedSuperseded.length > 0) {
      console.log(`  skipped (superseded): ${summary.skippedSuperseded.join(', ')}`);
    }
    if (summary.skippedTooOld.length > 0) {
      console.log(`  skipped (older than ${MAX_AGE_DAYS}d): ${summary.skippedTooOld.join(', ')}`);
    }
    if (summary.skippedNotPhantom.length > 0) {
      console.log(`  skipped (genuine cancel): ${summary.skippedNotPhantom.join(', ')}`);
    }
  }
  process.exit(0);
}

// Only run main() when invoked directly (not when imported by tests).
const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main();
}
