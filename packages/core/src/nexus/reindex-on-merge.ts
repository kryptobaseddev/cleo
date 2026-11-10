/**
 * Background NEXUS reindex after a merge into the base branch (T14010).
 *
 * The CLEO `post-merge` hook starts nothing unless the repository's git config
 * carries the {@link REINDEX_ON_MERGE_GIT_KEY} marker and HEAD is on the base
 * branch; both are checked in shell, so a disabled project pays no process
 * start on a merge or pull. `cleo nexus reindex-on-merge --enable` sets that
 * marker together with `nexus.reindexOnMerge.enabled`.
 *
 * When it runs, it is the lowest-priority heavy work on the machine: it never
 * joins the `cleo run` FIFO queue. It tries admission without waiting, only
 * when nothing is queued, and backs off between tries until its timeout
 * (default 300s), then records `deferred`. One runs at a time per project (a
 * lock file), and only real outcomes (ran, deferred, failed) are written to
 * `.cleo/nexus-reindex-on-merge.json` for `cleo nexus status`.
 *
 * Code placed in `packages/core/` per Package-Boundary Check — verified against AGENTS.md.
 *
 * @module nexus/reindex-on-merge
 * @task T14010
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NEXUS_GIT_HOOK_NAMES } from '@cleocode/contracts/git-hooks.js';
import { getConfigValue } from '../config/registry.js';
import { setConfigValue } from '../config.js';
import { resolveBaseRef, resolveOriginDefault } from '../git/base-ref.js';
import {
  type InstallCleoHooksResult,
  installCleoHooks,
  NEXUS_AUTO_REINDEX_GIT_KEY,
} from '../git/hooks-install.js';
import { getCleoDirAbsolute } from '../paths.js';
import { releasePidLock, takePidLock } from './pid-lock.js';

/** File under `.cleo/` holding the last real outcome (ran, deferred, failed). */
export const REINDEX_ON_MERGE_OUTCOME_FILE = 'nexus-reindex-on-merge.json';

/** Lock file under `.cleo/`; holds the pid of the running reindex. */
export const REINDEX_ON_MERGE_LOCK_FILE = 'nexus-reindex.lock';

/**
 * File under `.cleo/` asking the running reindex for one more pass (T12349):
 * a hook that finds the lock held leaves it, so a burst of commits during a
 * run coalesces into a single follow-up.
 */
export const REINDEX_PENDING_FILE = 'nexus-reindex.pending';

/** Git config key the `post-merge` hook checks before starting anything. */
export const REINDEX_ON_MERGE_GIT_KEY = 'cleo.nexusReindexOnMerge';

/** Default seconds to keep trying for admission before recording `deferred`. */
export const DEFAULT_REINDEX_TIMEOUT_SECONDS = 300;

/** Seconds between admission attempts. */
const RETRY_SECONDS = 30;

/** `cleo run` exit code when the command was not admitted. */
const RUN_DEFERRED_EXIT = 75;

/** What a reindex-on-merge did. */
export interface ReindexOnMergeOutcome {
  /** `ran` (index refreshed), `skipped` (not recorded), `deferred` (machine busy) or `failed`. */
  outcome: 'ran' | 'skipped' | 'deferred' | 'failed';
  /** Why. */
  reason: string;
  /** When it finished (ISO 8601). */
  at: string;
  /** Wall-clock milliseconds. */
  durationMs: number;
}

/** Result of one admission attempt. */
export interface ReindexRunResult {
  /** Exit code of `cleo run`, or `null` when it could not start. */
  exitCode: number | null;
  /** Tail of its stderr, for the recorded reason. */
  stderr: string;
}

/** One admission attempt of `cleo nexus analyze`; replaceable in tests. */
export type ReindexRunner = (projectRoot: string) => ReindexRunResult;

/** Seams for tests: the attempt, the clock, the wait and the queue probe. */
export interface ReindexOnMergeDeps {
  /** One admission attempt (no `--wait`). */
  runner?: ReindexRunner;
  /** Clock in milliseconds. */
  now?: () => number;
  /** Wait between attempts. */
  sleep?: (ms: number) => Promise<void>;
  /** Whether any run is waiting in the `cleo run` queue. */
  queueBusy?: () => boolean;
}

/**
 * One attempt: `cleo run --class scan -- cleo nexus analyze <root>`, never
 * `--wait`. Analyze is incremental by default: it parses only the files that
 * changed since the indexed revision.
 */
const runAdmittedAnalyze: ReindexRunner = (projectRoot) => {
  const child = spawnSync(
    'cleo',
    ['run', '--class', 'scan', '--', 'cleo', 'nexus', 'analyze', projectRoot],
    { cwd: projectRoot, encoding: 'utf-8', stdio: ['ignore', 'ignore', 'pipe'] },
  );
  return { exitCode: child.status, stderr: (child.stderr ?? '').slice(-500) };
};

/** Whether anything waits in the machine-wide admission queue. */
async function anyoneQueued(): Promise<boolean> {
  try {
    const { readLedger } = await import('../resources/admission-ledger.js');
    return readLedger().some((entry) => entry.state === 'waiting');
  } catch {
    return true;
  }
}

/** The branch HEAD is on, or `null` when detached. */
function currentBranch(projectRoot: string): string | null {
  const out = spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return out.status === 0 ? out.stdout.trim() || null : null;
}

/** Local name of the base branch (`origin/main` → `main`). */
function baseBranch(projectRoot: string): string | null {
  const origin = resolveOriginDefault(projectRoot);
  if (origin) return origin.replace(/^origin\//, '');
  const base = resolveBaseRef(projectRoot);
  return base && base !== 'HEAD' ? base : null;
}

/** Read a config value, `undefined` when unreadable. */
async function config(key: string, projectRoot: string): Promise<unknown> {
  try {
    return await getConfigValue(key, { projectRoot });
  } catch {
    return undefined;
  }
}

/** Write the outcome atomically (temp file, rename). */
function record(projectRoot: string, outcome: ReindexOnMergeOutcome): ReindexOnMergeOutcome {
  const dir = getCleoDirAbsolute(projectRoot);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, REINDEX_ON_MERGE_OUTCOME_FILE);
  writeFileSync(`${target}.tmp`, `${JSON.stringify(outcome, null, 2)}\n`);
  renameSync(`${target}.tmp`, target);
  return outcome;
}

/**
 * Turn reindex-on-merge on or off: `nexus.reindexOnMerge.enabled` and the git
 * config marker the `post-merge` hook checks, together.
 *
 * @param projectRoot - Project to configure.
 * @param enabled - The new setting.
 * @example
 * ```ts
 * await setReindexOnMerge(root, true);
 * ```
 */
export async function setReindexOnMerge(projectRoot: string, enabled: boolean): Promise<void> {
  await setConfigValue('nexus.reindexOnMerge.enabled', enabled, projectRoot);
  const args = enabled
    ? ['config', REINDEX_ON_MERGE_GIT_KEY, 'true']
    : ['config', '--unset', REINDEX_ON_MERGE_GIT_KEY];
  const out = spawnSync('git', args, { cwd: projectRoot, stdio: 'ignore' });
  // `--unset` exits 5 when the key is already absent.
  // @sync-invariant none:local-only a git config marker; no CLEO store is written
  if (out.status !== 0 && !(out.status === 5 && !enabled))
    throw new Error(`git ${args.join(' ')} failed in ${projectRoot}`);
}

/**
 * Reindex after a merge, when enabled, on the base branch, alone and admitted
 * at the lowest priority. Skips are returned, never recorded, so `nexus status`
 * keeps the last real outcome.
 *
 * @param projectRoot - Project whose index is refreshed.
 * @param deps - Test seams (attempt, clock, sleep, queue probe).
 * @returns The outcome.
 * @example
 * ```ts
 * const { outcome, reason } = await runReindexOnMerge(root);
 * ```
 */
export async function runReindexOnMerge(
  projectRoot: string,
  deps: ReindexOnMergeDeps = {},
): Promise<ReindexOnMergeOutcome> {
  const now = deps.now ?? Date.now;
  const started = now();
  const result: OutcomeOf = (outcome, reason) => ({
    outcome,
    reason,
    at: new Date(now()).toISOString(),
    durationMs: now() - started,
  });

  if ((await config('nexus.reindexOnMerge.enabled', projectRoot)) !== true)
    return result('skipped', 'nexus.reindexOnMerge.enabled is not true');
  const branch = currentBranch(projectRoot);
  const base = baseBranch(projectRoot);
  if (!branch || !base || branch !== base)
    return result(
      'skipped',
      `HEAD is on ${branch ?? 'a detached commit'}, not the base branch ${base ?? '(unknown)'}`,
    );

  const outcome = await admitAndRun(projectRoot, `on ${base}`, deps, result);
  return outcome ?? result('skipped', 'a reindex is already running');
}

/** Builds an outcome stamped with its finish time and duration. */
type OutcomeOf = (
  outcome: ReindexOnMergeOutcome['outcome'],
  reason: string,
) => ReindexOnMergeOutcome;

/**
 * Take the project's reindex lock and run admitted analyses until no pass is
 * pending. Returns `null` when another process holds the lock: the request
 * is then left in {@link REINDEX_PENDING_FILE} for that holder.
 */
async function admitAndRun(
  projectRoot: string,
  where: string,
  deps: ReindexOnMergeDeps,
  result: OutcomeOf,
): Promise<ReindexOnMergeOutcome | null> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const runner = deps.runner ?? runAdmittedAnalyze;
  const rawTimeout = Number(await config('nexus.reindexOnMerge.timeoutSeconds', projectRoot));
  const timeoutSeconds =
    Number.isInteger(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_REINDEX_TIMEOUT_SECONDS;
  const cleoDir = getCleoDirAbsolute(projectRoot);
  mkdirSync(cleoDir, { recursive: true });
  const lockPath = join(cleoDir, REINDEX_ON_MERGE_LOCK_FILE);
  const pendingPath = join(cleoDir, REINDEX_PENDING_FILE);
  // Ask before trying the lock: a holder that releases first then sees the request.
  writeFileSync(pendingPath, '');
  let last: ReindexOnMergeOutcome | null = null;
  while (existsSync(pendingPath)) {
    if (takePidLock(lockPath) !== null) return last;
    try {
      while (existsSync(pendingPath)) {
        rmSync(pendingPath, { force: true });
        last = await attempt(projectRoot, where, timeoutSeconds, runner, now, sleep, deps, result);
        if (last.outcome !== 'ran') {
          rmSync(pendingPath, { force: true });
          return last;
        }
      }
    } finally {
      releasePidLock(lockPath);
    }
  }
  return last;
}

/** Try for admission until the timeout; record the real outcome. */
async function attempt(
  projectRoot: string,
  where: string,
  timeoutSeconds: number,
  runner: ReindexRunner,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  deps: ReindexOnMergeDeps,
  result: OutcomeOf,
): Promise<ReindexOnMergeOutcome> {
  const deadline = now() + timeoutSeconds * 1000;
  for (;;) {
    // Lowest priority: never queue, and yield to anything already waiting.
    const busy = deps.queueBusy ? deps.queueBusy() : await anyoneQueued();
    if (!busy) {
      const run = runner(projectRoot);
      if (run.exitCode === 0)
        return record(projectRoot, result('ran', `cleo nexus analyze finished ${where}`));
      if (run.exitCode !== RUN_DEFERRED_EXIT)
        return record(
          projectRoot,
          result(
            'failed',
            `cleo nexus analyze exited ${run.exitCode ?? 'without starting'}: ${run.stderr.trim() || 'no output'}`,
          ),
        );
    }
    if (now() + RETRY_SECONDS * 1000 > deadline)
      return record(
        projectRoot,
        result(
          'deferred',
          `not admitted within ${timeoutSeconds}s (machine busy or others queued)`,
        ),
      );
    await sleep(RETRY_SECONDS * 1000);
  }
}

/**
 * Refresh the index after a commit, merge, checkout or rewrite (T12349): the
 * CLEO `post-*` hooks start it detached. One runs at a time per project; a
 * request that finds one running is coalesced into a single follow-up pass of
 * the holder. Admitted like {@link runReindexOnMerge}, at the lowest priority.
 *
 * @param projectRoot - Project whose index is refreshed.
 * @param deps - Test seams (attempt, clock, sleep, queue probe).
 * @returns The last outcome, or `skipped` when the request was coalesced.
 * @example
 * ```ts
 * const { outcome } = await runNexusAutoReindex(root);
 * ```
 */
export async function runNexusAutoReindex(
  projectRoot: string,
  deps: ReindexOnMergeDeps = {},
): Promise<ReindexOnMergeOutcome> {
  const now = deps.now ?? Date.now;
  const started = now();
  const result: OutcomeOf = (outcome, reason) => ({
    outcome,
    reason,
    at: new Date(now()).toISOString(),
    durationMs: now() - started,
  });
  const outcome = await admitAndRun(projectRoot, 'after a git change', deps, result);
  return outcome ?? result('skipped', 'coalesced into the running reindex');
}

/**
 * `cleo nexus hooks install|uninstall` (T12349). Install turns the refresh on
 * (`cleo.nexusAutoReindex=true`) and installs the NEXUS `post-*` hooks,
 * chaining any hook already there; it is idempotent. Uninstall turns it off
 * (`false`, which `cleo init` and `cleo upgrade` respect) and restores each
 * hook's recorded pre-CLEO image exactly; a hook changed since is preserved
 * and reported in `skipped`.
 *
 * @param projectRoot - Repository to configure.
 * @param enabled - `true` to install, `false` to uninstall.
 * @returns The installer result for the NEXUS hooks.
 * @example
 * ```ts
 * const { installed, skipped } = await setNexusHooks(root, true);
 * ```
 */
export async function setNexusHooks(
  projectRoot: string,
  enabled: boolean,
): Promise<InstallCleoHooksResult> {
  const out = spawnSync('git', ['config', NEXUS_AUTO_REINDEX_GIT_KEY, String(enabled)], {
    cwd: projectRoot,
    stdio: 'ignore',
  });
  // @sync-invariant none:local-only a git config marker; no CLEO store is written
  if (out.status !== 0) throw new Error(`git config ${NEXUS_AUTO_REINDEX_GIT_KEY} failed`);
  return installCleoHooks(projectRoot, { names: NEXUS_GIT_HOOK_NAMES, uninstall: !enabled });
}

/**
 * The last recorded reindex-on-merge outcome, for `cleo nexus status`.
 *
 * @param projectRoot - Project to read.
 * @returns The outcome, or `null` when none was recorded or it is unreadable.
 */
export function readReindexOnMergeOutcome(projectRoot: string): ReindexOnMergeOutcome | null {
  const file = join(getCleoDirAbsolute(projectRoot), REINDEX_ON_MERGE_OUTCOME_FILE);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as ReindexOnMergeOutcome;
  } catch {
    return null;
  }
}
