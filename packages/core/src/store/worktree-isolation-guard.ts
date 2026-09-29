/**
 * Worktree-isolation guard for CLEO DB opens (T9806 / T9961 / T12460 · council verdict D009).
 *
 * Extracted into a standalone leaf module so it can be imported by
 * `open-cleo-db.ts`, `sqlite.ts` (where `getDb()` lives) and `dual-scope-db.ts`
 * (the physical open chokepoint) without creating a circular import cycle.
 *
 * T12460 moved the check onto the path actually being opened. The original
 * guard re-derived a `.cleo/` directory through `getCleoDirAbsolute`, which
 * follows the gitlink to the parent project, while the store open resolved the
 * worktree's own `.cleo/`. The guard therefore approved a path nobody opened
 * and the worktree silently received its own diverged `cleo.db`.
 *
 * @task T9961 (extraction), T9806 (original guard), T12460 (actual-path check)
 * @saga T9800
 * @decision D009
 */

import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import { resolveCleoDir } from '../paths.js';
import { describeWorktreeOwner, isGitLinkedCheckout } from '../project-scope.js';

/** File name of the consolidated project store under `<root>/.cleo/`. */
const PROJECT_STORE_FILENAME = 'cleo.db';

/**
 * Refuse to open a project-scope store file that lives inside a git worktree.
 *
 * A project store is `<root>/.cleo/<file>`. When `<root>` is a linked git
 * checkout (`.git` is a gitlink FILE), the file is a worktree-resident copy
 * diverged from the parent project's store: writes there never reach the
 * parent and are lost when the worktree is pruned (T12460). Path resolution
 * ({@link resolveCleoDir}) maps CLEO worktrees to their parent, so reaching
 * this guard means the parent could not be resolved or the caller passed an
 * explicit worktree path.
 *
 * Paths whose parent directory is not named `.cleo` (explicit test fixtures,
 * snapshot inspection) are outside the project layout and are not checked.
 *
 * Kill-switch: `CLEO_ALLOW_WORKTREE_DB_CREATE=1` bypasses the guard. The
 * override is recorded on stderr.
 *
 * @param role - DB role label, used in the error message only.
 * @param dbPath - Absolute path of the store file about to be opened.
 * @throws `CleoError('E_WT_DB_ISOLATION_VIOLATION')` when the store's project
 *   root is a linked git checkout and the kill-switch is not set.
 * @example
 * ```ts
 * assertStorePathIsNotWorktreeResident('project', '/wt/T1/.cleo/cleo.db'); // throws
 * ```
 * @task T12460
 */
export function assertStorePathIsNotWorktreeResident(role: string, dbPath: string): void {
  const cleoDir = dirname(dbPath);
  if (basename(cleoDir) !== '.cleo') return;
  const projectRoot = dirname(cleoDir);
  if (!isGitLinkedCheckout(projectRoot)) return;
  if (process.env['CLEO_ALLOW_WORKTREE_DB_CREATE'] === '1') {
    process.stderr.write(
      `[T9806 WT-DB-OVERRIDE] role=${role} path=${dbPath} reason=CLEO_ALLOW_WORKTREE_DB_CREATE=1\n`,
    );
    return;
  }
  // T12677: name the project whose store this worktree must use.
  const owner = describeWorktreeOwner(projectRoot);
  throw new CleoError(
    ExitCode.CONFIG_ERROR,
    `E_WT_DB_ISOLATION_VIOLATION: refusing to open '${role}' DB at ${dbPath} — parent ${projectRoot} is a git worktree (gitlink); ${owner}. DBs must open against the canonical project root.`,
    {
      fix: `Run from the canonical project root, or make sure the worktree's main repository is an initialised CLEO project so it resolves there. Inspect stranded worktree stores with \`cleo doctor worktree-stores\`. Emergency override (audited): CLEO_ALLOW_WORKTREE_DB_CREATE=1.`,
    },
  );
}

/**
 * Worktree-isolation guard for callers that know only a working directory.
 *
 * Resolves the project store path exactly as the open does
 * (`resolveCleoDir(cwd)` + `cleo.db`, the same derivation as
 * `resolveDualScopeDbPath('project', cwd)`) and applies
 * {@link assertStorePathIsNotWorktreeResident} to it.
 *
 * @param role - The DB role label (used in the error message only).
 * @param cwd  - Optional working directory; defaults to `process.cwd()`.
 * @throws `CleoError('E_WT_DB_ISOLATION_VIOLATION')` when the resolved store
 *   lives inside a git worktree and the kill-switch is not set.
 * @example
 * ```ts
 * assertDbPathIsNotWorktreeResident('tasks', process.cwd());
 * ```
 */
export function assertDbPathIsNotWorktreeResident(role: string, cwd?: string): void {
  let cleoDir: string;
  try {
    cleoDir = resolveCleoDir(cwd);
  } catch {
    // Unresolvable project root: let the underlying opener surface the
    // original error with its own context.
    return;
  }
  assertStorePathIsNotWorktreeResident(role, join(cleoDir, PROJECT_STORE_FILENAME));
}

/**
 * The root of the git checkout enclosing `dir`: the nearest ancestor (or `dir`
 * itself) holding a `.git` entry.
 *
 * @param dir - Starting directory.
 * @returns The checkout root, or `null` outside any checkout.
 */
function enclosingCheckout(dir: string): string | null {
  let current = resolve(dir);
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Guard a manual restore (`cleo restore backup`, `admin.backup` restore) that
 * is run from inside a linked git worktree (T12680).
 *
 * Path resolution maps a worktree to its owning project, so a restore run in a
 * worktree overwrites the owning project's LIVE store. That is allowed only
 * with an explicit confirmation naming it. When the owner cannot hold a
 * store (not an initialised CLEO project, or a bare repository) the restore
 * would land in the worktree's own `.cleo/`, which CLEO never reads; that is
 * refused outright.
 *
 * @param storeRoot - Project root whose `.cleo/` the restore writes.
 * @param opts - `cwd` the restore was invoked from (required: core never
 *   falls back to `process.cwd()`; the CLI layer supplies it), and
 *   `confirmOwnerStore` to allow overwriting the owner's live store.
 * @throws `CleoError` `E_WT_RESTORE_REFUSED` when the owner cannot hold the
 *   store, or `E_WT_RESTORE_CONFIRM_REQUIRED` when confirmation is missing.
 * @example
 * ```ts
 * assertRestoreTargetConfirmed('/home/u/project', { cwd: '/data/cleo/worktrees/abc/T1' }); // throws
 * ```
 * @task T12680
 */
export function assertRestoreTargetConfirmed(
  storeRoot: string,
  opts: { cwd: string; confirmOwnerStore?: boolean | undefined },
): void {
  const checkout = enclosingCheckout(opts.cwd);
  const worktree = isGitLinkedCheckout(storeRoot)
    ? storeRoot
    : checkout !== null && isGitLinkedCheckout(checkout)
      ? checkout
      : null;
  if (worktree === null) return;
  const owner = describeWorktreeOwner(worktree);
  const target = join(storeRoot, '.cleo');
  // The store resolved to the worktree itself: its owner is not an
  // initialised project or is a bare repository (named in `owner`).
  if (isGitLinkedCheckout(storeRoot)) {
    throw new CleoError(
      ExitCode.CONFIG_ERROR,
      `E_WT_RESTORE_REFUSED: restore run from git worktree ${worktree} would write ${target}, a store CLEO never reads — ${owner}.`,
      {
        fix: 'Run the restore from an initialised CLEO project (see the owning repository above); nothing was written.',
      },
    );
  }
  if (opts.confirmOwnerStore) return;
  throw new CleoError(
    ExitCode.CONFIG_ERROR,
    `E_WT_RESTORE_CONFIRM_REQUIRED: restore run from git worktree ${worktree} would overwrite the LIVE store ${target}; this worktree's ${owner}.`,
    {
      fix: `Re-run with --confirm-owner-store to overwrite ${target}, or run the restore from ${storeRoot}. Nothing was written.`,
    },
  );
}
