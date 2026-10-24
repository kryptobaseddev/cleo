/**
 * Background NEXUS reindex after a merge into the base branch (T14010).
 *
 * The CLEO `post-merge` hook starts `cleo nexus reindex-on-merge` detached.
 * It is opt-in (`nexus.reindexOnMerge.enabled`), runs only on the base branch,
 * runs one at a time per project (a lock file), and runs the analysis through
 * `cleo run` admission, so on a machine short of memory it waits or is
 * recorded as deferred instead of adding to the pressure. Every outcome is
 * written to `.cleo/nexus-reindex-on-merge.json` for `cleo nexus status`.
 *
 * Code placed in `packages/core/` per Package-Boundary Check — verified against AGENTS.md.
 *
 * @module nexus/reindex-on-merge
 * @task T14010
 */

import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { getConfigValue } from '../config/registry.js';
import { resolveBaseRef, resolveOriginDefault } from '../git/base-ref.js';
import { getCleoDirAbsolute } from '../paths.js';

/** File under `.cleo/` holding the last outcome. */
export const REINDEX_ON_MERGE_OUTCOME_FILE = 'nexus-reindex-on-merge.json';

/** Lock file under `.cleo/`; holds the pid of the running reindex. */
export const REINDEX_ON_MERGE_LOCK_FILE = 'nexus-reindex.lock';

/** Default seconds for `cleo run --wait --timeout`. */
export const DEFAULT_REINDEX_TIMEOUT_SECONDS = 1800;

/** `cleo run` exit code when the command was not admitted in time. */
const RUN_DEFERRED_EXIT = 75;

/** What the last reindex-on-merge did. */
export interface ReindexOnMergeOutcome {
  /** `ran` (index refreshed), `skipped`, `deferred` (not admitted in time) or `failed`. */
  outcome: 'ran' | 'skipped' | 'deferred' | 'failed';
  /** Why. */
  reason: string;
  /** When it finished (ISO 8601). */
  at: string;
  /** Wall-clock milliseconds. */
  durationMs: number;
}

/** Result of running the admitted analysis. */
export interface ReindexRunResult {
  /** Exit code of `cleo run`, or `null` when it could not start. */
  exitCode: number | null;
  /** Tail of its stderr, for the recorded reason. */
  stderr: string;
}

/** Runs `cleo nexus analyze` under `cleo run` admission; replaceable in tests. */
export type ReindexRunner = (projectRoot: string, timeoutSeconds: number) => ReindexRunResult;

/** The production runner: `cleo run --wait --class build -- cleo nexus analyze <root>`. */
const runAdmittedAnalyze: ReindexRunner = (projectRoot, timeoutSeconds) => {
  const child = spawnSync(
    'cleo',
    [
      'run',
      '--wait',
      '--timeout',
      String(timeoutSeconds),
      '--class',
      'build',
      '--',
      'cleo',
      'nexus',
      'analyze',
      projectRoot,
    ],
    { cwd: projectRoot, encoding: 'utf-8', stdio: ['ignore', 'ignore', 'pipe'] },
  );
  return { exitCode: child.status, stderr: (child.stderr ?? '').slice(-500) };
};

/** Whether a process with this pid is alive. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Take the per-project lock, clearing one left by a dead process.
 *
 * @returns `null` when taken, or the pid of the live holder.
 */
function takeLock(lockPath: string): number | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = Number.parseInt(readFileSync(lockPath, 'utf-8'), 10);
      if (Number.isInteger(holder) && holder > 0 && alive(holder)) return holder;
      rmSync(lockPath, { force: true });
    }
  }
  return -1;
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
 * Reindex after a merge, when enabled, on the base branch, alone and admitted.
 *
 * @param projectRoot - Project whose index is refreshed.
 * @param options - `runner` replaces the admitted analysis (tests); `now` the clock.
 * @returns The recorded outcome.
 * @example
 * ```ts
 * const { outcome, reason } = await runReindexOnMerge(root);
 * ```
 */
export async function runReindexOnMerge(
  projectRoot: string,
  options: { runner?: ReindexRunner; now?: () => number } = {},
): Promise<ReindexOnMergeOutcome> {
  const now = options.now ?? Date.now;
  const started = now();
  const done = (outcome: ReindexOnMergeOutcome['outcome'], reason: string) =>
    record(projectRoot, {
      outcome,
      reason,
      at: new Date(now()).toISOString(),
      durationMs: now() - started,
    });

  if ((await config('nexus.reindexOnMerge.enabled', projectRoot)) !== true)
    return done('skipped', 'nexus.reindexOnMerge.enabled is not true');
  const branch = currentBranch(projectRoot);
  const base = baseBranch(projectRoot);
  if (!branch || !base || branch !== base)
    return done(
      'skipped',
      `HEAD is on ${branch ?? 'a detached commit'}, not the base branch ${base ?? '(unknown)'}`,
    );

  const rawTimeout = Number(await config('nexus.reindexOnMerge.timeoutSeconds', projectRoot));
  const timeoutSeconds =
    Number.isInteger(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_REINDEX_TIMEOUT_SECONDS;
  const lockPath = join(getCleoDirAbsolute(projectRoot), REINDEX_ON_MERGE_LOCK_FILE);
  mkdirSync(getCleoDirAbsolute(projectRoot), { recursive: true });
  const holder = takeLock(lockPath);
  if (holder !== null)
    return done(
      'skipped',
      holder > 0
        ? `a reindex is already running (pid ${holder})`
        : 'the reindex lock could not be taken',
    );
  try {
    const run = (options.runner ?? runAdmittedAnalyze)(projectRoot, timeoutSeconds);
    if (run.exitCode === 0) return done('ran', `cleo nexus analyze finished on ${base}`);
    if (run.exitCode === RUN_DEFERRED_EXIT)
      return done('deferred', `not admitted by cleo run within ${timeoutSeconds}s (machine busy)`);
    return done(
      'failed',
      `cleo nexus analyze exited ${run.exitCode ?? 'without starting'}: ${run.stderr.trim() || 'no output'}`,
    );
  } finally {
    rmSync(lockPath, { force: true });
  }
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
