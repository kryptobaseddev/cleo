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

import { appendFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import { resolveCleoDir } from '../paths.js';
import {
  describeWorktreeOwner,
  isGitLinkedCheckout,
  linkedWorktreeMainRoot,
} from '../project-scope.js';

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

/** Error code: a whole-store rewrite would land inside a linked worktree (T12708). */
export const E_WT_STORE_REWRITE_REFUSED = 'E_WT_STORE_REWRITE_REFUSED';

/** Error code: a whole-store rewrite of the owning project's store needs confirmation (T12708). */
export const E_WT_STORE_REWRITE_CONFIRM_REQUIRED = 'E_WT_STORE_REWRITE_CONFIRM_REQUIRED';

/** CLI flag that confirms a whole-store rewrite of the owning project's live store. */
export const CONFIRM_OWNER_STORE_FLAG = '--confirm-owner-store';

/**
 * Audit file, under the owning project's `.cleo/audit/`, recording every
 * confirmed owner-store rewrite run from one of its worktrees (T12708).
 */
export const OWNER_STORE_REWRITE_AUDIT_FILE = 'owner-store-rewrite.jsonl';

/** Inputs of {@link ownerStoreRewriteRefusal} and {@link assertOwnerStoreRewriteConfirmed}. */
export interface OwnerStoreRewriteOptions {
  /**
   * Directory the operation was invoked from. Explicit commands receive it
   * from the CLI layer; open-time rewrites pass {@link invocationDirectory}.
   */
  cwd: string;
  /** The operator confirmed overwriting the owning project's live store. */
  confirmOwnerStore?: boolean | undefined;
  /**
   * The rewrite runs implicitly when a store opens (auto-recovery, exodus
   * first-open migration, lineage rebuild, upgrade storage migration). It
   * targets the owning project's store exactly as it would from the project
   * root, so it needs no confirmation there: only a worktree-resident target
   * is refused, and a run from a worktree is audited. Unreleased worktree
   * builds are stopped separately by the T12687 schema-write guard.
   */
  openTime?: boolean | undefined;
}

/** One row of {@link OWNER_STORE_REWRITE_AUDIT_FILE}. */
export interface OwnerStoreRewriteAuditRow {
  /** ISO-8601 time of the rewrite. */
  timestamp: string;
  /** Operation label, e.g. `restore` or `backup recover tasks`. */
  operation: string;
  /** `confirmed` by {@link CONFIRM_OWNER_STORE_FLAG}, or an `open-time` rewrite. */
  trigger: 'confirmed' | 'open-time';
  /** Linked worktree the operation was run from. */
  worktree: string;
  /** Store file or `.cleo/` directory that was overwritten. */
  store: string;
  /** Invocation directory. */
  cwd: string;
  /** Process id of the writer. */
  pid: number;
}

/**
 * The directory an open-time store rewrite was invoked from.
 *
 * Open-time rewrites receive the caller's optional `cwd`, the same value the
 * store path was resolved from; when it is absent the store was resolved from
 * the process directory, so that is the invocation directory.
 *
 * @param cwd - The caller's optional working directory.
 * @returns The absolute invocation directory.
 * @example
 * ```ts
 * invocationDirectory(undefined); // the process directory
 * ```
 * @task T12708
 */
export function invocationDirectory(cwd: string | undefined): string {
  return resolve(cwd ?? process.cwd()); // CWD-OK: the invocation dir is the subject — the same default the store path was resolved from (T12708)
}

function sameDirectory(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** The project root and `.cleo/` directory a store target lives in, or null. */
function projectStoreOf(target: string): { root: string; cleoDir: string } | null {
  const abs = resolve(target);
  const cleoDir = basename(abs) === '.cleo' ? abs : dirname(abs);
  if (basename(cleoDir) !== '.cleo') return null;
  return { root: dirname(cleoDir), cleoDir };
}

/** The linked worktree `cwd` sits in when that worktree's owner is `storeRoot`, else null. */
function ownedFromWorktree(storeRoot: string, cwd: string): string | null {
  const checkout = enclosingCheckout(cwd);
  if (checkout === null || !isGitLinkedCheckout(checkout)) return null;
  const owner = linkedWorktreeMainRoot(checkout);
  return owner !== null && sameDirectory(owner, storeRoot) ? checkout : null;
}

/**
 * Decide whether a whole-store rewrite (restore, recovery, import, rebuild,
 * migration) of a project store may run (T12680, T12708). Every whole-store
 * rewrite shares this decision and its messages.
 *
 * - A target inside a linked worktree is refused: CLEO never reads a
 *   worktree-resident store (T12460), so the rewrite would be lost.
 * - The owning project's store, reached from one of its worktrees by an
 *   explicit command, needs {@link CONFIRM_OWNER_STORE_FLAG}: path resolution
 *   sent the operation to that LIVE store, so the operator must say they mean
 *   it. An open-time rewrite ({@link OwnerStoreRewriteOptions.openTime}) is
 *   allowed there.
 * - Anything else (not a `<root>/.cleo` store, not run from a worktree, or a
 *   store the worktree does not own) is allowed.
 *
 * @param operation - Label naming the rewrite in the message and audit row.
 * @param target - Store file (`<root>/.cleo/cleo.db`) or `.cleo/` directory.
 * @param opts - Invocation directory and confirmation.
 * @returns The refusal, or null when the rewrite may proceed. Never writes.
 * @example
 * ```ts
 * ownerStoreRewriteRefusal('restore', '/home/u/p/.cleo', { cwd: '/wt/T1' }); // CleoError
 * ```
 * @task T12708
 */
export function ownerStoreRewriteRefusal(
  operation: string,
  target: string,
  opts: OwnerStoreRewriteOptions,
): CleoError | null {
  const store = projectStoreOf(target);
  if (store === null) return null;
  const storeCheckout = enclosingCheckout(store.root);
  if (storeCheckout !== null && isGitLinkedCheckout(storeCheckout)) {
    return new CleoError(
      ExitCode.CONFIG_ERROR,
      `${E_WT_STORE_REWRITE_REFUSED}: ${operation} run from git worktree ${storeCheckout} would write ${target}, a store CLEO never reads — ${describeWorktreeOwner(storeCheckout)}.`,
      {
        fix: 'Run it from an initialised CLEO project (see the owning repository above); nothing was written.',
      },
    );
  }
  if (opts.confirmOwnerStore === true || opts.openTime === true) return null;
  const worktree = ownedFromWorktree(store.root, opts.cwd);
  if (worktree === null) return null;
  return new CleoError(
    ExitCode.CONFIG_ERROR,
    `${E_WT_STORE_REWRITE_CONFIRM_REQUIRED}: ${operation} run from git worktree ${worktree} would overwrite the LIVE store ${target}; this worktree's ${describeWorktreeOwner(worktree)}.`,
    {
      fix: `Re-run with ${CONFIRM_OWNER_STORE_FLAG} to overwrite ${target}, or run it from ${store.root}. Nothing was written.`,
    },
  );
}

/**
 * Enforce {@link ownerStoreRewriteRefusal} and audit a confirmed overwrite.
 *
 * When the rewrite targets the owning project's store from one of its
 * worktrees (confirmed, or an open-time rewrite), a row naming the worktree,
 * store, operation and trigger is appended to `<owner>/.cleo/audit/`
 * {@link OWNER_STORE_REWRITE_AUDIT_FILE} before anything is written. A failed
 * audit write refuses the rewrite (the error propagates).
 *
 * @param operation - Label naming the rewrite in the message and audit row.
 * @param target - Store file (`<root>/.cleo/cleo.db`) or `.cleo/` directory.
 * @param opts - Invocation directory and confirmation.
 * @throws `CleoError` {@link E_WT_STORE_REWRITE_REFUSED} or
 *   {@link E_WT_STORE_REWRITE_CONFIRM_REQUIRED}.
 * @example
 * ```ts
 * assertOwnerStoreRewriteConfirmed('backup recover tasks', '/home/u/p/.cleo/cleo.db', {
 *   cwd: '/wt/T1',
 *   confirmOwnerStore: true,
 * }); // appends an audit row, returns
 * ```
 * @task T12708
 */
export function assertOwnerStoreRewriteConfirmed(
  operation: string,
  target: string,
  opts: OwnerStoreRewriteOptions,
): void {
  const refusal = ownerStoreRewriteRefusal(operation, target, opts);
  if (refusal !== null) throw refusal;
  const store = projectStoreOf(target);
  if (store === null) return;
  const worktree = ownedFromWorktree(store.root, opts.cwd);
  if (worktree === null) return;
  const row: OwnerStoreRewriteAuditRow = {
    timestamp: new Date().toISOString(),
    operation,
    trigger: opts.openTime === true ? 'open-time' : 'confirmed',
    worktree,
    store: target,
    cwd: resolve(opts.cwd),
    pid: process.pid,
  };
  const auditDir = join(store.cleoDir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  appendFileSync(join(auditDir, OWNER_STORE_REWRITE_AUDIT_FILE), `${JSON.stringify(row)}\n`);
}

/**
 * Guard a manual restore (`cleo restore backup`, `admin.backup` restore) that
 * is run from inside a linked git worktree (T12680): the shared whole-store
 * rewrite guard ({@link assertOwnerStoreRewriteConfirmed}) with the project's
 * `.cleo/` as the target.
 *
 * @param storeRoot - Project root whose `.cleo/` the restore writes.
 * @param opts - `cwd` the restore was invoked from (required: core never
 *   falls back to `process.cwd()`; the CLI layer supplies it), and
 *   `confirmOwnerStore` to allow overwriting the owner's live store.
 * @throws `CleoError` {@link E_WT_STORE_REWRITE_REFUSED} when the store lies
 *   inside a worktree, or {@link E_WT_STORE_REWRITE_CONFIRM_REQUIRED} when
 *   confirmation is missing.
 * @example
 * ```ts
 * assertRestoreTargetConfirmed('/home/u/project', { cwd: '/data/cleo/worktrees/abc/T1' }); // throws
 * ```
 * @task T12680
 * @task T12708
 */
export function assertRestoreTargetConfirmed(
  storeRoot: string,
  opts: { cwd: string; confirmOwnerStore?: boolean | undefined },
): void {
  assertOwnerStoreRewriteConfirmed('restore', join(storeRoot, '.cleo'), opts);
}
