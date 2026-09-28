/**
 * Worktree creation operation for @cleocode/worktree.
 *
 * Creates a git worktree at the canonical XDG path per D029:
 *   `~/.local/share/cleo/worktrees/<projectHash>/<taskId>/`
 *
 * Also:
 *   - Applies git worktree lock to prevent accidental pruning.
 *   - Runs declarative `post-create` hooks (D030 native lift).
 *   - Applies `.cleo/worktree-include` patterns (D030 native lift).
 *   - Constructs the agent env-var block and prompt preamble.
 *
 * @task T1161
 */

import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CreateWorktreeOptions,
  CreateWorktreeResult,
  WorktreeHook,
  WorktreeHookResult,
  WorktreeLockAcquisition,
} from '@cleocode/contracts';

/**
 * Extended result type including the bootstrap field.
 *
 * The contracts package will be updated separately to add this field to
 * {@link CreateWorktreeResult}; this local extension allows the implementation
 * to compile in the interim.
 */
interface CreateWorktreeResultWithBootstrap extends CreateWorktreeResult {
  bootstrap: {
    copiedPaths: string[];
    failedPaths: string[];
    hookResults: WorktreeHookResult[];
  };
  /** Glob patterns actually excluded via sparse-checkout (T9226). */
  appliedExcludePatterns: string[];
  /**
   * The sparse-checkout scope applied to the worktree (T9807), or `null` when
   * no scope was requested or the operation failed.
   */
  appliedScope: string | null;
}

import { BRANCH_LOCK_ERROR_CODES } from '@cleocode/contracts';
import { getCleoWorktreesRoot } from '@cleocode/paths';
import { countUnmergedCommits, getGitRoot, gitSilent, gitSync, resolveHeadRef } from './git.js';
import {
  computeProjectHash,
  resolveTaskWorktreePath,
  resolveWorktreeRootForHash,
} from './paths.js';
import { addWorktreeToSentinelIndex, appendWorktreeAuditLog } from './worktree-audit.js';
import { acquireWorktreeTaskLock, releaseWorktreeTaskLock } from './worktree-lock.js';
import { assertNoWorktreeConfigLeak, ensureWorktreeBuildReady } from './worktree-preflight.js';

/**
 * Assert that `targetPath` sits inside the canonical XDG worktrees root
 * (`<cleoHome>/worktrees/`). Throws `E_WT_LOCATION_FORBIDDEN` if not.
 *
 * Per AC4 / council verdict D009: there is NO escape hatch — not even a
 * `CLEO_FORCE_LOCATION` env var. Worktrees outside the canonical location
 * are unconditionally rejected.
 *
 * @param targetPath - Absolute path that will be passed to `git worktree add`.
 * @throws Error with code `E_WT_LOCATION_FORBIDDEN` when outside canonical root.
 *
 * @task T9809
 */
function assertCanonicalWorktreeLocation(targetPath: string): void {
  const canonicalRoot = getCleoWorktreesRoot();
  // Normalise both paths to use forward slashes and ensure the root ends with
  // a separator so we don't accidentally match a sibling path that shares a
  // prefix (e.g. `/cleo-home/worktrees-other/` vs `/cleo-home/worktrees/`).
  const normalRoot = canonicalRoot.endsWith('/') ? canonicalRoot : `${canonicalRoot}/`;
  const normalTarget = targetPath.replaceAll('\\', '/');
  const normalRootFwd = normalRoot.replaceAll('\\', '/');

  if (!normalTarget.startsWith(normalRootFwd)) {
    throw Object.assign(
      new Error(
        `E_WT_LOCATION_FORBIDDEN: worktree path "${targetPath}" is outside the ` +
          `canonical XDG location "${canonicalRoot}". ` +
          `All worktrees MUST live under <cleoHome>/worktrees/<projectHash>/<taskId>/. ` +
          `There is no override — see Saga T9800 SG-WORKTREE-CANON and ADR decision D009.`,
      ),
      { code: 'E_WT_LOCATION_FORBIDDEN', targetPath, canonicalRoot },
    );
  }
}

import { runWorktreeHooks } from './worktree-hooks.js';
import { applyIncludePatterns, loadWorktreeIncludePatterns } from './worktree-include.js';
import { installWorktreeDependencies } from './worktree-pnpm.js';

/**
 * Apply the T9226 spawn-clone-exclude filter to a newly created worktree.
 *
 * Enables git sparse-checkout in no-cone mode so individual file globs can
 * be excluded. Failures are silently swallowed.
 *
 * @task T9226
 */
function applySpawnCloneExcludeFilter(
  worktreePath: string,
  excludePatterns: readonly string[],
): string[] {
  if (excludePatterns.length === 0) return [];
  try {
    const rules = ['/*', '/**', ...excludePatterns.map((p) => `!${p}`)];
    gitSilent(['sparse-checkout', 'init', '--no-cone'], worktreePath);
    gitSilent(['sparse-checkout', 'set', '--no-cone', ...rules], worktreePath);
    return [...excludePatterns];
  } catch {
    return [];
  }
}

/**
 * Apply T9807 cone-mode sparse-checkout to limit the worktree to a scope
 * directory prefix (e.g. `packages/cleo`).
 *
 * Uses `git sparse-checkout init --cone` followed by
 * `git sparse-checkout set <scope>` — cone mode gives the fastest checkout
 * performance by working at directory granularity instead of arbitrary globs.
 *
 * Failures are silently swallowed — the worktree stays in full-checkout mode
 * when the operation is not supported by the installed git version.
 *
 * @param worktreePath - Absolute path to the newly created worktree.
 * @param scope - Directory prefix to check out (e.g. `packages/cleo`).
 * @returns The applied scope string, or `null` when the operation failed.
 *
 * @task T9807
 */
function applySpawnScope(worktreePath: string, scope: string): string | null {
  if (!scope.trim()) return null;
  try {
    gitSilent(['sparse-checkout', 'init', '--cone'], worktreePath);
    gitSilent(['sparse-checkout', 'set', scope.trim()], worktreePath);
    return scope.trim();
  } catch {
    return null;
  }
}

/**
 * POSIX single-quote one shell word: wrap it in `'...'` and rewrite each
 * embedded `'` as `'\''`. The result is one literal word for any input — no
 * word splitting, parameter, command or glob expansion — so a copy-pasted
 * `cd` into a worktree under `Application Support` parses (T12528).
 *
 * @param value - Raw path.
 * @returns The single-quoted shell word.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Parse `git worktree list --porcelain` into one record per worktree.
 *
 * @param gitRoot - Repository root.
 * @returns Entries with their realpath-normalised path and `locked` flag.
 */
function listRegisteredWorktrees(gitRoot: string): Array<{ path: string; locked: boolean }> {
  let out: string;
  try {
    out = gitSync(['worktree', 'list', '--porcelain'], gitRoot);
  } catch {
    return [];
  }
  const entries: Array<{ path: string; locked: boolean }> = [];
  for (const block of out.split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const head = lines.find((l) => l.startsWith('worktree '));
    if (!head) continue;
    entries.push({
      path: realpathOrSelf(head.slice('worktree '.length)),
      locked: lines.some((l) => l === 'locked' || l.startsWith('locked ')),
    });
  }
  return entries;
}

/** `realpathSync` that falls back to the input for a missing path. */
function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * True when `worktreePath` is a worktree git knows about in `gitRoot`
 * (T12506: the only kind of existing directory `createWorktree` re-attaches).
 */
function isRegisteredWorktree(gitRoot: string, worktreePath: string): boolean {
  const target = realpathOrSelf(worktreePath);
  return listRegisteredWorktrees(gitRoot).some((e) => e.path === target);
}

/** True when git already holds a `git worktree lock` on `worktreePath`. */
function isGitLockedWorktree(gitRoot: string, worktreePath: string): boolean {
  const target = realpathOrSelf(worktreePath);
  return listRegisteredWorktrees(gitRoot).some((e) => e.path === target && e.locked);
}

/**
 * Free the branch NAME `branch` so it can be recreated, without losing any
 * commit that is not on the mainline (T12506).
 *
 * - Branch fully merged into the mainline → `git branch -D` (nothing is lost).
 * - Otherwise → `git branch -m` to `cleo/preserved/<branch>/<utc-stamp>-<random>`.
 *   The random suffix keeps two resets in the same second from colliding. A
 *   failed rename THROWS — it never falls through to `branch -D`.
 *
 * @throws Error when the branch name could not be freed (the caller must not proceed).
 */
function discardBranchName(gitRoot: string, branch: string, fallbackRef: string): void {
  if (countUnmergedCommits(gitRoot, branch, [fallbackRef]) === 0) {
    gitSync(['branch', '-D', branch], gitRoot);
    return;
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, 'Z');
  const preserved = `cleo/preserved/${branch}/${stamp}-${randomBytes(4).toString('hex')}`;
  gitSync(['branch', '-m', branch, preserved], gitRoot);
  process.stderr.write(
    `[worktree] preserved unmerged history of ${branch} as ${preserved} (never deleted)\n`,
  );
}

/**
 * Create a git worktree for an agent task.
 *
 * Steps:
 * 1. Resolve paths and project hash from the project root.
 * 2. Remove stale worktree at the same path if it exists (dirty worktrees are preserved).
 * 3. If `task/<taskId>` branch already exists (leftover from a prior aborted
 *    spawn), attach to it via `git worktree add <path> <branch>` (no `-b`).
 *    Otherwise create a new branch via `git worktree add -b <branch> <path> <baseRef>`.
 * 4. Optionally apply `git worktree lock` to prevent pruning.
 * 5. Run declarative `post-create` hooks.
 * 6. Apply `.worktreeinclude` (or legacy `.cleo/worktree-include`) glob patterns —
 *    real ignore::gitignore matching is delegated to `@cleocode/worktree-napi`.
 * 7. NO hardcoded bootstrap copy (T9982). Projects that need node_modules /
 *    packages/* /dist mirrored into the worktree MUST declare them in
 *    `.worktreeinclude` — the multi-language native include file.
 * 8. Run declarative `post-start` hooks.
 * 9. Build and return the {@link CreateWorktreeResult}.
 *
 * Branch-reuse semantics: when a prior spawn aborted after creating the branch
 * but before the worker committed anything, the branch still points to
 * `baseRef`. Reattaching is safe — the worker continues from a clean state.
 * The returned result includes {@link CreateWorktreeResult.reused} so callers
 * can distinguish between a fresh branch and a reattached one if needed.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param options - Options controlling the worktree creation.
 * @returns The created worktree result with env vars and preamble.
 * @throws Error if git worktree add fails.
 *
 * @task T1161
 * @task T1878
 */
export async function createWorktree(
  projectRoot: string,
  options: CreateWorktreeOptions,
): Promise<CreateWorktreeResultWithBootstrap> {
  const { taskId, hooks = [], lockWorktree = true } = options;
  const applyInclude = options.applyIncludePatterns !== false;

  const gitRoot = getGitRoot(projectRoot);
  const projectHash = computeProjectHash(projectRoot);
  const worktreeRoot = resolveWorktreeRootForHash(projectHash);
  mkdirSync(worktreeRoot, { recursive: true });

  const branch = options.branchName ?? `task/${taskId}`;
  const baseRef = options.baseRef ?? resolveHeadRef(gitRoot);
  const worktreePath = resolveTaskWorktreePath(projectHash, taskId);

  // AC1 / T9809: reject any path outside the canonical XDG worktrees root.
  // This check runs BEFORE any filesystem mutation so the error is always clean.
  // There is NO escape hatch — per council verdict D009 the ban is absolute.
  assertCanonicalWorktreeLocation(worktreePath);

  // T11489 — DHQ-037/019: detect and auto-heal a leaked core.worktree key in
  // .git/config BEFORE any git worktree add. A stale `.claude/worktrees/<id>/`
  // pointer can leave core.worktree set to a deleted path, causing every
  // subsequent git worktree add to fail with the cryptic "must be run in a
  // work tree" error. This call is idempotent — when no leak is present it
  // returns immediately with no side-effects.
  assertNoWorktreeConfigLeak(gitRoot);

  // T12506 — take the per-task lock BEFORE touching the worktree or branch.
  // Two concurrent spawns of one task used to both pass the check-then-act
  // below; the loser force-removed the winner's live worktree. A live holder
  // now gets E_WORKTREE_LOCKED naming it; a provably dead or stale holder's
  // lock is reclaimed.
  const lock = acquireWorktreeTaskLock({
    projectHash,
    taskId,
    ...(options.holder ? { holder: options.holder } : {}),
    ...(options.lockTtlMs !== undefined ? { ttlMs: options.lockTtlMs } : {}),
  });
  const ctx: ProvisionContext = {
    gitRoot,
    projectHash,
    branch,
    baseRef,
    worktreePath,
    hooks,
    lockWorktree,
    applyInclude,
    lock,
    freshWorktreeCreated: false,
  };
  try {
    return await provisionUnderLock(projectRoot, options, ctx);
  } catch (err) {
    releaseWorktreeTaskLock(projectHash, taskId, lock.record.token);
    // T12506: tell callers whether THIS call created the worktree directory.
    // Only then may they clean it up; any other failure left a pre-existing
    // (possibly live) worktree that must never be destroyed.
    if (err !== null && typeof err === 'object') {
      Object.assign(err, { freshWorktreeCreated: ctx.freshWorktreeCreated });
    }
    throw err;
  }
}

/** Resolved inputs shared by {@link createWorktree} and {@link provisionUnderLock}. */
interface ProvisionContext {
  gitRoot: string;
  projectHash: string;
  branch: string;
  baseRef: string;
  worktreePath: string;
  hooks: WorktreeHook[];
  lockWorktree: boolean;
  applyInclude: boolean;
  lock: WorktreeLockAcquisition;
  /** Set once `git worktree add` created the directory in THIS call. */
  freshWorktreeCreated: boolean;
}

/**
 * Everything `createWorktree` does once the per-task lock is held.
 *
 * T12506 invariants:
 * - An existing worktree directory is NEVER force-removed. When it is a
 *   registered worktree of this repository it is re-attached as-is
 *   (`reused: true`) — no checkout, include copy, hook or install touches
 *   its files, because its previous (now dead or stale) holder may have left
 *   uncommitted, gitignored or unmerged work in it.
 * - A task branch that carries commits not on the mainline (`origin/main`,
 *   else `baseRef`) is never `branch -D`'d; `forceReset` renames it to a
 *   `cleo/preserved/...` ref instead.
 *
 * @internal
 */
async function provisionUnderLock(
  projectRoot: string,
  options: CreateWorktreeOptions,
  ctx: ProvisionContext,
): Promise<CreateWorktreeResultWithBootstrap> {
  const { taskId } = options;
  const { gitRoot, projectHash, branch, baseRef, worktreePath, hooks, lockWorktree, lock } = ctx;
  const { applyInclude } = ctx;

  let reused: boolean;
  let reattached = false;
  if (existsSync(worktreePath)) {
    if (!isRegisteredWorktree(gitRoot, worktreePath)) {
      throw Object.assign(
        new Error(
          `${BRANCH_LOCK_ERROR_CODES.E_WORKTREE_INVALID}: "${worktreePath}" exists but is not a ` +
            `registered git worktree of ${gitRoot}. It is left untouched because it may hold ` +
            `agent work; inspect it, move it aside, then re-run the spawn.`,
        ),
        { code: BRANCH_LOCK_ERROR_CODES.E_WORKTREE_INVALID, worktreePath },
      );
    }
    process.stderr.write(
      `[worktree] re-attaching existing worktree at ${worktreePath} (lock ${lock.status}` +
        `${lock.reclaimReason ? `: previous holder ${lock.reclaimReason}` : ''}); nothing removed\n`,
    );
    reused = true;
    reattached = true;
  } else {
    // Check whether the branch already exists without a worktree directory.
    // This happens when a prior spawn created the branch but the worktree
    // directory was cleaned up (e.g. aborted after `git worktree add` but
    // before the agent ran). Attaching to the existing branch avoids the
    // "branch already exists" error from `git worktree add -b`.
    // `git branch --list <branch>` exits 0 regardless; non-empty output means
    // the branch exists.
    const branchExists = gitSync(['branch', '--list', branch], gitRoot).trim() !== '';

    if (branchExists) {
      // T1927: detect orphan history — commits on task/<taskId> that are not
      // reachable from baseRef. Merging such a branch would import garbage
      // history into the integration base.
      const orphanLog = gitSync(['log', '--format=%H', `${baseRef}..${branch}`], gitRoot).trim();
      const orphanCommits = orphanLog
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);

      if (orphanCommits.length > 0) {
        if (options.forceReset) {
          // T12506: never `branch -D` history that is not on the mainline —
          // move it aside to a preserved ref, then recreate from baseRef.
          discardBranchName(gitRoot, branch, baseRef);
          gitSync(['worktree', 'add', '-b', branch, worktreePath, baseRef], gitRoot);
          ctx.freshWorktreeCreated = true;
          reused = false;
        } else {
          throw Object.assign(
            new Error(
              `${BRANCH_LOCK_ERROR_CODES.E_DIRTY_BRANCH}: branch "${branch}" has ` +
                `${orphanCommits.length} commit(s) not reachable from "${baseRef}". ` +
                `This indicates orphan history from a test fixture or prior session. ` +
                `Inspect the branch, or pass { forceReset: true } to createWorktree to move ` +
                `it aside to a preserved ref and start fresh.`,
            ),
            { code: BRANCH_LOCK_ERROR_CODES.E_DIRTY_BRANCH, orphanCommits },
          );
        }
      } else {
        // Branch exists but is clean (points to baseRef or an ancestor) — safe to reuse.
        gitSync(['worktree', 'add', worktreePath, branch], gitRoot);
        ctx.freshWorktreeCreated = true;
        reused = true;
      }
    } else {
      // Create the worktree with a new branch.
      gitSync(['worktree', 'add', '-b', branch, worktreePath, baseRef], gitRoot);
      ctx.freshWorktreeCreated = true;
      reused = false;
    }
  }

  // Apply git worktree lock to prevent accidental pruning.
  let locked = reattached && isGitLockedWorktree(gitRoot, worktreePath);
  if (lockWorktree && !locked) {
    // Try with --reason (git >= 2.37), fall back without.
    if (
      gitSilent(['worktree', 'lock', '--reason', `cleo-agent-${taskId}`, worktreePath], gitRoot)
    ) {
      locked = true;
    } else if (gitSilent(['worktree', 'lock', worktreePath], gitRoot)) {
      locked = true;
    }
  }

  const createdAt = new Date().toISOString();

  // T9226 — spawn-clone-exclude filter: hide files matching the exclude
  // patterns from the worktree via sparse-checkout. Best-effort.
  const excludePatterns = options.spawnCloneExclude ?? [];
  // T12506: a re-attached worktree is left exactly as its holder left it —
  // no sparse-checkout, hooks, include copies or installs touch its files.
  const appliedExcludePatterns =
    !reattached && excludePatterns.length > 0
      ? applySpawnCloneExcludeFilter(worktreePath, excludePatterns)
      : [];

  // T9807 — spawn scope: limit the worktree to a directory prefix via cone-mode
  // sparse-checkout (e.g. `packages/cleo` for a CLI-only task). Best-effort;
  // falls back to full checkout when the operation fails or is not supported.
  // Only applied when no exclude-patterns sparse-checkout is already active to
  // avoid conflicting sparse-checkout modes.
  const spawnScope = options.spawnScope ?? null;
  const appliedScope =
    !reattached && spawnScope && appliedExcludePatterns.length === 0
      ? applySpawnScope(worktreePath, spawnScope)
      : null;

  // Run post-create hooks before returning the handle.
  const postCreateHookResults = reattached
    ? []
    : await runWorktreeHooks(hooks, 'post-create', worktreePath);

  // Apply .worktreeinclude (or legacy .cleo/worktree-include) patterns.
  // The matcher in @cleocode/worktree-napi uses real ignore::gitignore
  // semantics — the prior existsSync-on-literal-pattern bug is gone.
  //
  // T9982 — REMOVED: hardcoded ['node_modules', 'packages/*/dist'] copy block.
  // Projects MUST declare the paths they want mirrored into worktrees via
  // .worktreeinclude. The default with no file is: copy nothing. This avoids
  // the pnpm-monorepo-only 1.9 GB / 69k-file blast radius the hardcoded list
  // imposed on every spawn (the 60s timeout root cause).
  let appliedPatterns: ReturnType<typeof applyIncludePatterns> = [];
  if (applyInclude && !reattached) {
    const patterns = loadWorktreeIncludePatterns(projectRoot);
    appliedPatterns = applyIncludePatterns(patterns, projectRoot, worktreePath);
  }

  // T11033 — Copy project-info.json from parent project .cleo/ into the worktree
  // .cleo/ so worktrees can resolve their parent projectId without walking up
  // to the parent project root (which may not be accessible from containerized
  // builds or when the XDG worktree path is outside the parent repo tree).
  const parentProjectInfoPath = join(projectRoot, '.cleo', 'project-info.json');
  if (!reattached && existsSync(parentProjectInfoPath)) {
    const worktreeCleoDir = join(worktreePath, '.cleo');
    mkdirSync(worktreeCleoDir, { recursive: true });
    const worktreeProjectInfoPath = join(worktreeCleoDir, 'project-info.json');
    copyFileSync(parentProjectInfoPath, worktreeProjectInfoPath);

    // T11035 — Verify worktree identity: project-info.json projectId matches parent.
    // Read back both files and compare the projectId field. If they don't match,
    // the spawn is invalid and the worktree must be unwound.
    try {
      const parentInfo = JSON.parse(readFileSync(parentProjectInfoPath, 'utf-8')) as Record<
        string,
        unknown
      >;
      const worktreeInfo = JSON.parse(readFileSync(worktreeProjectInfoPath, 'utf-8')) as Record<
        string,
        unknown
      >;
      const parentProjectId = typeof parentInfo.projectId === 'string' ? parentInfo.projectId : '';
      const worktreeProjectId =
        typeof worktreeInfo.projectId === 'string' ? worktreeInfo.projectId : '';

      if (parentProjectId && parentProjectId !== worktreeProjectId) {
        // Identity mismatch — the worktree doesn't belong to this project.
        // Unwind the worktree before returning an error to the caller.
        try {
          gitSilent(['worktree', 'unlock', worktreePath], gitRoot);
          gitSilent(['worktree', 'remove', '--force', worktreePath], gitRoot);
        } catch {
          /* best-effort unwind */
        }
        try {
          rmSync(worktreePath, { recursive: true, force: true });
        } catch {
          /* directory may already be gone */
        }

        throw Object.assign(
          new Error(
            `E_WT_IDENTITY_MISMATCH: worktree projectId "${worktreeProjectId}" ` +
              `does not match parent projectId "${parentProjectId}". ` +
              `The worktree .cleo/project-info.json is corrupt or copied from a different project.`,
          ),
          { code: 'E_WT_IDENTITY_MISMATCH', parentProjectId, worktreeProjectId },
        );
      }
    } catch (err: unknown) {
      if (
        err &&
        typeof err === 'object' &&
        (err as { code?: string }).code === 'E_WT_IDENTITY_MISMATCH'
      ) {
        throw err;
      }
      // JSON parse or read errors are non-fatal — the copy succeeded at the
      // filesystem level and the consumer can still read it.
    }
  }

  // Bootstrap fields preserved for envelope compatibility
  // include-pattern symlink phase above. The copy-on-write hot path is no
  // longer auto-invoked from createWorktree; callers that need explicit
  // copying should call copyPathsWithReflock directly.
  const copiedPaths: string[] = [];
  const failedPaths: string[] = [];

  // T9938 — Install dependencies with serialized pnpm lock to prevent
  // @@-prefixed doubled-directory corruption in .pnpm/ when multiple
  // worktrees are provisioned concurrently. Only runs when pnpm-lock.yaml
  // was included via .worktreeinclude (i.e. the project uses pnpm).
  // Uses per-worktree pnpm store (.pnpm-store/) for full isolation.
  if (reattached) {
    // T12506: never install into (or otherwise mutate) a re-attached worktree.
  } else if (appliedPatterns.some((p) => p.pattern === 'pnpm-lock.yaml')) {
    const installed = installWorktreeDependencies(worktreePath, gitRoot);
    if (installed) {
      copiedPaths.push('node_modules/ (pnpm install)');
    } else {
      failedPaths.push('pnpm install');
    }
  } else {
    // T11489 — DHQ-019: guarantee build-ready even when .worktreeinclude does
    // not list pnpm-lock.yaml. ensureWorktreeBuildReady is a best-effort pass
    // that detects pnpm-lock.yaml in the worktree and auto-installs rather than
    // leaving the worktree non-functional. The structured InstallStatus is
    // captured in copiedPaths/failedPaths for the spawn envelope.
    const installStatus = ensureWorktreeBuildReady(worktreePath, gitRoot);
    if (installStatus.action === 'installed') {
      copiedPaths.push('node_modules/ (pnpm install — auto build-ready)');
    } else if (installStatus.action === 'install-failed') {
      failedPaths.push(`pnpm install (auto build-ready): ${installStatus.error ?? 'unknown'}`);
    }
    // 'already-ready' and 'no-lockfile' require no action on copiedPaths/failedPaths.
  }

  // Run post-start hooks after copy-on-write bootstrap.
  const postStartHookResults = reattached
    ? []
    : await runWorktreeHooks(hooks, 'post-start', worktreePath);

  // Build env vars for agent spawn.
  const currentPath = process.env['PATH'] ?? '';
  const shimDir = join(projectRoot, '.cleo', 'bin', 'git-shim');
  const envVars: Record<string, string> = {
    CLEO_AGENT_ROLE: 'worker',
    CLEO_AGENT_CWD: worktreePath,
    CLEO_WORKTREE_ROOT: worktreePath,
    CLEO_WORKTREE_BRANCH: branch,
    CLEO_PROJECT_HASH: projectHash,
    CLEO_BRANCH_PROTECTION: 'strict',
    CLEO_SHIM_MARKER: '.cleo/bin/git-shim',
    PATH: `${shimDir}:${currentPath}`,
  };

  // Build the preamble text for agent context isolation (per acceptance criterion).
  const preamble = [
    '## BRANCH ISOLATION PROTOCOL (MANDATORY)',
    '',
    `CLEO_AGENT_CWD=${worktreePath}`,
    '',
    `FIRST ACTION: cd ${shellQuote(worktreePath)}`,
    '',
    `You are working on branch: ${branch}`,
    'You MUST NOT run any of these git commands:',
    '  git checkout, git switch, git branch -b/-D, git reset --hard,',
    '  git worktree add/remove, git rebase, git stash pop, git push --force',
    '',
    'A git shim is active on your PATH that will exit 77 if you attempt these.',
    `Your working directory is: ${worktreePath}`,
    `You are authorized only within \`${worktreePath}\``,
    'All your commits must land on YOUR branch only.',
    '',
  ].join('\n');

  // T9805 AC3: Append audit log entry for every worktree creation.
  appendWorktreeAuditLog(projectRoot, {
    action: reused ? 'adopt' : 'create',
    xdgPath: worktreePath,
    taskId,
    branch,
    reason: reattached ? 'worktree-reattach' : reused ? 'branch-reuse' : 'spawn',
    success: true,
  });

  // T9805 D009: Register this worktree in the sentinel index.
  addWorktreeToSentinelIndex(gitRoot, taskId, { path: worktreePath, branch, createdAt });

  return {
    path: worktreePath,
    branch,
    baseRef,
    taskId,
    projectHash,
    createdAt,
    locked,
    reused,
    lock,
    envVars,
    preamble,
    hookResults: postCreateHookResults,
    appliedPatterns,
    appliedExcludePatterns,
    appliedScope,
    bootstrap: {
      copiedPaths,
      failedPaths,
      hookResults: postStartHookResults,
    },
  };
}
