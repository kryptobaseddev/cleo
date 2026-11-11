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
 * Rerun guard (T14488): a run is only re-run when it is NOT superseded, its
 * head is CONFIRMED to still be the current head of its ref, and it is no
 * older than 7 days. A run is superseded when
 *   - a newer run exists for its exact (workflow, ref, sha) tuple (a newer
 *     attempt of the same commit), OR
 *   - a newer run of the same workflow on the SAME ref carries a DIFFERENT
 *     headSha (the ref has moved on).
 *
 * The ref identity is the PR number for `pull_request` runs and the head
 * repository + branch otherwise. Branch names are NOT unique: two PRs (or a
 * PR and a push) can share `task/x`, and a fork PR's branch name usually also
 * exists in the base repository. Keying by branch name alone conflates them,
 * so the head is resolved per ref with at most ONE cached API call:
 *   - pull_request: the PR's current head (`gh api .../pulls/<n>` -> .head.sha)
 *   - otherwise:    the branch head of the run's own head repository
 *                   (`gh api .../commits/<branch>` -> .sha)
 *
 * An UNKNOWN head (lookup failed, deleted branch, pull_request run whose PR
 * cannot be identified) is NEVER re-run. A blind re-run is the exact harm this
 * guard exists to prevent: it re-enters the ref's concurrency group and can
 * cancel the ref's current-head run.
 *
 * Why the extra checks: all runs of a workflow share the concurrency group
 * `<workflow>-<ref>`. Re-running a stale head re-enters that group and GitHub
 * CANCELS the ref's current-head run to make room (observed 2026-11-11 on
 * #2788: re-running 42932816902 at 6b26c850d cancelled 42941492356 at
 * 07f926e8c), leaving the PR with no run for its real head.
 *
 * Usage:
 *   node scripts/ci-phantom-cancel-watchdog.mjs             # execute reruns
 *   node scripts/ci-phantom-cancel-watchdog.mjs --dry-run   # print only
 *   node scripts/ci-phantom-cancel-watchdog.mjs --json      # machine output
 *   node scripts/ci-phantom-cancel-watchdog.mjs --limit 50  # scan 50 runs (API max 100)
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
 * @property {string} event GitHub event that created the run (`pull_request`, `push`, …)
 * @property {string | null} headRepository `owner/repo` owning the head commit (the fork for a fork PR)
 * @property {number[]} pullRequests base-repository PR numbers the run belongs to
 */

/**
 * What a run's freshness must be measured against. `pull_request` runs belong
 * to a PR (whose head lives in the base repository); everything else belongs
 * to a branch in the run's own head repository.
 *
 * @typedef {{ kind: 'pull_request', pullRequestNumber: number }
 *   | { kind: 'branch', repo: string | null, branch: string }} HeadTarget
 */

/**
 * Tri-state result of comparing a run's `headSha` with the ref's current head.
 *
 * @typedef {'current' | 'stale' | 'unknown'} HeadStatus
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
 * Identify the ref a run's head belongs to.
 *
 * `pull_request` runs resolve through their PR number (the PR lives in the
 * base repository, so a fork's branch name never decides freshness).
 * `pull_request_target` and every other event run against a branch, so they
 * keep branch identity.
 *
 * Returns `null` when the identity cannot be established — a `pull_request`
 * run whose `pull_requests[]` is empty (deleted PR, API omission). Such a run
 * must never be re-run.
 *
 * @param {GhRun} run
 * @returns {HeadTarget | null}
 */
export function headTargetForRun(run) {
  if (run.event === 'pull_request') {
    const number = run.pullRequests?.[0];
    return Number.isInteger(number) ? { kind: 'pull_request', pullRequestNumber: number } : null;
  }
  return { kind: 'branch', repo: run.headRepository ?? null, branch: run.headBranch };
}

/**
 * Cache/identity key for a head target: the PR number (branch names are shared
 * across PRs and forks), or the head repository + branch for branch runs.
 *
 * @param {HeadTarget} target
 * @returns {string}
 */
export function headTargetKey(target) {
  return target.kind === 'pull_request'
    ? `pull_request:${target.pullRequestNumber}`
    : `branch:${target.repo ?? ''}#${target.branch}`;
}

/**
 * The ref identity of a run, or `null` when it cannot be established.
 *
 * @param {GhRun} run
 * @returns {string | null}
 */
export function headIdentityOf(run) {
  const target = headTargetForRun(run);
  return target === null ? null : headTargetKey(target);
}

/**
 * Decide whether the ref `run` belongs to has moved on to a different head
 * commit: another run of the SAME workflow on the SAME ref has a higher run
 * `number` and a different `headSha`.
 *
 * This is the #2788 failure mode — the stale sha has no newer run of its own,
 * so the tuple guard alone waves it through while the ref already has a
 * current-head run that a re-run would cancel.
 *
 * Comparison is per REF, not per branch name: two PRs sharing `task/x` (or a
 * fork PR whose branch name also exists in the base repository) are unrelated
 * refs with their own concurrency groups, so neither supersedes the other.
 *
 * @param {GhRun} run
 * @param {GhRun[]} allRuns
 * @returns {boolean}
 */
export function isSupersededByNewerHead(run, allRuns) {
  const identity = headIdentityOf(run);
  if (identity === null) return false;
  for (const other of allRuns) {
    if (other.databaseId === run.databaseId) continue;
    if (other.workflowDatabaseId !== run.workflowDatabaseId) continue;
    if (headIdentityOf(other) !== identity) continue;
    // Same sha is the tuple guard's job, not evidence the ref moved on.
    if (other.headSha === run.headSha) continue;
    if (other.number > run.number) return true;
  }
  return false;
}

/**
 * Classify `run.headSha` against the resolved current head of its ref.
 *
 * `unknown` (no resolved head) is a SKIP, never a re-run: an unverifiable head
 * might already be superseded, and re-running it can cancel the ref's current
 * run. Only a confirmed match may be re-run; a confirmed mismatch is stale.
 *
 * @param {GhRun} run
 * @param {string | null} head current head sha of the run's ref
 * @returns {HeadStatus}
 */
export function classifyHead(run, head) {
  if (typeof head !== 'string' || head.length === 0) return 'unknown';
  return head === run.headSha ? 'current' : 'stale';
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
 * The subset of the Actions-API workflow-run object this script reads.
 *
 * @typedef {object} ApiWorkflowRun
 * @property {number} id
 * @property {string} name
 * @property {number} workflow_id
 * @property {string} head_branch
 * @property {string} head_sha
 * @property {string | null} conclusion
 * @property {string} created_at
 * @property {number} run_number
 * @property {string} html_url
 * @property {string} [event]
 * @property {{ full_name?: string } | null} [head_repository]
 * @property {Array<{ number?: number }>} [pull_requests]
 */

/**
 * Map one Actions-API run object onto {@link GhRun}.
 *
 * @param {ApiWorkflowRun} apiRun
 * @returns {GhRun}
 */
function mapApiRun(apiRun) {
  return {
    databaseId: apiRun.id,
    workflowName: apiRun.name,
    workflowDatabaseId: apiRun.workflow_id,
    headBranch: apiRun.head_branch,
    headSha: apiRun.head_sha,
    conclusion: apiRun.conclusion,
    createdAt: apiRun.created_at,
    number: apiRun.run_number,
    url: apiRun.html_url,
    event: apiRun.event ?? '',
    headRepository: apiRun.head_repository?.full_name ?? null,
    pullRequests: (apiRun.pull_requests ?? [])
      .map((pr) => pr?.number)
      .filter((n) => Number.isInteger(n)),
  };
}

/**
 * List recent completed workflow runs.
 *
 * Uses the Actions API rather than `gh run list` because the CLI's JSON fields
 * omit `event`, `pull_requests[]` and `head_repository` — exactly the ref
 * identity the freshness guard needs (T14488).
 *
 * @param {ExecFn} exec
 * @param {number} limit
 * @param {string} slug `owner/repo`
 * @returns {GhRun[]}
 */
function listRecentRuns(exec, limit, slug) {
  // The Actions API caps `per_page` at 100; a larger --limit cannot scan more.
  const perPage = Math.min(limit, 100);
  const out = exec(['api', `repos/${slug}/actions/runs?status=completed&per_page=${perPage}`]);
  const parsed = JSON.parse(out);
  return (parsed.workflow_runs ?? []).map(mapApiRun);
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
 * Resolve the current head sha of a pull request via `gh api`.
 *
 * @param {ExecFn} exec
 * @param {string} slug base `owner/repo`
 * @param {number} pullRequestNumber
 * @returns {string | null}
 */
function fetchPullRequestHeadSha(exec, slug, pullRequestNumber) {
  const sha = String(
    exec(['api', `repos/${slug}/pulls/${pullRequestNumber}`, '--jq', '.head.sha']),
  ).trim();
  return sha.length > 0 ? sha : null;
}

/**
 * Build a memoised ref-head resolver: at most ONE API call per ref (PR number,
 * or head repo + branch for branch runs) for the whole scan.
 *
 * Any failure resolves to `null` (unknown). Unknown is a SKIP at the call
 * site, never a re-run: an unverifiable head can already be superseded, and
 * re-running it may cancel the ref's current-head run.
 *
 * @param {object} opts
 * @param {ExecFn} opts.exec
 * @param {string | undefined} opts.repo pre-resolved base `owner/repo` slug
 * @returns {(target: HeadTarget) => string | null}
 */
export function createHeadResolver({ exec, repo }) {
  /** @type {Map<string, string | null>} */
  const cache = new Map();
  /** @type {string | null} */
  let baseSlug = repo ?? null;

  /** Resolve the base `owner/repo` slug once (env, then `gh repo view`). */
  const baseRepo = () => {
    if (baseSlug === null) baseSlug = resolveRepoSlug(exec);
    return baseSlug;
  };

  return (target) => {
    let key;
    if (target.kind === 'pull_request') {
      key = headTargetKey(target);
    } else {
      try {
        key = headTargetKey({ ...target, repo: target.repo ?? baseRepo() });
      } catch {
        // Base slug unresolvable: key on the branch alone so one failed probe
        // is not repeated for every run of that branch.
        key = `branch:${target.branch}`;
      }
    }
    if (cache.has(key)) return cache.get(key) ?? null;
    let sha = null;
    try {
      sha =
        target.kind === 'pull_request'
          ? fetchPullRequestHeadSha(exec, baseRepo(), target.pullRequestNumber)
          : fetchBranchHeadSha(exec, target.repo ?? baseRepo(), target.branch);
    } catch {
      // Head lookup unavailable (permissions, deleted branch, offline, no PR
      // identity) — the run is skipped, never re-run on a guess.
      sha = null;
    }
    cache.set(key, sha);
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
 * newer attempt of its sha or a newer run of its ref at another sha), its
 * headSha is CONFIRMED to still be the ref's head (an unresolvable head is
 * skipped), and it is inside the age window.
 *
 * @param {object} opts
 * @param {ExecFn} opts.exec
 * @param {boolean} opts.dryRun
 * @param {number} opts.limit
 * @param {Date} [opts.now] injectable clock for tests
 * @param {string} [opts.repo] base `owner/repo` slug; default: env, then `gh repo view`
 * @returns {Promise<{
 *   scanned: number,
 *   cancelledRuns: number,
 *   phantomRuns: Array<{ id: number, workflow: string, branch: string, url: string, phantomJobs: string[] }>,
 *   rerun: number[],
 *   skippedSuperseded: number[],
 *   skippedHeadUnknown: number[],
 *   skippedTooOld: number[],
 *   skippedNotPhantom: number[],
 * }>}
 */
export async function runWatchdog({ exec, dryRun, limit, now = new Date(), repo }) {
  const slug = repo ?? resolveRepoSlug(exec);
  const runs = listRecentRuns(exec, limit, slug);
  const cancelled = runs.filter((r) => r.conclusion === 'cancelled');

  const summary = {
    scanned: runs.length,
    cancelledRuns: cancelled.length,
    phantomRuns: [],
    rerun: [],
    skippedSuperseded: [],
    skippedHeadUnknown: [],
    skippedTooOld: [],
    skippedNotPhantom: [],
  };

  const resolve = createHeadResolver({ exec, repo: slug });

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
    // Then ask the ref: a newer run may still be queued/in progress, so it is
    // absent from the completed-run list even though the ref moved on.
    const target = headTargetForRun(run);
    const headStatus = classifyHead(run, target === null ? null : resolve(target));
    if (headStatus === 'stale') {
      summary.skippedSuperseded.push(run.databaseId);
      continue;
    }
    if (headStatus === 'unknown') {
      // Never re-run blind: the current-head run may exist and would be
      // cancelled by the re-run (T14488).
      summary.skippedHeadUnknown.push(run.databaseId);
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
    if (summary.skippedHeadUnknown.length > 0) {
      console.log(`  skipped (head unknown): ${summary.skippedHeadUnknown.join(', ')}`);
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
