/**
 * Clean up what merged work left behind (T14142, owner decision D11212):
 * canonical task worktrees, `task/*` branches (local and on `origin`), and
 * repository copies nested inside worktrees.
 *
 * Every item is proven redundant on its own before anything is deleted, and
 * any doubt keeps it:
 *
 * - **merged**: the item's commits are ancestors of `origin/<default>`, read
 *   after a fresh fetch (a failed fetch deletes nothing on `origin`);
 * - **in scope**: its task is one the caller names (a merged PR's tasks, a
 *   release's tasks) or, with none named, a task stored as done or cancelled;
 * - **clean**: `git status --porcelain -uall` is empty (an error keeps it);
 * - **not in use**: not git-locked, no CLEO task lock record, no other
 *   checkout linking into it and no evidence living only there
 *   (`guardWorktreeDisposal`, the guard every disposal path shares).
 *
 * Nothing new deletes: worktrees go through `removeWorktreeFromDisk`, nested
 * copies through the worktree package's `removeDir`, branches through git.
 * A dry run (the default) reports the same items without touching them.
 *
 * @task T14142
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type {
  DataAccessor,
  MergedCleanupItem,
  MergedCleanupOpts,
  MergedCleanupResult,
} from '@cleocode/contracts';
import { computeProjectHash, resolveWorktreeRootForHash } from '@cleocode/paths';
import {
  describeDisposalBlockers,
  guardWorktreeDisposal,
  napiRemoveDir,
  readWorktreeTaskLock,
} from '@cleocode/worktree';
import { appendWorktreeAuditEntry, resolveWorktreeAuditActor } from './audit.js';
import { enumerateWorktrees } from './list.js';
import { checkoutIsClean, loadTaskEvidence, removeWorktreeFromDisk } from './prune.js';

/** `task/T123` or `task/T123-slug`: the task id a branch belongs to. */
const TASK_BRANCH = /^task\/(T\d+)(?:[-/]|$)/;

/** How deep below a worktree's root nested copies are looked for. */
const MAX_NEST_DEPTH = 4;

/** Branches deleted on `origin` per push. */
const REMOTE_DELETE_BATCH = 50;

/** Run git in `cwd`; stdout trimmed, or `null` on any failure. */
function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

function lines(out: string | null): string[] {
  return (out ?? '').split('\n').filter((l) => l.length > 0);
}

/**
 * Bytes a directory tree occupies on disk, without following symlinks.
 *
 * @param path - Directory to measure.
 * @returns Allocated bytes (`blocks * 512`, else the size); 0 when unreadable.
 * @task T14142
 */
export function diskBytes(path: string): number {
  let total = 0;
  const stack = [path];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    try {
      const st = lstatSync(current);
      total += st.blocks > 0 ? st.blocks * 512 : st.size;
      if (st.isDirectory()) {
        for (const name of readdirSync(current)) stack.push(join(current, name));
      }
    } catch {
      // vanished or unreadable: counts as nothing
    }
  }
  return total;
}

/** The task id of a `task/*` branch, or `null`. */
function branchTaskId(branch: string): string | null {
  return TASK_BRANCH.exec(branch)?.[1] ?? null;
}

/** Build the in-scope test: the named tasks, else tasks stored done or cancelled. */
async function scopeFor(
  projectRoot: string,
  taskIds: readonly string[] | undefined,
): Promise<(taskId: string) => Promise<boolean>> {
  if (taskIds !== undefined) {
    const named = new Set(taskIds);
    return async (id) => named.has(id);
  }
  const statuses = new Map<string, boolean>();
  let accessor: DataAccessor | null = null;
  try {
    const { getTaskAccessor } = await import('../store/data-accessor.js');
    accessor = await getTaskAccessor(projectRoot);
  } catch {
    accessor = null;
  }
  return async (id) => {
    if (accessor === null) return false;
    const cached = statuses.get(id);
    if (cached !== undefined) return cached;
    let terminal = false;
    try {
      const task = await accessor.loadSingleTask(id);
      terminal = task?.status === 'done' || task?.status === 'cancelled';
    } catch {
      terminal = false;
    }
    statuses.set(id, terminal);
    return terminal;
  };
}

/** Commits a nested copy holds that must exist upstream before it may go. */
function nestedTips(nested: string): string[] | null {
  const head = git(nested, ['rev-parse', 'HEAD']);
  const refs = git(nested, ['for-each-ref', '--format=%(objectname)', 'refs/heads', 'refs/stash']);
  return head === null || refs === null ? null : [head, ...lines(refs)];
}

/** Directories holding a `.git` below `root` (not `root` itself), depth-bounded. */
function findNestedRepos(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_NEST_DEPTH) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === 'node_modules' || name === '.git') continue;
      const child = join(dir, name);
      try {
        if (!lstatSync(child).isDirectory()) continue;
      } catch {
        continue;
      }
      if (existsSync(join(child, '.git'))) {
        found.push(child);
        continue; // a copy's own contents are the copy
      }
      walk(child, depth + 1);
    }
  };
  walk(root, 1);
  return found;
}

/**
 * Remove the canonical worktrees, `task/*` branches and nested repository
 * copies that merged work left behind, each only with proof it is redundant.
 *
 * @param opts - Project, scope, dry run (default) and whether to touch `origin`.
 * @param deps - `openPrHeads`: head branches of open pull requests, or `null`
 *   when unknown (default: one `gh pr list`); `afterProof`: a test seam
 *   between the proofs and the deletes.
 * @returns Every item considered, removed or kept with its reason, and the bytes reclaimed.
 * @task T14142
 */
export async function cleanupMergedWork(
  opts: MergedCleanupOpts,
  deps: {
    openPrHeads?: (projectRoot: string) => Set<string> | null;
    /** Called after every branch is proven and before any is deleted (tests move a tip here). */
    afterProof?: () => void;
  } = {},
): Promise<MergedCleanupResult> {
  const root = opts.projectRoot;
  const dryRun = opts.dryRun !== false;
  const remote = opts.remote !== false;
  const defaultBranch = (
    git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']) ?? 'origin/main'
  ).replace(/^origin\//, '');
  const base = `origin/${defaultBranch}`;
  const result: MergedCleanupResult = {
    dryRun,
    base,
    worktrees: [],
    localBranches: [],
    remoteBranches: [],
    nestedCopies: [],
    bytesReclaimed: 0,
  };
  const fetched =
    git(root, [
      'fetch',
      '-q',
      '--prune',
      'origin',
      `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`,
      '+refs/heads/task/*:refs/remotes/origin/task/*',
    ]) !== null;
  if (git(root, ['rev-parse', '--verify', '-q', base]) === null) return result;
  const merged = (sha: string): boolean =>
    git(root, ['merge-base', '--is-ancestor', sha, base]) !== null;
  const inScope = await scopeFor(root, opts.taskIds);
  const projectHash = computeProjectHash(root);
  const worktreeRoot = resolveWorktreeRootForHash(projectHash);
  const actor = resolveWorktreeAuditActor();
  const keep = (list: MergedCleanupItem[], target: string, taskId: string | null, reason: string) =>
    list.push({ target, taskId, removed: false, reason, bytes: 0 });

  // Read before any worktree removal: removing a worktree also drops its branch.
  const localRefs = lines(
    git(root, ['for-each-ref', '--format=%(refname:short)%09%(objectname)', 'refs/heads/task']),
  );

  // ── Canonical task worktrees ──────────────────────────────────────────────
  let registered: ReturnType<typeof enumerateWorktrees> = [];
  try {
    registered = enumerateWorktrees(root);
  } catch {
    registered = [];
  }
  const removedPaths = new Set<string>();
  for (const wt of registered) {
    const taskId = basename(wt.path);
    if (dirname(wt.path) !== worktreeRoot || !/^T\d+$/.test(taskId)) continue;
    if (!(await inScope(taskId))) continue;
    if (wt.locked) {
      keep(result.worktrees, wt.path, taskId, 'git-locked');
      continue;
    }
    if (readWorktreeTaskLock(projectHash, taskId) !== null) {
      keep(result.worktrees, wt.path, taskId, 'task lock held');
      continue;
    }
    const tip = git(wt.path, ['rev-parse', 'HEAD']);
    if (tip === null || !merged(tip)) {
      keep(result.worktrees, wt.path, taskId, `unmerged: not in ${base}`);
      continue;
    }
    if (!checkoutIsClean(wt.path)) {
      keep(result.worktrees, wt.path, taskId, 'dirty: uncommitted or untracked changes');
      continue;
    }
    const blockers = guardWorktreeDisposal(wt.path, {
      taskId,
      reason: 'merged-cleanup',
      gitRoot: root,
      projectRoot: root,
      evidence: await loadTaskEvidence(root, taskId),
      dryRun,
    });
    if (blockers !== null) {
      keep(result.worktrees, wt.path, taskId, describeDisposalBlockers(wt.path, blockers));
      continue;
    }
    const bytes = diskBytes(wt.path);
    if (!dryRun) {
      const removal = removeWorktreeFromDisk(
        // The branch is deleted below, leased to the sha proven merged.
        { path: wt.path, branch: wt.branch, isMerged: false },
        root,
      );
      appendWorktreeAuditEntry(root, {
        actor,
        action: 'prune',
        target: wt.path,
        branch: wt.branch,
        taskId,
        reason: 'merged-cleanup',
        success: removal.success,
        ...(removal.success ? {} : { error: removal.error }),
      });
      if (!removal.success) {
        keep(result.worktrees, wt.path, taskId, removal.error);
        continue;
      }
    }
    removedPaths.add(wt.path);
    result.worktrees.push({
      target: wt.path,
      taskId,
      removed: true,
      reason: `clean and merged into ${base}`,
      bytes,
    });
    result.bytesReclaimed += bytes;
  }

  // ── Local task branches (a removed worktree, dry run included, frees its branch) ──
  const checkedOut = new Set(
    registered.filter((w) => !removedPaths.has(w.path)).map((w) => w.branch),
  );
  const localProven: MergedCleanupItem[] = [];
  for (const line of localRefs) {
    const [branch = '', sha = ''] = line.split('\t');
    const taskId = branchTaskId(branch);
    if (taskId === null || !(await inScope(taskId))) continue;
    if (checkedOut.has(branch)) {
      keep(result.localBranches, branch, taskId, 'checked out in a worktree');
      continue;
    }
    if (!merged(sha)) {
      keep(result.localBranches, branch, taskId, `unmerged: not in ${base}`);
      continue;
    }
    localProven.push({
      target: branch,
      taskId,
      sha,
      removed: true,
      reason: `merged into ${base}`,
      bytes: 0,
    });
  }

  // ── Remote task branches ──────────────────────────────────────────────────
  const remoteProven: MergedCleanupItem[] = [];
  if (remote && fetched) {
    const openHeads = (deps.openPrHeads ?? openPrHeads)(root);
    const remoteRefs = lines(
      git(root, [
        'for-each-ref',
        '--format=%(refname:short)%09%(objectname)',
        'refs/remotes/origin/task',
      ]),
    );
    const doomed: MergedCleanupItem[] = [];
    for (const line of remoteRefs) {
      const [ref = '', sha = ''] = line.split('\t');
      const branch = ref.replace(/^origin\//, '');
      const taskId = branchTaskId(branch);
      if (taskId === null || !(await inScope(taskId))) continue;
      if (openHeads === null) {
        keep(result.remoteBranches, branch, taskId, 'open pull requests could not be read');
      } else if (openHeads.has(branch)) {
        keep(result.remoteBranches, branch, taskId, 'head of an open pull request');
      } else if (!merged(sha)) {
        keep(result.remoteBranches, branch, taskId, `unmerged: not in ${base}`);
      } else {
        doomed.push({
          target: branch,
          taskId,
          sha,
          removed: true,
          reason: `merged into ${base}`,
          bytes: 0,
        });
      }
    }
    remoteProven.push(...doomed);
  }

  // ── Deletes, each leased to the sha its proof read ──────────────────────
  deps.afterProof?.();
  for (const item of localProven) {
    // update-ref deletes only while the tip is still the proven sha.
    if (
      !dryRun &&
      git(root, ['update-ref', '-d', `refs/heads/${item.target}`, item.sha ?? '']) === null
    ) {
      result.localBranches.push({ ...item, removed: false, reason: 'tip moved after the proof' });
      continue;
    }
    if (!dryRun) auditBranchDelete(root, actor, item.target, item.taskId, item.sha ?? '', 'local');
    result.localBranches.push(item);
  }
  for (let i = 0; i < remoteProven.length; i += REMOTE_DELETE_BATCH) {
    const batch = remoteProven.slice(i, i + REMOTE_DELETE_BATCH);
    const deleted = dryRun ? null : leasedRemoteDelete(root, batch);
    for (const item of batch) {
      if (deleted !== null && !deleted.has(item.target)) {
        result.remoteBranches.push({
          ...item,
          removed: false,
          reason: 'tip moved after the proof, or the push failed',
        });
        continue;
      }
      if (!dryRun)
        auditBranchDelete(root, actor, item.target, item.taskId, item.sha ?? '', 'origin');
      result.remoteBranches.push(item);
    }
  }

  // ── Repository copies nested inside worktrees ─────────────────────────────
  const projectRoots = new Set(lines(git(root, ['rev-list', '--max-parents=0', base])));
  let worktreeDirs: string[] = [];
  try {
    worktreeDirs = readdirSync(worktreeRoot).map((n) => join(worktreeRoot, n));
  } catch {
    worktreeDirs = [];
  }
  for (const dir of worktreeDirs) {
    if (removedPaths.has(dir)) continue;
    for (const nested of findNestedRepos(dir)) {
      const roots = lines(git(nested, ['rev-list', '--max-parents=0', 'HEAD']));
      if (!roots.some((r) => projectRoots.has(r))) continue; // another project's repo
      // A `.git` file is a linked worktree, possibly in use: the worktree tools own it.
      if (!lstatSync(join(nested, '.git')).isDirectory()) {
        keep(result.nestedCopies, nested, null, 'a linked worktree, not a copy');
        continue;
      }
      if (!checkoutIsClean(nested)) {
        keep(result.nestedCopies, nested, null, 'dirty: uncommitted or untracked changes');
        continue;
      }
      const tips = nestedTips(nested);
      const unpushed =
        tips === null ||
        tips.some(
          (sha) =>
            git(root, [
              'for-each-ref',
              '--count=1',
              '--format=x',
              '--contains',
              sha,
              'refs/remotes/origin',
            ]) !== 'x',
        );
      if (unpushed) {
        keep(result.nestedCopies, nested, null, 'holds commits not on origin');
        continue;
      }
      const bytes = diskBytes(nested);
      if (!dryRun) {
        try {
          napiRemoveDir({ path: nested });
        } catch {
          // verified below
        }
        if (existsSync(nested)) {
          keep(result.nestedCopies, nested, null, 'removal failed');
          continue;
        }
        git(root, ['worktree', 'prune']);
      }
      result.nestedCopies.push({
        target: nested,
        taskId: null,
        removed: true,
        reason: 'clean copy of this repository; every commit is on origin',
        bytes,
      });
      result.bytesReclaimed += bytes;
    }
  }
  return result;
}

/**
 * Record a deleted branch with its tip, so a mistaken delete is one command to
 * undo: `git branch <b> <sha>` locally, `git push origin <sha>:refs/heads/<b>`
 * on origin.
 */
function auditBranchDelete(
  root: string,
  actor: string,
  branch: string,
  taskId: string | null,
  sha: string,
  where: 'local' | 'origin',
): void {
  const restore =
    where === 'local'
      ? `git branch ${branch} ${sha}`
      : `git push origin ${sha}:refs/heads/${branch}`;
  appendWorktreeAuditEntry(root, {
    actor,
    action: 'prune',
    target: where === 'local' ? branch : `origin/${branch}`,
    branch,
    ...(taskId !== null ? { taskId } : {}),
    reason: `merged-cleanup: deleted ${where} branch at ${sha}; restore with ${restore}`,
    success: true,
  });
}

/**
 * Delete `origin` branches, each under its own lease: a ref whose tip is no
 * longer the proven sha is rejected, not deleted.
 *
 * @returns The branches `origin` reports deleted (`--porcelain`).
 */
function leasedRemoteDelete(root: string, items: readonly MergedCleanupItem[]): Set<string> {
  const args = ['-C', root, 'push', '--porcelain', 'origin'];
  for (const it of items) args.push(`--force-with-lease=refs/heads/${it.target}:${it.sha ?? ''}`);
  for (const it of items) args.push(`:refs/heads/${it.target}`);
  // A rejected ref fails the push; its porcelain report is still on stdout.
  const out = spawnSync('git', args, { encoding: 'utf8', timeout: 120_000 }).stdout ?? '';
  const deleted = new Set<string>();
  for (const line of lines(out)) {
    const [flag, refs] = line.split('\t');
    const ref = refs?.split(':')[1] ?? '';
    if (flag === '-' && ref.startsWith('refs/heads/')) deleted.add(ref.slice('refs/heads/'.length));
  }
  return deleted;
}

/** Head branches of open pull requests, or `null` when `gh` cannot say. */
function openPrHeads(root: string): Set<string> | null {
  try {
    const out = execFileSync(
      'gh',
      [
        'pr',
        'list',
        '--state',
        'open',
        '--limit',
        '1000',
        '--json',
        'headRefName',
        '--jq',
        '.[].headRefName',
      ],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 },
    );
    return new Set(lines(out));
  } catch {
    return null;
  }
}
