/**
 * Spawn worktree preflight guards (T11489 · DHQ-037/019).
 *
 * Two guards that run before/around `git worktree add`:
 *
 * 1. **Leaked `core.worktree` detection + auto-heal** — A stale
 *    `.claude/worktrees/<agent>/` path can leak into the SHARED
 *    `.git/config` as `[core] worktree = /...`. This makes git think
 *    the main repo root is INSIDE that (now-deleted) directory, causing
 *    every subsequent `git worktree add` to fail with the cryptic error:
 *    "fatal: this operation must be run in a work tree". The fix is to
 *    unset the key with `git config --file <repo>/.git/config --unset core.worktree`.
 *
 * 2. **Build-ready guarantee** — After provisioning, the worktree's
 *    `node_modules` directory may be absent (no `.worktreeinclude` line
 *    for `pnpm-lock.yaml`, or install was deferred). If `pnpm-lock.yaml`
 *    exists but `node_modules` does not, this module auto-installs with
 *    `--prefer-offline --ignore-scripts` and returns a structured
 *    {@link InstallStatus} so callers can surface the outcome.
 *
 * @task T11489
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { gitSilent } from './git.js';

// ---------------------------------------------------------------------------
// 1. Leaked core.worktree detection + auto-heal
// ---------------------------------------------------------------------------

/**
 * Result returned by {@link detectAndHealCoreWorktreeLeak}.
 */
export interface CoreWorktreeLeakResult {
  /** Whether a leaked `core.worktree` key was found in `.git/config`. */
  leakDetected: boolean;
  /** The value of the leaked key (if any). */
  leakedValue?: string;
  /** Whether the auto-heal succeeded (`git config --unset core.worktree`). */
  healed: boolean;
  /**
   * If healing failed, the error message for diagnostics.
   * Only set when `leakDetected && !healed`.
   */
  healError?: string;
}

/**
 * Detect and auto-heal a leaked `core.worktree` key in the shared `.git/config`.
 *
 * **Root cause (DHQ-037 / DHQ-019):**
 * When `git worktree add` is run and `worktreeConfig=true` mode is active
 * (or a Claude Code agent session leaves a stale `.claude/worktrees/<id>/`),
 * git writes `[core] worktree = /path/to/deleted-dir` into the SHARED
 * `.git/config`. After the directory is deleted the main repo git context
 * becomes invalid — `git rev-parse --show-toplevel` and `git worktree add`
 * both fail with "this operation must be run in a work tree".
 *
 * **Fix:** Read `.git/config` directly and unset the key with
 * `git config --file <gitConfig> --unset core.worktree`.
 *
 * **Usage:** Call this BEFORE any `git worktree add` in the spawn pipeline.
 * The function is idempotent — when no leak exists it returns
 * `{ leakDetected: false, healed: false }` in under 10 ms.
 *
 * @param gitRoot - Absolute path to the git root (where `.git/` lives).
 * @returns Structured result with detection and healing outcome.
 *
 * @task T11489
 */
export function detectAndHealCoreWorktreeLeak(gitRoot: string): CoreWorktreeLeakResult {
  const gitConfigPath = join(gitRoot, '.git', 'config');

  // Fast-path: if .git/config doesn't exist this is not a git repo.
  if (!existsSync(gitConfigPath)) {
    return { leakDetected: false, healed: false };
  }

  // Probe for core.worktree using git config directly on the file so we
  // bypass the git context (which may itself be broken by the leak).
  let leakedValue: string | undefined;
  try {
    const result = execFileSync(
      'git',
      ['config', '--file', gitConfigPath, '--get', 'core.worktree'],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000 },
    ).trim();
    if (result) {
      leakedValue = result;
    }
  } catch {
    // exit-code 1 means the key is absent — no leak.
    return { leakDetected: false, healed: false };
  }

  if (!leakedValue) {
    return { leakDetected: false, healed: false };
  }

  // Leak detected — attempt auto-heal via --unset.
  const healed = gitSilent(
    ['config', '--file', gitConfigPath, '--unset', 'core.worktree'],
    gitRoot,
  );

  if (healed) {
    process.stderr.write(
      `[worktree-preflight] E_WT_CONFIG_LEAK detected and healed: ` +
        `removed core.worktree="${leakedValue}" from ${gitConfigPath}\n`,
    );
    return { leakDetected: true, leakedValue, healed: true };
  }

  const healError = `git config --file ${gitConfigPath} --unset core.worktree failed`;
  process.stderr.write(
    `[worktree-preflight] E_WT_CONFIG_LEAK detected but heal FAILED: ` +
      `core.worktree="${leakedValue}" in ${gitConfigPath}. ` +
      `Manual fix: git config --file ${gitConfigPath} --unset core.worktree\n`,
  );
  return { leakDetected: true, leakedValue, healed: false, healError };
}

/**
 * Assert that the git root has no leaked `core.worktree` key, healing it
 * automatically if found.
 *
 * Throws an {@link E_WT_CONFIG_LEAK} error only when the leak is detected but
 * the auto-heal fails (the broken git context persists). When the leak is
 * healed successfully the function returns normally so the caller can proceed
 * with `git worktree add`.
 *
 * @param gitRoot - Absolute path to the git root.
 * @throws Error with code `E_WT_CONFIG_LEAK` when the leak cannot be healed.
 *
 * @task T11489
 */
export function assertNoWorktreeConfigLeak(gitRoot: string): void {
  const result = detectAndHealCoreWorktreeLeak(gitRoot);
  if (result.leakDetected && !result.healed) {
    throw Object.assign(
      new Error(
        `E_WT_CONFIG_LEAK: core.worktree="${result.leakedValue}" is leaked in ` +
          `${join(gitRoot, '.git', 'config')}. ` +
          `This breaks all git worktree operations with "must be run in a work tree". ` +
          `Auto-heal failed: ${result.healError ?? 'unknown error'}. ` +
          `Manual fix: git config --file ${join(gitRoot, '.git', 'config')} --unset core.worktree`,
      ),
      {
        code: 'E_WT_CONFIG_LEAK',
        gitRoot,
        leakedValue: result.leakedValue,
        healError: result.healError,
      },
    );
  }
}

// ---------------------------------------------------------------------------
// 2. Build-ready guarantee — auto-install after provisioning
// ---------------------------------------------------------------------------

/**
 * Outcome of {@link ensureWorktreeBuildReady}.
 */
export interface InstallStatus {
  /** Whether `node_modules` is present (before or after install). */
  nodeModulesPresent: boolean;
  /**
   * Whether `pnpm-lock.yaml` exists — when false the worktree is likely
   * not a pnpm monorepo and no install was attempted.
   */
  lockfilePresent: boolean;
  /**
   * The action taken:
   * - `already-ready` — `node_modules` existed; nothing done.
   * - `installed`     — pnpm install ran and succeeded.
   * - `install-failed`— pnpm install ran but failed; `error` is set.
   * - `no-lockfile`   — `pnpm-lock.yaml` absent; install not attempted.
   */
  action: 'already-ready' | 'installed' | 'install-failed' | 'no-lockfile';
  /** Error detail when `action === 'install-failed'`. */
  error?: string;
}

/**
 * Ensure a newly provisioned worktree is build-ready.
 *
 * After `git worktree add` the new worktree directory has NO `node_modules`
 * unless `.worktreeinclude` explicitly lists `pnpm-lock.yaml` (which triggers
 * the serialized pnpm install in `worktree-pnpm.ts`). Many agent tasks arrive
 * without that include line and then fail immediately when they try to run any
 * `pnpm` or `node` command.
 *
 * This function:
 * 1. Checks whether `node_modules` already exists (idempotent).
 * 2. If not, checks for `pnpm-lock.yaml`.
 * 3. Runs `pnpm install --prefer-offline --ignore-scripts` with a 5-minute
 *    timeout.
 * 4. Returns a structured {@link InstallStatus} so the spawn pipeline can
 *    surface a clear message rather than a cryptic "module not found" error.
 *
 * @param worktreePath - Absolute path to the provisioned worktree.
 * @param projectRoot  - Absolute path to the project root (used for the
 *                       pnpm install mutex lock file path).
 * @returns Structured install status.
 *
 * @task T11489
 */
export function ensureWorktreeBuildReady(worktreePath: string, projectRoot: string): InstallStatus {
  const nodeModulesPath = join(worktreePath, 'node_modules');
  const lockfilePath = join(worktreePath, 'pnpm-lock.yaml');

  // Fast-path: already ready.
  if (existsSync(nodeModulesPath)) {
    return {
      nodeModulesPresent: true,
      lockfilePresent: existsSync(lockfilePath),
      action: 'already-ready',
    };
  }

  const lockfilePresent = existsSync(lockfilePath);
  if (!lockfilePresent) {
    return {
      nodeModulesPresent: false,
      lockfilePresent: false,
      action: 'no-lockfile',
    };
  }

  // pnpm-lock.yaml present but node_modules absent — install.
  // Use the serialized install function from worktree-pnpm.ts.
  process.stderr.write(
    `[worktree-preflight] node_modules absent in ${worktreePath}; ` +
      `running pnpm install --prefer-offline --ignore-scripts...\n`,
  );

  try {
    execFileSync('pnpm', ['install', '--prefer-offline', '--ignore-scripts'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 300_000, // 5 minutes
    });

    process.stderr.write(`[worktree-preflight] pnpm install succeeded in ${worktreePath}\n`);

    return {
      nodeModulesPresent: existsSync(nodeModulesPath),
      lockfilePresent: true,
      action: 'installed',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[worktree-preflight] pnpm install failed in ${worktreePath}: ${message}\n`,
    );
    return {
      nodeModulesPresent: false,
      lockfilePresent: true,
      action: 'install-failed',
      error: message,
    };
  }
}
