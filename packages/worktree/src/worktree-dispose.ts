/**
 * The one worktree disposal engine (T13924, durability C-F2).
 *
 * Every path that deletes a worktree (complete, cancel, `worktree destroy`,
 * `worktree prune --orphaned`, the merge sweep, gc and the sentient prune)
 * calls {@link disposeWorktree}. It removes a worktree only with proof that
 * nothing in it is lost:
 *
 * - **guard**: nothing outside links into it and no evidence lives only there
 *   ({@link guardWorktreeDisposal}, T13696/T13700);
 * - **not in use**: the caller's in-use probe (a live task lock or claim)
 *   answers `null`; a probe that throws counts as in use;
 * - **content**: no tracked change, and every untracked or ignored path is
 *   either `node_modules`, rebuildable output of a merged checkout, or the
 *   identical tree in the main checkout ({@link unprovenContent});
 * - **commits**: every commit HEAD reaches is also held by a remote ref or by
 *   another local branch ({@link unpreservedCommits}).
 *
 * Every probe fails closed: a git or read error is "not proven", never clean.
 * Without proof the worktree is kept with the failing clause named. With
 * `force` (`cleo worktree destroy --force` only) the unpreserved work is
 * archived first, a ref under `refs/cleo/archive/` plus a patch and a receipt
 * under `<projectRoot>/.cleo/archive/worktrees/`, and the worktree is removed
 * only once the archive is verified.
 *
 * Nothing else in the repository may call the raw removals (arch gate 41,
 * `scripts/lint-no-raw-worktree-removal.mjs`).
 *
 * @task T13924
 * @task T14276
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  type Stats,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import type {
  DisposeWorktreeOptions,
  DisposeWorktreeResult,
  WorktreeArchiveReceipt,
} from '@cleocode/contracts';
import {
  destroyWorktree as napiDestroyWorktree,
  removeDir as napiRemoveDir,
} from './napi-binding.js';
import { computeProjectHash } from './paths.js';
import { describeDisposalBlockers, guardWorktreeDisposal } from './worktree-dependents.js';
import { releaseWorktreeTaskLock } from './worktree-lock.js';

/** Variables that point git at another repository than `-C` names (T14189). */
const GIT_AMBIENT_REPO_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
];

/** The process environment without the variables in {@link GIT_AMBIENT_REPO_VARS}. */
function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of GIT_AMBIENT_REPO_VARS) delete env[key];
  return { ...env, ...extra };
}

/** Run git in `cwd`; untrimmed stdout, or `null` on any failure. */
function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string | null {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      env: env ?? gitEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Content proof (moved from core's worktree/prune.ts, T14142 / T14146)
// ---------------------------------------------------------------------------

/**
 * What one cleanup run may spend proving trees identical (T14146). Shared
 * across every checkout the run inspects; once spent, the rest is unproven.
 */
export interface CompareBudget {
  /** Entries (files, directories, links) still allowed. */
  entries: number;
  /** File bytes still allowed to be read. */
  bytes: number;
}

/**
 * A fresh per-run budget: 200 000 entries and 2 GiB of file bytes.
 *
 * @returns A budget to share across one run's checks.
 */
export function newCompareBudget(): CompareBudget {
  return { entries: 200_000, bytes: 2 * 1024 * 1024 * 1024 };
}

/** A single file larger than this is never read to prove it identical (64 MiB). */
const MAX_COMPARED_FILE_BYTES = 64 * 1024 * 1024;

/** Output directories the build writes, at the root or in a workspace package. */
const REGENERABLE_DIRS = new Set(['dist', '.turbo', 'coverage']);

/**
 * Build output a merged, clean checkout can always rebuild from its source,
 * so losing it loses nothing (T14146): `dist/`, `.turbo/` and `coverage/`
 * (and anything inside them), and `*.tsbuildinfo` files, only where the build
 * writes them: the checkout root or a `packages/<name>/` root. The same name
 * deeper down (`secrets/dist/key.pem`) is not build output and stays strict.
 *
 * @param rel - Path relative to the checkout root, `/`-separated.
 * @returns Whether the path is rebuildable output.
 */
export function isRegenerable(rel: string): boolean {
  const parts = rel.split('/');
  // The output's own root: `dist`, or `packages/<name>/dist`.
  const base = parts[0] === 'packages' ? 2 : 0;
  if (parts.length > base && REGENERABLE_DIRS.has(parts[base] ?? '')) return true;
  return parts.length === base + 1 && rel.endsWith('.tsbuildinfo');
}

/**
 * Whether `a` and `b` hold the same tree: same names, same file bytes, same
 * symlink targets. Symlinks are compared, never followed. Any read error, an
 * oversized file or a spent budget answers `false` (unproven), never throws.
 */
function sameTree(a: string, b: string, budget: CompareBudget): boolean {
  const stack: Array<[string, string]> = [[a, b]];
  try {
    while (stack.length > 0) {
      const [x, y] = stack.pop() as [string, string];
      if (--budget.entries < 0) return false;
      const sx: Stats = lstatSync(x);
      const sy: Stats = lstatSync(y);
      if (sx.isSymbolicLink() || sy.isSymbolicLink()) {
        if (!sx.isSymbolicLink() || !sy.isSymbolicLink() || readlinkSync(x) !== readlinkSync(y)) {
          return false;
        }
      } else if (sx.isFile() && sy.isFile()) {
        if (sx.size !== sy.size || sx.size > MAX_COMPARED_FILE_BYTES) return false;
        budget.bytes -= sx.size * 2;
        if (budget.bytes < 0 || !readFileSync(x).equals(readFileSync(y))) return false;
      } else if (sx.isDirectory() && sy.isDirectory()) {
        const nx = readdirSync(x).sort();
        const ny = readdirSync(y).sort();
        if (nx.length !== ny.length || nx.some((n, i) => n !== ny[i])) return false;
        for (const n of nx) stack.push([join(x, n), join(y, n)]);
      } else {
        return false;
      }
    }
  } catch {
    return false;
  }
  return true;
}

/** How {@link unprovenContent} treats ignored content (T14146). */
export interface UnprovenContentOptions {
  /** Shared per-run comparison budget; a fresh one when omitted. */
  budget?: CompareBudget;
  /** Ignored `node_modules` counts as redundant (worktrees, not repository copies). */
  exemptNodeModules?: boolean;
  /**
   * Ignored build output ({@link isRegenerable}) counts as redundant. Only for
   * a checkout whose commits are merged: its source rebuilds the output.
   */
  exemptRegenerable?: boolean;
}

/** One `git status --porcelain -z --ignored=matching -uall` entry. */
interface StatusEntry {
  /** Two-letter status code (`??` untracked, `!!` ignored). */
  code: string;
  /** Path relative to the checkout root, without a trailing slash. */
  rel: string;
}

/** Every changed, untracked and ignored path of a checkout, or `null` when git fails. */
function statusEntries(path: string): StatusEntry[] | null {
  const out = git(path, ['status', '--porcelain', '-z', '-uall', '--ignored=matching']);
  if (out === null) return null;
  return out
    .split('\0')
    .filter((e) => e.length > 0)
    .map((e) => ({ code: e.slice(0, 2), rel: e.slice(3).replace(/\/$/, '') }));
}

/**
 * What in a checkout is not proven redundant, or `null` when nothing is.
 *
 * Tracked changes never are; untracked content is when the main checkout
 * holds the identical tree at the same path, or (exempt by default) when it
 * is `node_modules`. Ignored content (which
 * `--porcelain` alone never lists: an edited `.env`, an agent's nested
 * `.claude/worktrees/x/`) is redundant only when exempted by `opts`
 * (`node_modules`, merged build output) or when the main checkout holds the
 * identical tree at the same path (what `.worktreeinclude` seeded, unchanged).
 * Fail-closed: a git or read error is unproven.
 *
 * @param path - Checkout root.
 * @param projectRoot - The main checkout seeded copies are compared against.
 * @param opts - Budget and exemptions (default: `node_modules` exempt, nothing else).
 * @returns Why the checkout must be kept, or `null`.
 * @task T14142
 * @task T14146
 */
export function unprovenContent(
  path: string,
  projectRoot: string,
  opts: UnprovenContentOptions = {},
): string | null {
  const budget = opts.budget ?? newCompareBudget();
  const exemptNodeModules = opts.exemptNodeModules !== false;
  const entries = statusEntries(path);
  if (entries === null) return 'git status failed';
  for (const { code, rel } of entries) {
    const untrackedOrIgnored = code === '??' || code === '!!';
    // `node_modules` (a directory, or the symlink a `node_modules/` ignore
    // pattern misses) reinstalls from the lockfile: redundant in a worktree.
    if (untrackedOrIgnored && exemptNodeModules && rel.split('/').includes('node_modules'))
      continue;
    // A tracked change is never redundant; an untracked or ignored path is
    // when the main checkout holds the identical tree (a copied receipt).
    if (code === '??') {
      if (sameTree(join(path, rel), join(projectRoot, rel), budget)) continue;
      return 'uncommitted or untracked changes';
    }
    if (code !== '!!') return 'uncommitted or untracked changes';
    if (opts.exemptRegenerable === true && isRegenerable(rel)) continue;
    if (!sameTree(join(path, rel), join(projectRoot, rel), budget)) {
      return `ignored content not in the main checkout: ${rel}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Commit proof
// ---------------------------------------------------------------------------

/** The checkout's branch (`null` when detached), or `undefined` when git fails. */
function currentBranch(path: string): string | null | undefined {
  const out = git(path, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (out === null) return undefined;
  const name = out.trim();
  return name === 'HEAD' ? null : name;
}

/**
 * Whether the checkout's commits survive its removal, or why not.
 *
 * Every commit HEAD reaches must also be reachable from a remote-tracking ref
 * or from a local branch other than the one checked out here (that branch is
 * the checkout's own and may be deleted with it). An unborn HEAD holds no
 * commits. Fail-closed: any git error is "commits not proven preserved".
 *
 * @param path - Checkout root.
 * @returns Why its commits are not preserved, or `null`.
 * @task T13924
 */
export function unpreservedCommits(path: string): string | null {
  if (git(path, ['rev-parse', '--git-dir']) === null) return 'git cannot read the checkout';
  if (git(path, ['rev-parse', '--verify', '-q', 'HEAD']) === null) return null; // unborn
  const branch = currentBranch(path);
  if (branch === undefined) return 'git cannot read the checked-out branch';
  const not = branch === null ? ['--branches'] : [`--exclude=${branch}`, '--branches'];
  const out = git(path, ['rev-list', '--count', 'HEAD', '--not', ...not, '--remotes']);
  const count = out === null ? Number.NaN : Number.parseInt(out.trim(), 10);
  if (Number.isNaN(count)) return 'git cannot count commits held elsewhere';
  return count === 0 ? null : `${count} commit(s) held by no remote and no other branch`;
}

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

/** Paths `git add -f` must capture: ignored content bar `node_modules` and build output. */
function archivableIgnored(entries: readonly StatusEntry[]): string[] {
  return entries
    .filter((e) => e.code === '!!')
    .map((e) => e.rel)
    .filter((rel) => !rel.split('/').includes('node_modules') && !isRegenerable(rel));
}

/**
 * Archive everything a worktree holds before it is removed (T13924): an
 * archive commit whose parent is HEAD and whose tree is the checkout's
 * tracked, untracked and ignored content (bar `node_modules`, and ignored
 * build output), held by `refs/cleo/archive/<name>/<stamp>`, plus a binary patch from
 * HEAD and a JSON receipt under `<projectRoot>/.cleo/archive/worktrees/`. The
 * worktree's own index and files are not touched (a temporary index is used).
 *
 * @param worktreePath - Checkout to archive.
 * @param gitRoot - Repository the archive ref is written to.
 * @param projectRoot - Main checkout whose `.cleo/archive/worktrees/` holds the patch and receipt.
 * @param meta - Owning task and disposal reason, recorded on the receipt.
 * @returns The verified receipt, or why the archive could not be written.
 * @task T13924
 */
export function archiveWorktree(
  worktreePath: string,
  gitRoot: string,
  projectRoot: string,
  meta: { taskId: string | null; reason: string },
): WorktreeArchiveReceipt | { error: string } {
  const entries = statusEntries(worktreePath);
  if (entries === null) return { error: 'git status failed' };
  const branch = currentBranch(worktreePath);
  if (branch === undefined) return { error: 'git cannot read the checked-out branch' };
  const headOut = git(worktreePath, ['rev-parse', '--verify', '-q', 'HEAD']);
  const head = headOut === null ? null : headOut.trim();
  const createdAt = new Date().toISOString();
  const stamp = createdAt.replace(/[:.]/g, '-');
  const name = (meta.taskId ?? basename(worktreePath)).replace(/[^A-Za-z0-9._-]/g, '_');
  const scratch = mkdtempSync(join(tmpdir(), 'cleo-worktree-archive-'));
  try {
    const env = gitEnv({
      GIT_INDEX_FILE: join(scratch, 'index'),
      GIT_AUTHOR_NAME: process.env['GIT_AUTHOR_NAME'] ?? 'CLEO archive',
      GIT_AUTHOR_EMAIL: process.env['GIT_AUTHOR_EMAIL'] ?? 'archive@cleo.invalid',
      GIT_COMMITTER_NAME: process.env['GIT_COMMITTER_NAME'] ?? 'CLEO archive',
      GIT_COMMITTER_EMAIL: process.env['GIT_COMMITTER_EMAIL'] ?? 'archive@cleo.invalid',
    });
    if (head !== null && git(worktreePath, ['read-tree', head], env) === null) {
      return { error: 'git read-tree failed' };
    }
    const noNodeModules = [':(exclude,glob)**/node_modules', ':(exclude,glob)**/node_modules/**'];
    if (git(worktreePath, ['add', '-A', '--', '.', ...noNodeModules], env) === null) {
      return { error: 'git add -A failed' };
    }
    const ignored = archivableIgnored(entries);
    for (let i = 0; i < ignored.length; i += 200) {
      if (git(worktreePath, ['add', '-f', '--', ...ignored.slice(i, i + 200)], env) === null) {
        return { error: 'git add -f of ignored content failed' };
      }
    }
    const tree = git(worktreePath, ['write-tree'], env)?.trim();
    if (!tree) return { error: 'git write-tree failed' };
    const message = `cleo archive of ${worktreePath} (${meta.reason})`;
    const parents = head === null ? [] : ['-p', head];
    const sha = git(worktreePath, ['commit-tree', tree, ...parents, '-m', message], env)?.trim();
    if (!sha) return { error: 'git commit-tree failed' };
    const archiveRef = `refs/cleo/archive/${name}/${stamp}`;
    if (git(gitRoot, ['update-ref', archiveRef, sha]) === null) {
      return { error: 'git update-ref failed' };
    }
    if (git(gitRoot, ['rev-parse', '--verify', '-q', `${archiveRef}^{commit}`])?.trim() !== sha) {
      return { error: `${archiveRef} does not resolve to the archive commit` };
    }
    const from = head ?? git(gitRoot, ['hash-object', '-t', 'tree', '/dev/null'])?.trim();
    const patch = from ? git(gitRoot, ['diff', '--binary', from, sha]) : null;
    if (patch === null) return { error: 'git diff of the archive failed' };
    const dir = join(projectRoot, '.cleo', 'archive', 'worktrees');
    mkdirSync(dir, { recursive: true });
    const patchPath = join(dir, `${name}-${stamp}.patch`);
    const receiptPath = join(dir, `${name}-${stamp}.json`);
    writeFileSync(patchPath, patch);
    const receipt: WorktreeArchiveReceipt = {
      worktreePath,
      taskId: meta.taskId,
      reason: meta.reason,
      branch,
      head,
      archiveRef,
      archiveSha: sha,
      patchPath,
      receiptPath,
      createdAt,
      restore: `git worktree add <dir> ${sha}`,
    };
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    if (readFileSync(patchPath).length !== Buffer.byteLength(patch)) {
      return { error: 'the patch did not write completely' };
    }
    return receipt;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/** The repository root and main checkout a worktree belongs to, or `null`. */
function repositoryOf(worktreePath: string): { gitRoot: string; mainCheckout: string } | null {
  const common = git(worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common === null) return null;
  const mainCheckout = dirname(common.trim());
  return { gitRoot: mainCheckout, mainCheckout };
}

/**
 * Move this process out of `dir` before it is deleted (T12671): a process
 * whose cwd no longer exists fails every later resolution from it.
 */
function leaveDirectory(dir: string, to: string): void {
  let cwd: string;
  let target: string;
  try {
    cwd = realpathSync(process.cwd()); // CWD-OK: the process's own cwd is the subject
    target = realpathSync(dir);
  } catch {
    return;
  }
  const rel = relative(target, cwd);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) process.chdir(to);
}

/** Unlock and delete a checkout and its registration; whether the directory is gone. */
function removeCheckout(gitRoot: string, worktreePath: string): boolean {
  leaveDirectory(worktreePath, gitRoot);
  git(gitRoot, ['worktree', 'unlock', worktreePath]);
  try {
    // Forced: the proof (or the archive) has already covered everything inside.
    napiDestroyWorktree({ repoRoot: gitRoot, worktreePath, force: true });
  } catch {
    // verified below
  }
  // T11033: the binding can report success while untracked directories survive.
  if (existsSync(worktreePath)) {
    try {
      napiRemoveDir({ path: worktreePath });
    } catch {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  }
  git(gitRoot, ['worktree', 'prune']);
  return !existsSync(worktreePath);
}

/**
 * Dispose of a worktree with per-item proof that nothing is lost (T13924).
 * See the module comment for the proof; this is the only function that
 * deletes a worktree.
 *
 * @param opts - The worktree, its task, the reason and the overrides.
 * @returns Whether it was removed, or why it was kept, and any archive written.
 * @task T13924
 */
export function disposeWorktree(opts: DisposeWorktreeOptions): DisposeWorktreeResult {
  const { worktreePath } = opts;
  const keep = (keptReason: string, extra: Partial<DisposeWorktreeResult> = {}) => ({
    worktreePath,
    removed: false,
    keptReason,
    ...extra,
  });
  if (!existsSync(worktreePath)) return { worktreePath, removed: true };
  const repo = repositoryOf(worktreePath);
  const gitRoot = opts.gitRoot ?? repo?.gitRoot;
  const projectRoot = opts.projectRoot ?? repo?.mainCheckout;
  if (gitRoot === undefined || projectRoot === undefined) {
    return keep('not proven: git cannot read the worktree', {
      unpreserved: 'git cannot read the worktree',
    });
  }

  const kept = guardWorktreeDisposal(worktreePath, {
    taskId: opts.taskId,
    reason: opts.reason,
    gitRoot,
    projectRoot,
    evidence: opts.evidence,
    dryRun: opts.dryRun,
  });
  if (kept !== null) return keep(describeDisposalBlockers(worktreePath, kept), { kept });

  if (opts.inUse) {
    let inUse: string | null;
    try {
      inUse = opts.inUse();
    } catch {
      inUse = 'the in-use probe failed';
    }
    if (inUse !== null) return keep(`in use: ${inUse}`);
  }

  const unpreserved =
    unprovenContent(worktreePath, projectRoot, { exemptRegenerable: opts.exemptRegenerable }) ??
    unpreservedCommits(worktreePath);
  if (unpreserved !== null && opts.force !== true) {
    return keep(`not proven preserved: ${unpreserved}`, { unpreserved });
  }
  if (opts.dryRun === true || opts.probe === true) {
    return { worktreePath, removed: false, ...(unpreserved !== null ? { unpreserved } : {}) };
  }

  let archive: WorktreeArchiveReceipt | undefined;
  if (unpreserved !== null) {
    const written = archiveWorktree(worktreePath, gitRoot, projectRoot, {
      taskId: opts.taskId,
      reason: opts.reason,
    });
    if ('error' in written) {
      const failed = `archive failed (${written.error}); nothing removed`;
      return keep(failed, { unpreserved, failed });
    }
    archive = written;
  }

  if (!removeCheckout(gitRoot, worktreePath)) {
    const failed = `removal failed: ${worktreePath} is still on disk`;
    return keep(failed, {
      failed,
      ...(unpreserved !== null ? { unpreserved } : {}),
      ...(archive ? { archive } : {}),
    });
  }
  // T12506: a removed worktree's per-task lock guards nothing.
  if (opts.taskId !== null) releaseWorktreeTaskLock(computeProjectHash(projectRoot), opts.taskId);
  return {
    worktreePath,
    removed: true,
    ...(unpreserved !== null ? { unpreserved } : {}),
    ...(archive ? { archive } : {}),
  };
}
