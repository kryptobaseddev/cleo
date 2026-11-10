/**
 * The machine-wide worktree census (T14275, durability plan S3 / C-F3).
 *
 * The worktree root (`<cleoHome>/worktrees/<projectHash>/…`) is per machine,
 * but every other cleanup path resolves one project's hash directory, so the
 * worktrees of projects never run from their root (other repositories,
 * deleted ones, scratch clones) were never swept: 484 had accumulated. The
 * CI cleanup workflow ran where no worktree exists and swallowed every error.
 *
 * The census walks every project hash directory under the root:
 *
 * - a directory whose hash matches a registered project (the nexus registry)
 *   is classified by that project's {@link listWorktrees}: the disposal proof
 *   decides `redundant`, `keep` (with the failing clause) or `unknown`, and
 *   an open task or a fresh worktree is `active` (T14274);
 * - a directory no registered project owns, and any directory git does not
 *   list as a worktree, is reported `unknown`, report only.
 *
 * Every row also carries the visibility fields the machine-hygiene epic needs
 * (T14440): the owning task's status, last activity and creation time, git and
 * task locks, the dirty-entry count, and the `node_modules` kind and size.
 * Per project the record rolls up worktree counts, bytes and merged local and
 * remote branches; machine-wide it names the orphan hash directories and the
 * global pnpm store's size.
 *
 * `--apply` removes only `redundant` worktrees of the projects it is allowed
 * to act on (by default the project it runs in; other projects stay report
 * only until the owner's plan question C is answered), each re-proved by
 * `disposeWorktree` with the task's evidence. Every run writes one census
 * record (counts, apparent bytes, bytes reclaimed, the free-space delta and
 * every kept worktree with its reason) under `<cleoHome>/hygiene/census/`.
 *
 * One census runs at a time per machine (a heartbeat lock), and the lazy spawn
 * claims at most one run per 24 h; it never starts in CI, under vitest, or in
 * a process git started (T14189).
 *
 * @task T14275
 */

import { execFileSync, type SpawnOptions, spawn } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statfsSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { setPriority } from 'node:os';
import { join, resolve } from 'node:path';
import type { WorktreeStatusCategory } from '@cleocode/contracts';
import { computeProjectHash, getCleoHome, getCleoWorktreesRoot } from '@cleocode/paths';
import { acquireHeartbeatLock, claimAtMostEvery } from '../tasks/merge-close.js';

/** The lazy census runs at most this often per machine. */
export const CENSUS_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** A census lock whose heartbeat is older than this is stale. */
const CENSUS_LOCK_STALE_MS = 10 * 60 * 1000;

/** One worktree directory the census found. */
export interface CensusRow {
  /** The registered project that owns it, or `null` when none does. */
  project: string | null;
  /** The hash directory it sits in. */
  projectHash: string;
  /** The worktree directory. */
  path: string;
  /** Its task, when known. */
  taskId: string | null;
  /** The disposal-proof category (T14274); `unknown` for anything not proven. */
  category: WorktreeStatusCategory;
  /** For `keep` and `unknown`: why. */
  keepReason?: string;
  /** Apparent size (the sum of file sizes, as `du --apparent-size`), in bytes. */
  apparentBytes: number;
  /** Set when `--apply` removed it. */
  removed?: boolean;
  /** The owning task's status (`active`, `done`, ...), or `null` when unresolvable (T14440). */
  taskStatus: string | null;
  /** ISO of the last commit on the worktree's branch, else the dir mtime; `null` when unknown (T14440). */
  lastActivity: string | null;
  /** ISO creation time (git admin file, adopt sentinel or dir mtime); `null` when unknown (T14440). */
  createdAt: string | null;
  /** `git worktree list --porcelain` lock state (T14440). */
  gitLocked: boolean;
  /** A CLEO task lock is held on this worktree's task (T14440). */
  taskLocked: boolean;
  /** Changed + untracked entries from `git status --porcelain`; `null` when git failed or time ran out (T14440). */
  dirtyFiles: number | null;
  /** The worktree's `node_modules`: `absent`, a `symlink`, or a `real` directory (T14440). */
  nodeModules: 'absent' | 'symlink' | 'real';
  /** Apparent bytes of a `real` `node_modules` (symlinks count as 0); 0 otherwise (T14440). */
  nodeModulesBytes: number;
}

/**
 * Per-project rollup of one census run (T14440).
 */
export interface ProjectCensusRollup {
  /** Registered project root, or `null` when the hash dir matches no registered project. */
  project: string | null;
  /** The hash directory. */
  projectHash: string;
  /** Worktrees found under it. */
  worktrees: number;
  /** Their apparent bytes. */
  apparentBytes: number;
  /**
   * Local branches the SDK integration probe classifies as merged into the
   * integration target (primary checkout and the target itself excluded);
   * `null` when the probe failed (T14440).
   */
  mergedLocalBranches: number | null;
  /** Remote branches merged into the target (HEAD refs excluded); `null` when git failed (T14440). */
  mergedRemoteBranches: number | null;
  /** True when no registered project owns this hash directory. */
  orphan: boolean;
}

/** A worktrees-home hash directory that matches no registered project (T14440). */
export interface OrphanHashDir {
  /** The directory name under the worktrees home. */
  projectHash: string;
  /** Worktree-like directories found under it. */
  worktrees: number;
  /** Their apparent bytes. */
  apparentBytes: number;
}

/** The global pnpm content-addressable store and its size (T14440). */
export interface PnpmStoreCensus {
  /** The store directory (`pnpm store path`). */
  path: string;
  /** Apparent bytes of the store. */
  apparentBytes: number;
}

/** The record one census run writes. */
export interface CensusRecord {
  /** Record format version. */
  schemaVersion: 2;
  /** `report` reads only; `apply` removed proven-redundant worktrees. */
  mode: 'report' | 'apply';
  /** ISO time the run started. */
  startedAt: string;
  /** ISO time the run finished. */
  finishedAt: string;
  /** The machine's worktree root. */
  machineRoot: string;
  /** Projects `--apply` was allowed to act on. */
  applyProjects: string[];
  /** Worktrees per category. */
  counts: Record<WorktreeStatusCategory, number>;
  /** Apparent bytes of every worktree found. */
  apparentBytes: number;
  /** Apparent bytes of the worktrees removed. */
  reclaimedApparentBytes: number;
  /** Free bytes on the root's filesystem before and after, and the delta (apply only). */
  dfFreeBefore: number | null;
  dfFreeAfter: number | null;
  dfDelta: number | null;
  /** Every worktree not removed and not active, with its reason. */
  kept: Array<{ path: string; category: WorktreeStatusCategory; keepReason: string }>;
  /** Every worktree found. */
  rows: CensusRow[];
  /** True when the wall-clock budget ran out: rows and bytes are a lower bound. */
  partial: boolean;
  /** Per-project rollup: worktree count, bytes and merged branches (T14440). */
  projects: ProjectCensusRollup[];
  /** Hash directories under the machine root that no registered project owns (T14440). */
  orphanFolders: OrphanHashDir[];
  /** The global pnpm store and its apparent size, when it could be resolved (T14440). */
  pnpmStore: PnpmStoreCensus | null;
}

/** Options of {@link runWorktreeCensus}. */
export interface WorktreeCensusOptions {
  /** Remove proven-redundant worktrees (default: report only). */
  apply?: boolean;
  /** Projects `apply` may act on (default: none; the CLI passes the current project). */
  applyProjects?: readonly string[];
  /** Registered project roots (default: read from the nexus registry). */
  projects?: readonly string[];
  /** Where the record is written (default: `<cleoHome>/hygiene/census`). */
  recordDir?: string;
  /** The worktree root (default: the machine's). */
  machineRoot?: string;
  /** Wall-clock deadline (ms epoch): past it the walk stops and the record is `partial`. */
  deadline?: number;
  /**
   * The global pnpm store census to embed. `undefined` resolves and sizes the
   * real store (`pnpm store path`); `null` records none; tests stub a value.
   */
  pnpmStore?: PnpmStoreCensus | null;
}

/** Where the census keeps its record, claim and lock. */
function censusDir(): string {
  return join(getCleoHome(), 'hygiene', 'census');
}

/**
 * Apparent size of a tree: the sum of `lstat` sizes, symlinks never followed;
 * 0 when unreadable. Stops early (an undercount) once `deadline` passes.
 */
export function apparentBytes(path: string, deadline = Number.POSITIVE_INFINITY): number {
  let total = 0;
  const stack = [path];
  while (stack.length > 0) {
    if (Date.now() > deadline) return total; // the caller marks the record partial
    const current = stack.pop() as string;
    try {
      const st = lstatSync(current);
      total += st.size;
      if (st.isDirectory())
        for (const name of readdirSync(current)) stack.push(join(current, name));
    } catch {
      // vanished or unreadable: counts as nothing
    }
  }
  return total;
}

/** Free bytes available on the filesystem holding `path`, or `null`. */
function freeBytes(path: string): number | null {
  try {
    const st = statfsSync(path);
    return st.bavail * st.bsize;
  } catch {
    return null;
  }
}

/** Canonical form of a path for comparison (realpath when it exists). */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Registered project roots from the nexus registry; `[]` when it cannot be read.
 *
 * @param load - The registry listing (default: `nexusList`; tests stub it).
 * @returns Each registered project's path.
 * @internal Exported for tests.
 */
export async function registeredProjects(
  load?: () => Promise<ReadonlyArray<{ path: string }>>,
): Promise<string[]> {
  try {
    const list = load ?? (await import('../nexus/registry.js')).nexusList;
    return (await list()).map((p) => p.path);
  } catch {
    return [];
  }
}

/**
 * Run the census once, under the machine's census lock.
 *
 * @param opts - Apply or report, the projects apply may touch, overrides for tests.
 * @returns The record and where it was written, or why it was skipped.
 * @task T14275
 */
export async function runWorktreeCensus(
  opts: WorktreeCensusOptions = {},
): Promise<{ record: CensusRecord; recordPath: string } | { skipped: string }> {
  const dir = opts.recordDir ?? censusDir();
  mkdirSync(dir, { recursive: true });
  const release = acquireHeartbeatLock(join(dir, 'census.lock'), CENSUS_LOCK_STALE_MS);
  if (release === null) return { skipped: 'another census holds the lock' };
  // Every exit path releases the lock, a `process.exit` included.
  process.once('exit', release);
  try {
    return writeRecord(dir, await census(opts));
  } finally {
    process.removeListener('exit', release);
    release();
  }
}

/** Write the record (tmp then rename) and the `latest.json` copy. */
function writeRecord(
  dir: string,
  record: CensusRecord,
): { record: CensusRecord; recordPath: string } {
  const recordPath = join(dir, `census-${record.startedAt.replace(/[:.]/g, '-')}.json`);
  const body = `${JSON.stringify(record, null, 2)}\n`;
  for (const target of [recordPath, join(dir, 'latest.json')]) {
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, target);
  }
  return { record, recordPath };
}

/** The census proper: classify, optionally apply, and build the record. */
async function census(opts: WorktreeCensusOptions): Promise<CensusRecord> {
  // Lazy: the CLI imports this module on read commands to claim the daily run.
  const { listWorktrees } = await import('../worktree/list.js');
  const { worktreeInUseProbe } = await import('../worktree/in-use-probe.js');
  const { loadTaskEvidence } = await import('../worktree/prune.js');
  const { readWorktreeTaskLock } = await import('@cleocode/worktree');
  const startedAt = new Date().toISOString();
  const machineRoot = opts.machineRoot ?? getCleoWorktreesRoot();
  const apply = opts.apply === true;
  const applyProjects = new Set((opts.applyProjects ?? []).map(canonical));
  const deadline = opts.deadline ?? Number.POSITIVE_INFINITY;
  let partial = false;
  const outOfTime = (): boolean => {
    if (Date.now() > deadline) partial = true;
    return partial;
  };
  const projects = opts.projects ?? (await registeredProjects());
  const projectByHash = new Map<string, string>();
  for (const p of projects)
    if (existsSync(p)) projectByHash.set(computeProjectHash(p), canonical(p));

  const rows: CensusRow[] = [];
  const meta = new Map<CensusRow, { isMerged: boolean }>();
  let hashes: string[] = [];
  try {
    hashes = readdirSync(machineRoot).filter((h) => lstatSync(join(machineRoot, h)).isDirectory());
  } catch {
    hashes = [];
  }
  for (const projectHash of hashes.sort()) {
    if (outOfTime()) break;
    const hashDir = join(machineRoot, projectHash);
    const project = projectByHash.get(projectHash) ?? null;
    const listed = new Map<
      string,
      {
        category: WorktreeStatusCategory;
        keepReason?: string;
        taskId: string | null;
        isMerged: boolean;
        taskStatus: string | null;
        lastActivity: string | null;
        createdAt: string | null;
        gitLocked: boolean;
      }
    >();
    if (project !== null) {
      const result = await listWorktrees({ projectRoot: project });
      if (result.success) {
        for (const w of result.data.worktrees) {
          listed.set(canonical(w.path), {
            category: w.statusCategory,
            ...(w.keepReason !== undefined ? { keepReason: w.keepReason } : {}),
            taskId: w.taskId,
            isMerged: w.isMerged,
            // T14440 visibility fields, straight off the classifier.
            taskStatus: w.owningTaskStatus,
            lastActivity: w.lastActivity ?? null,
            createdAt: w.createdAt ?? null,
            gitLocked: w.lockState === 'locked',
          });
        }
      }
    }
    let children: string[] = [];
    try {
      children = readdirSync(hashDir).filter((n) => lstatSync(join(hashDir, n)).isDirectory());
    } catch {
      children = [];
    }
    for (const name of children.sort()) {
      if (outOfTime()) break;
      const path = join(hashDir, name);
      const hit = listed.get(canonical(path));
      const nm = classifyNodeModules(path);
      const row: CensusRow = hit
        ? {
            project,
            projectHash,
            path,
            taskId: hit.taskId,
            category: hit.category,
            ...(hit.keepReason !== undefined ? { keepReason: hit.keepReason } : {}),
            apparentBytes: apparentBytes(path, deadline),
            taskStatus: hit.taskStatus,
            lastActivity: hit.lastActivity,
            createdAt: hit.createdAt,
            gitLocked: hit.gitLocked,
            taskLocked: readTaskLockSafe(readWorktreeTaskLock, projectHash, hit.taskId),
            dirtyFiles: dirtyFileCount(path, deadline),
            nodeModules: nm,
            nodeModulesBytes:
              nm === 'real' ? apparentBytes(join(path, 'node_modules'), deadline) : 0,
          }
        : {
            project,
            projectHash,
            path,
            taskId: null,
            category: 'unknown',
            keepReason:
              project === null
                ? 'no registered project owns this hash directory (report only)'
                : 'git does not list this directory as a worktree of its project (report only)',
            apparentBytes: apparentBytes(path, deadline),
            taskStatus: null,
            lastActivity: null,
            createdAt: null,
            gitLocked: false,
            taskLocked: false,
            dirtyFiles: null,
            nodeModules: nm,
            nodeModulesBytes:
              nm === 'real' ? apparentBytes(join(path, 'node_modules'), deadline) : 0,
          };
      rows.push(row);
      meta.set(row, { isMerged: hit?.isMerged ?? false });
    }
  }

  const dfFreeBefore = apply ? freeBytes(machineRoot) : null;
  let reclaimed = 0;
  if (apply) {
    const { disposeWorktree } = await import('@cleocode/worktree');
    for (const row of rows) {
      if (outOfTime()) break;
      if (row.category !== 'redundant' || row.project === null) continue;
      if (!applyProjects.has(row.project)) continue;
      // Re-proved here, with the task's evidence: the listing was a dry run.
      const disposal = disposeWorktree({
        worktreePath: row.path,
        projectRoot: row.project,
        taskId: row.taskId,
        reason: 'census',
        evidence: await loadTaskEvidence(row.project, row.taskId),
        exemptRegenerable: meta.get(row)?.isMerged ?? false,
        inUse: worktreeInUseProbe(readWorktreeTaskLock, row.project, row.taskId),
      });
      if (disposal.removed) {
        row.removed = true;
        reclaimed += row.apparentBytes;
      } else {
        row.category = disposal.indeterminate === true ? 'unknown' : 'keep';
        row.keepReason = disposal.keptReason ?? 'kept';
      }
    }
  }
  const dfFreeAfter = apply ? freeBytes(machineRoot) : null;

  const counts: Record<WorktreeStatusCategory, number> = {
    active: 0,
    redundant: 0,
    keep: 0,
    unknown: 0,
  };
  for (const row of rows) if (!row.removed) counts[row.category] += 1;
  outOfTime();
  const rollups = await projectRollups(rows, (projectRoot) =>
    mergedBranchCounts(projectRoot, Date.now() + MERGE_PROBE_BUDGET_MS),
  );
  return {
    schemaVersion: 2,
    mode: apply ? 'apply' : 'report',
    startedAt,
    finishedAt: new Date().toISOString(),
    machineRoot,
    applyProjects: [...applyProjects],
    counts,
    apparentBytes: rows.reduce((n, r) => n + r.apparentBytes, 0),
    reclaimedApparentBytes: reclaimed,
    dfFreeBefore,
    dfFreeAfter,
    dfDelta: dfFreeBefore !== null && dfFreeAfter !== null ? dfFreeAfter - dfFreeBefore : null,
    kept: rows
      .filter((r) => !r.removed && (r.category === 'keep' || r.category === 'unknown'))
      .map((r) => ({ path: r.path, category: r.category, keepReason: r.keepReason ?? '' })),
    rows,
    partial,
    projects: rollups.rollups,
    orphanFolders: rollups.orphans,
    pnpmStore:
      opts.pnpmStore === undefined
        ? pnpmStoreCensus(Date.now() + PNPM_STORE_BUDGET_MS)
        : opts.pnpmStore,
  };
}

/** Wall-clock budget for one project's merged-branch probes (T14440). */
const MERGE_PROBE_BUDGET_MS = 30_000;

/** Wall-clock budget for resolving and sizing the global pnpm store (T14440). */
const PNPM_STORE_BUDGET_MS = 30_000;

/**
 * Per-project rollups over the census rows, plus the orphan hash directories.
 *
 * Merged-branch probes run once per registered project (never for orphans);
 * a probe failure records `null`, never a zero.
 *
 * @param rows - The census rows.
 * @param branchesOf - Merged-branch counter (tests stub it).
 * @returns Rollups keyed by hash dir and the orphan directories among them.
 */
async function projectRollups(
  rows: readonly CensusRow[],
  branchesOf: (projectRoot: string) => Promise<{
    mergedLocal: number | null;
    mergedRemote: number | null;
  }>,
): Promise<{ rollups: ProjectCensusRollup[]; orphans: OrphanHashDir[] }> {
  const byHash = new Map<string, ProjectCensusRollup>();
  for (const row of rows) {
    let rollup = byHash.get(row.projectHash);
    if (!rollup) {
      rollup = {
        project: row.project,
        projectHash: row.projectHash,
        worktrees: 0,
        apparentBytes: 0,
        mergedLocalBranches: null,
        mergedRemoteBranches: null,
        orphan: row.project === null,
      };
      byHash.set(row.projectHash, rollup);
    }
    if (!row.removed) {
      rollup.worktrees += 1;
      rollup.apparentBytes += row.apparentBytes;
    }
  }
  const orphans: OrphanHashDir[] = [];
  for (const rollup of byHash.values()) {
    if (rollup.orphan) {
      orphans.push({
        projectHash: rollup.projectHash,
        worktrees: rollup.worktrees,
        apparentBytes: rollup.apparentBytes,
      });
    } else if (rollup.project !== null) {
      const counts = await branchesOf(rollup.project);
      rollup.mergedLocalBranches = counts.mergedLocal;
      rollup.mergedRemoteBranches = counts.mergedRemote;
    }
  }
  return { rollups: [...byHash.values()], orphans };
}

/**
 * Merged-branch counts for one project: local via the SDK integration probe
 * (`buildGitAwarePrunePlan`, primary checkout and target excluded), remote via
 * `git for-each-ref --merged` with HEAD refs excluded. `null` per side when
 * its probe fails - a failed probe is never a zero (T14440).
 *
 * @param projectRoot - The registered project's repository root.
 * @param deadline - Wall-clock ms epoch past which probes stop.
 * @returns Merged local and remote branch counts.
 */
export async function mergedBranchCounts(
  projectRoot: string,
  deadline = Number.POSITIVE_INFINITY,
): Promise<{ mergedLocal: number | null; mergedRemote: number | null }> {
  if (Date.now() > deadline) return { mergedLocal: null, mergedRemote: null };
  let mergedLocal: number | null = null;
  let mergedRemote: number | null = null;
  try {
    const { buildGitAwarePrunePlan } = await import('@cleocode/worktree');
    const plan = buildGitAwarePrunePlan(projectRoot, 'main');
    if (plan !== null) {
      mergedLocal = new Set(
        plan.candidates
          .filter((c) => c.kind === 'worktree' || c.kind === 'branch_only')
          .map((c) => c.branch)
          .filter((b): b is string => b !== undefined),
      ).size;
    }
  } catch {
    mergedLocal = null;
  }
  if (Date.now() > deadline) return { mergedLocal, mergedRemote };
  try {
    const out = execFileSync(
      'git',
      ['for-each-ref', '--merged', 'main', '--format=%(refname:short)', 'refs/remotes'],
      { cwd: projectRoot, timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    mergedRemote = out
      .split('\n')
      .map((line) => line.trim())
      // A remote branch is `<remote>/<name>`; the bare remote line and HEAD
      // aliases are not branches, and the target's own remote ref is trivially
      // merged.
      .filter(
        (ref) => ref.includes('/') && !ref.endsWith('/HEAD') && !ref.endsWith('/main'),
      ).length;
  } catch {
    mergedRemote = null;
  }
  return { mergedLocal, mergedRemote };
}

/**
 * The `node_modules` classification for one worktree (T14440).
 *
 * @param worktreePath - The worktree directory.
 * @returns `absent`, `symlink` or `real`.
 */
function classifyNodeModules(worktreePath: string): 'absent' | 'symlink' | 'real' {
  try {
    const st = lstatSync(join(worktreePath, 'node_modules'));
    if (st.isSymbolicLink()) return 'symlink';
    if (st.isDirectory()) return 'real';
    return 'absent';
  } catch {
    return 'absent';
  }
}

/**
 * Changed + untracked entry count from `git status --porcelain` (T14440).
 *
 * @param worktreePath - The worktree directory.
 * @param deadline - Past it, `null` (an undercount is never a zero).
 * @returns The dirty entry count, or `null`.
 */
function dirtyFileCount(worktreePath: string, deadline: number): number | null {
  if (Date.now() > deadline) return null;
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd: worktreePath,
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    return out.split('\n').filter((line) => line.trim() !== '').length;
  } catch {
    return null;
  }
}

/**
 * CLEO task-lock state for one worktree's task (T14440).
 *
 * @param read - The lock reader (tests stub it).
 * @param projectHash - The project hash directory.
 * @param taskId - The owning task, or `null`.
 * @returns True when a live task lock is held.
 */
function readTaskLockSafe(
  read: (projectHash: string, taskId: string) => unknown,
  projectHash: string,
  taskId: string | null,
): boolean {
  if (taskId === null) return false;
  try {
    return read(projectHash, taskId) !== null;
  } catch {
    return false;
  }
}

/**
 * The global pnpm content-addressable store and its apparent size (T14440).
 * `pnpm store path` resolves the location; any failure yields `null`, never a
 * zero-sized store.
 *
 * @param deadline - Past it, `null`.
 * @returns The store census, or `null`.
 */
export function pnpmStoreCensus(deadline = Number.POSITIVE_INFINITY): PnpmStoreCensus | null {
  if (Date.now() > deadline) return null;
  let storePath: string;
  try {
    storePath = execFileSync('pnpm', ['store', 'path'], {
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    }).trim();
  } catch {
    return null;
  }
  if (storePath === '' || !existsSync(storePath)) return null;
  return { path: storePath, apparentBytes: apparentBytes(storePath, deadline) };
}

/** The lazy census child's wall-clock budget: past it, a partial record and exit. */
export const LAZY_CENSUS_BUDGET_MS = 3 * 60 * 1000;

/**
 * Whether a live census holds the lock (its heartbeat is fresh).
 *
 * @param dir - The census directory (tests).
 * @param now - Current time (ms).
 * @returns True while another census runs.
 */
export function censusLockHeld(dir = censusDir(), now = Date.now()): boolean {
  try {
    return now - statSync(join(dir, 'census.lock')).mtimeMs < CENSUS_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * The command prefix that runs a child at background CPU and I/O priority,
 * where the platform has one: `taskpolicy -b` on macOS, `ionice -c 3` on
 * Linux. Empty elsewhere (the child still lowers its CPU priority itself).
 */
function lowPriorityPrefix(): string[] {
  if (process.platform === 'darwin' && existsSync('/usr/sbin/taskpolicy')) {
    return ['/usr/sbin/taskpolicy', '-b'];
  }
  if (process.platform === 'linux') {
    for (const dir of ['/usr/bin', '/bin']) {
      if (existsSync(join(dir, 'ionice'))) return [join(dir, 'ionice'), '-c', '3'];
    }
  }
  return [];
}

/**
 * Start the daily report-only census in a detached child (T14275), unless a
 * live census holds the lock or today's run is already claimed. The child has
 * no stdin, writes stdout and stderr to `<dir>/census.log`, runs at background
 * priority, stops at {@link LAZY_CENSUS_BUDGET_MS} with a partial record, and
 * exits. Callers check {@link censusSpawnAllowed} first.
 *
 * @param env - The child's environment (git hook variables already stripped).
 * @param deps - `spawn`, `dir` and `now` (tests).
 * @returns Why nothing started, or `null` when the child started.
 * @task T14275
 */
export function startLazyCensus(
  env: NodeJS.ProcessEnv,
  deps: {
    spawn?: (command: string, args: string[], options: SpawnOptions) => { unref(): void };
    dir?: string;
    now?: number;
  } = {},
): string | null {
  const dir = deps.dir ?? censusDir();
  const now = deps.now ?? Date.now();
  mkdirSync(dir, { recursive: true });
  if (censusLockHeld(dir, now)) return 'another census holds the lock';
  if (!claimCensus(now, dir)) return 'already claimed in the last 24 h';
  const entry = import.meta.url;
  const script = `import(${JSON.stringify(entry)}).then((m) => m.runLazyCensus(${JSON.stringify(dir)}))`;
  const log = openSync(join(dir, 'census.log'), 'a');
  try {
    const [cmd, ...pre] = [...lowPriorityPrefix(), process.execPath];
    const spawnFn = deps.spawn ?? spawn;
    spawnFn(cmd as string, [...pre, '--input-type=module', '-e', script], {
      detached: true,
      stdio: ['ignore', log, log],
      env,
    }).unref();
  } finally {
    closeSync(log);
  }
  return null;
}

/**
 * The lazy census child's body (T14275): background CPU priority, a
 * {@link LAZY_CENSUS_BUDGET_MS} wall-clock budget (a partial record past it),
 * and a hard exit shortly after the budget so a hung `git` can never keep the
 * process alive. The lock is released on every exit path.
 *
 * @param dir - The census directory.
 * @task T14275
 */
export async function runLazyCensus(dir = censusDir()): Promise<void> {
  try {
    setPriority(19);
  } catch {
    // Not permitted here: the budget still bounds the run.
  }
  setTimeout(() => process.exit(2), LAZY_CENSUS_BUDGET_MS + 60_000).unref();
  const result = await runWorktreeCensus({
    recordDir: dir,
    deadline: Date.now() + LAZY_CENSUS_BUDGET_MS,
  });
  // The run's line goes to the census's own log file (core never writes
  // stdout; the child's logger is uninitialized and would drop an info line).
  appendFileSync(
    join(dir, 'census.log'),
    `${new Date().toISOString()} census ${'skipped' in result ? `skipped: ${result.skipped}` : `${result.record.partial ? 'partial' : 'complete'}: ${result.recordPath}`}\n`,
  );
  process.exit(0);
}

/**
 * Whether a read command may start the lazy census: never in CI, under vitest,
 * or in a process git started (T14189: a hook carries GIT_EXEC_PATH,
 * GIT_INDEX_FILE or GIT_DIR).
 *
 * @param env - The environment.
 * @returns True when a detached census may be spawned.
 * @task T14275
 */
export function censusSpawnAllowed(env: NodeJS.ProcessEnv): boolean {
  if (env['CI'] === 'true' || env['VITEST'] !== undefined) return false;
  return !(env['GIT_EXEC_PATH'] || env['GIT_INDEX_FILE'] || env['GIT_DIR']);
}

/**
 * Claim today's lazy census, atomically: true for exactly one caller per
 * {@link CENSUS_INTERVAL_MS} on this machine.
 *
 * @param now - Current time (ms).
 * @param dir - The census directory (tests).
 * @returns True when this caller should start the census.
 * @task T14275
 */
export function claimCensus(now = Date.now(), dir = censusDir()): boolean {
  mkdirSync(dir, { recursive: true });
  return claimAtMostEvery(join(dir, 'census.claim'), CENSUS_INTERVAL_MS, now);
}

/**
 * The newest census record, or `null` when none was written.
 *
 * @param dir - The census directory (tests).
 * @returns The record from `latest.json`.
 * @task T14275
 */
export function readLatestCensus(dir = censusDir()): CensusRecord | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf-8')) as CensusRecord;
  } catch {
    return null;
  }
}

/**
 * The briefing's one census line (T14275): how many worktrees the last census
 * kept and their apparent size, or `null` when it kept none (or never ran).
 *
 * @param dir - The census directory (tests).
 * @returns e.g. "12 worktrees (3.4 GB) kept: run `cleo hygiene census --report`".
 * @task T14275
 */
export function censusBriefingLine(dir = censusDir()): string | null {
  const record = readLatestCensus(dir);
  if (record === null || record.kept.length === 0) return null;
  const keptPaths = new Set(record.kept.map((k) => k.path));
  const bytes = record.rows
    .filter((r) => keptPaths.has(r.path))
    .reduce((n, r) => n + r.apparentBytes, 0);
  const gb = (bytes / 1024 ** 3).toFixed(1);
  return `${record.kept.length} worktrees (${gb} GB) kept: run \`cleo hygiene census --report\``;
}
