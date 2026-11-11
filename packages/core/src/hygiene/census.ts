/**
 * The machine-wide worktree census (T14275, durability plan S3 / C-F3).
 *
 * The worktree root (`<cleoHome>/worktrees/<projectHash>/…`) is per machine,
 * but every other cleanup path resolves one project's hash directory, so the
 * worktrees of projects never run from their root (other repositories,
 * deleted ones, scratch clones) were never swept: 484 had accumulated. The
 * CI cleanup workflow ran where no worktree exists and swallowed every error.
 *
 * The census walks every project hash directory and every registered project's
 * git worktree registry (including unadopted external worktrees):
 *
 * - a directory whose hash matches a registered project (the nexus registry)
 *   is classified by that project's {@link listWorktrees}: the disposal proof
 *   decides `redundant`, `keep` (with the failing clause) or `unknown`, and
 *   an open task or a fresh worktree is `active` (T14274);
 * - a directory no registered project owns, and any directory git does not
 *   list as a worktree, is reported `unknown`, report only.
 *
 * The CLI reports by default. `--apply` removes only `redundant` terminal
 * worktrees of the allowed projects (current project unless `--all-projects`);
 * automatic completion and scheduled cleanup opt in explicitly, each re-proved by
 * `disposeWorktree` with the task's evidence. Every run writes one census
 * record (counts, apparent bytes, bytes reclaimed, the free-space delta and
 * every kept worktree with its reason) under `<cleoHome>/hygiene/census/`.
 *
 * One census runs at a time per machine (a heartbeat lock), and the lazy spawn
 * claims at most one run per project per 24 h; it never starts in CI, under vitest, or in
 * a process git started (T14189).
 *
 * Every row also carries the visibility fields the machine-hygiene epic needs
 * (T14440): the owning task's status, last activity and creation time, git and
 * task locks, the dirty-entry count, and the `node_modules` kind and size.
 * Per project the record rolls up worktree counts, bytes and merged local and
 * remote branches, and names why each project's store was or was not read;
 * machine-wide it names the orphan hash directories and the global pnpm
 * store's size.
 *
 * @task T14275
 * @task T14440
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
import { homedir, setPriority } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { WorktreeInfo, WorktreeStatusCategory } from '@cleocode/contracts';
import type { WorktreeLockRecord } from '@cleocode/contracts/operations/worktree.js';
import { computeProjectHash, getCleoHome, getCleoWorktreesRoot } from '@cleocode/paths';
import { acquireHeartbeatLock, claimAtMostEvery } from '../tasks/merge-close.js';
import { appendWorktreeAuditEntry, resolveWorktreeAuditActor } from '../worktree/audit.js';

/** The lazy census runs at most this often per project. */
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
  /** The branch is retained after removal. */
  branch?: string;
  /** Last recorded activity, used to order eligible worktrees oldest first. */
  lastActivity?: string;
  /** Task state at discovery; only done and cancelled tasks are removal candidates. */
  taskStatus?: string | null;
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
  /** Selected by the TTL and retained-size budget, including in a dry run. */
  selected?: boolean;
  /** Set when `--apply` removed it. */
  removed?: boolean;
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
  /**
   * The foreign-store verdict behind this rollup's task statuses: `read` when
   * the store was opened, otherwise why it was skipped (T14440 AC3).
   */
  storeRead: string;
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
  /** Minimum idle age of eligible worktrees, in days. */
  ttlDays?: number;
  /** Target retained apparent bytes; safety and TTL may prevent reaching it. */
  maxBytes?: number;
  /** Registered projects that could not be assessed; never eligible for removal. */
  projectErrors?: Array<{ project: string; error: string }>;
  /** Per-project rollup: worktree count, bytes, merged branches, store verdict (T14440). */
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
  /** Explicitly allow removal in every registered project. */
  allProjects?: boolean;
  /** Minimum idle age in days (default: zero); a budget never overrides it. */
  ttlDays?: number;
  /** Stop removing once retained apparent bytes reach this budget (default: zero). */
  maxBytes?: number;
  /** Explicitly allow merged ignored build output to be regenerated; never force-archive. */
  exemptRegenerable?: boolean;
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
  /**
   * Merged-branch counter override (tests). Default: {@link mergedBranchCounts}
   * with the walk deadline and the worker-bounded SDK probe.
   */
  branchesOf?: (projectRoot: string) => Promise<{
    mergedLocal: number | null;
    mergedRemote: number | null;
  }>;
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
 * @param onError - Capture missing registry coverage in the census receipt.
 * @returns Each registered project's path.
 * @internal Exported for tests.
 */
export async function registeredProjects(
  load?: () => Promise<ReadonlyArray<{ path: string }>>,
  onError?: (message: string) => void,
): Promise<string[]> {
  try {
    const list = load ?? (await import('../nexus/registry.js')).nexusList;
    return (await list()).map((p) => p.path);
  } catch (err) {
    onError?.(err instanceof Error ? err.message : String(err));
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
  for (const value of [opts.ttlDays, opts.maxBytes]) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      // @sync-invariant none:input-shape invalid local retention limits cannot select worktrees
      throw new RangeError('Worktree TTL and size budget must be finite, non-negative numbers.');
    }
  }
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
  const {
    classifyStatus,
    isPrimaryWorktree,
    listWorktrees,
    loadOwningTaskStatuses,
    resolvePrimaryWorktreePath,
  } = await import('../worktree/list.js');
  const { worktreeReaperInUseProbe } = await import('../worktree/in-use-probe.js');
  const { loadTaskEvidence } = await import('../worktree/prune.js');
  const { disposeWorktree, readWorktreeTaskLock } = await import('@cleocode/worktree');
  const { isOwnProjectRoot, projectStatusReadLabel } = await import('../worktree/list.js');
  const startedAt = new Date().toISOString();
  const machineRoot = opts.machineRoot ?? getCleoWorktreesRoot();
  const apply = opts.apply === true;
  const applyProjects = new Set((opts.applyProjects ?? []).map(canonical));
  const ttlDays = opts.ttlDays ?? 0;
  const maxBytes = opts.maxBytes ?? 0;
  const deadline = opts.deadline ?? Number.POSITIVE_INFINITY;
  let partial = false;
  const projectErrors: NonNullable<CensusRecord['projectErrors']> = [];
  const outOfTime = (): boolean => {
    const expired = Date.now() > deadline;
    if (expired) partial = true;
    return expired;
  };
  const projects = [
    ...new Set(
      (
        opts.projects ??
        (await registeredProjects(undefined, (error) => {
          partial = true;
          projectErrors.push({ project: 'registry', error });
        }))
      ).map(canonical),
    ),
  ];
  if (opts.allProjects === true) for (const project of projects) applyProjects.add(project);
  const projectByHash = new Map<string, string>();
  for (const p of projects)
    if (existsSync(p)) projectByHash.set(computeProjectHash(p), canonical(p));

  const rows: CensusRow[] = [];
  const meta = new Map<CensusRow, WorktreeInfo>();
  const seen = new Set<string>();
  // Git's registry covers adopted AND unadopted external worktrees, including
  // projects that have never had a canonical hash directory on this machine.
  for (const project of projects) {
    if (outOfTime()) break;
    if (!existsSync(project)) {
      partial = true;
      projectErrors.push({ project, error: 'registered project path is unavailable' });
      continue;
    }
    const result = await listWorktrees({
      projectRoot: project,
      exemptRegenerable: opts.exemptRegenerable === true,
    });
    if (!result.success) {
      partial = true;
      projectErrors.push({ project, error: result.error.message });
      continue;
    }
    const primary = resolvePrimaryWorktreePath(project);
    for (const worktree of result.data.worktrees) {
      if (outOfTime()) break;
      const path = canonical(worktree.path);
      if (isPrimaryWorktree(path, primary) || path === project || seen.has(path)) continue;
      seen.add(path);
      // T14440 (round 7): a FOREIGN project's row never reaches the reaper's
      // probe, disposal or any store-opening liveness code — its liveness is
      // 'unknown (foreign project)' and it is never a removal candidate. Own
      // rows keep main's behaviour exactly.
      const own = isOwnProjectRoot(project);
      const terminal =
        own &&
        worktree.taskId !== null &&
        (worktree.owningTaskStatus === 'done' || worktree.owningTaskStatus === 'cancelled');
      const classified = !own
        ? { statusCategory: 'unknown' as const, keepReason: 'unknown (foreign project)' }
        : terminal && worktree.taskId !== null
          ? classifyStatus(
              disposeWorktree({
                worktreePath: path,
                projectRoot: project,
                taskId: worktree.taskId,
                reason: 'census',
                dryRun: true,
                evidence: await loadTaskEvidence(project, worktree.taskId),
                exemptRegenerable: opts.exemptRegenerable === true && worktree.isMerged,
                inUse: await worktreeReaperInUseProbe(project, worktree.taskId, path),
              }),
            )
          : { statusCategory: worktree.statusCategory, keepReason: worktree.keepReason };
      const rowProjectHash = computeProjectHash(project);
      const nm = classifyNodeModules(path);
      const row: CensusRow = {
        project,
        projectHash: rowProjectHash,
        path,
        taskId: worktree.taskId,
        category: classified.statusCategory,
        ...(classified.keepReason !== undefined ? { keepReason: classified.keepReason } : {}),
        apparentBytes: apparentBytes(path, deadline),
        branch: worktree.branch,
        lastActivity: worktree.lastActivity,
        taskStatus: worktree.owningTaskStatus,
        // T14440 visibility fields, off the classifier and the filesystem.
        createdAt: worktree.createdAt ?? null,
        gitLocked: worktree.lockState === 'locked',
        taskLocked: readTaskLockSafe(readWorktreeTaskLock, rowProjectHash, worktree.taskId),
        dirtyFiles: dirtyFileCount(path, deadline),
        nodeModules: nm,
        nodeModulesBytes: nm === 'real' ? apparentBytes(join(path, 'node_modules'), deadline) : 0,
      };
      // A known task id without readable task state is not a taskless orphan.
      if (row.taskStatus === null && (row.taskId !== null || row.category === 'redundant')) {
        row.category = 'unknown';
        row.keepReason =
          row.taskId === null
            ? 'task ownership unavailable (report only)'
            : 'owning task state unavailable (report only)';
      }
      // Round 7: the foreign liveness label wins over the null-status
      // relabel above — the snapshot could not see the WAL, which is exactly
      // why the row is not a candidate.
      if (!own) {
        row.category = 'unknown';
        row.keepReason = 'unknown (foreign project)';
      }
      rows.push(row);
      meta.set(row, worktree);
    }
  }
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
    let children: string[] = [];
    try {
      children = readdirSync(hashDir).filter((n) => lstatSync(join(hashDir, n)).isDirectory());
    } catch {
      children = [];
    }
    for (const name of children.sort()) {
      if (outOfTime()) break;
      const path = join(hashDir, name);
      if (seen.has(canonical(path))) continue;
      const nm = classifyNodeModules(path);
      const row: CensusRow = {
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
        createdAt: null,
        gitLocked: false,
        taskLocked: false,
        dirtyFiles: null,
        nodeModules: nm,
        nodeModulesBytes: nm === 'real' ? apparentBytes(join(path, 'node_modules'), deadline) : 0,
      };
      rows.push(row);
    }
  }

  const dfFreeBefore = apply ? freeBytes(machineRoot) : null;
  let reclaimed = 0;
  let retainedBytes = rows.reduce((total, row) => total + row.apparentBytes, 0);
  const oldestFirst = [...rows].sort(
    (a, b) =>
      (a.lastActivity ?? '').localeCompare(b.lastActivity ?? '') || a.path.localeCompare(b.path),
  );
  for (const row of oldestFirst) {
    if (outOfTime()) break;
    if (row.category !== 'redundant' || row.project === null) continue;
    if (row.taskId === null || (row.taskStatus !== 'done' && row.taskStatus !== 'cancelled'))
      continue;
    if (!applyProjects.has(row.project)) continue;
    const age = Date.now() - Date.parse(row.lastActivity ?? '');
    if (!Number.isFinite(age) || age < ttlDays * 86_400_000 || retainedBytes <= maxBytes) continue;
    row.selected = true;
    if (!apply) {
      retainedBytes -= row.apparentBytes;
      continue;
    }
    // An active/reopened task or a store failure after listing cancels removal.
    if (row.taskId !== null) {
      const lookup = await loadOwningTaskStatuses([row.taskId], row.project);
      const status = lookup.success ? lookup.data.get(row.taskId) : undefined;
      if (status === undefined || status !== row.taskStatus) {
        row.category = 'unknown';
        row.keepReason = 'owning task changed or could not be re-read; nothing removed';
        continue;
      }
    }
    // Re-proved here, with the task's evidence: the listing was a dry run.
    const disposal = disposeWorktree({
      worktreePath: row.path,
      projectRoot: row.project,
      taskId: row.taskId,
      reason: 'census',
      evidence: await loadTaskEvidence(row.project, row.taskId),
      exemptRegenerable: opts.exemptRegenerable === true && meta.get(row)?.isMerged === true,
      inUse: await worktreeReaperInUseProbe(row.project, row.taskId, row.path),
    });
    if (disposal.removed) {
      row.removed = true;
      reclaimed += row.apparentBytes;
      retainedBytes -= row.apparentBytes;
    } else {
      row.category = disposal.indeterminate === true ? 'unknown' : 'keep';
      row.keepReason = disposal.keptReason ?? 'kept';
    }
    appendWorktreeAuditEntry(row.project, {
      actor: resolveWorktreeAuditActor(),
      action: 'prune',
      target: row.path,
      ...(row.taskId !== null ? { taskId: row.taskId } : {}),
      ...(row.branch !== undefined ? { branch: row.branch } : {}),
      reason: 'census',
      success: disposal.removed,
      ...(row.keepReason !== undefined ? { error: row.keepReason } : {}),
    });
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
  // T14440: one overall deadline — every measurement below shares the walk's,
  // so a truncation is always visible in `partial`.
  const registeredRollups = [...projectByHash.entries()].map(([hash, root]) => ({
    project: root,
    projectHash: hash,
  }));
  const branchesOf =
    opts.branchesOf ?? ((projectRoot: string) => mergedBranchCounts(projectRoot, deadline));
  const rollups = await projectRollups(rows, registeredRollups, branchesOf, (projectRoot) =>
    projectStatusReadLabel(projectRoot),
  );
  const store = opts.pnpmStore === undefined ? pnpmStoreCensus(deadline) : null;
  outOfTime();
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
    ttlDays,
    maxBytes,
    projectErrors,
    projects: rollups.rollups,
    orphanFolders: rollups.orphans,
    pnpmStore: opts.pnpmStore === undefined ? store : opts.pnpmStore,
  };
}

/** Wall-clock budget note: the merged-branch and pnpm measurements share the walk deadline. */

/**
 * Per-project rollups over the census rows, seeded with every registered
 * project (a project with zero worktrees keeps its branch counts, T14440
 * review P2e), plus the orphan hash directories.
 *
 * Merged-branch probes run once per registered project (never for orphans);
 * a probe failure records `null`, never a zero. The store verdict is the
 * same read-only probe the listing's enrichment used, so `storeRead` names
 * exactly why task statuses are present or absent.
 *
 * @param rows - The census rows.
 * @param registered - Every registered project root and its hash.
 * @param branchesOf - Merged-branch counter (tests stub it).
 * @param verdictOf - The foreign-store read verdict (tests stub it).
 * @returns Rollups keyed by hash dir and the orphan directories among them.
 */
async function projectRollups(
  rows: readonly CensusRow[],
  registered: ReadonlyArray<{ project: string; projectHash: string }>,
  branchesOf: (projectRoot: string) => Promise<{
    mergedLocal: number | null;
    mergedRemote: number | null;
  }>,
  verdictOf: (projectRoot: string) => Promise<string>,
): Promise<{ rollups: ProjectCensusRollup[]; orphans: OrphanHashDir[] }> {
  const byHash = new Map<string, ProjectCensusRollup>();
  const seed = async (
    project: string | null,
    projectHash: string,
  ): Promise<ProjectCensusRollup> => {
    const existing = byHash.get(projectHash);
    if (existing) return existing;
    const rollup: ProjectCensusRollup = {
      project,
      projectHash,
      worktrees: 0,
      apparentBytes: 0,
      mergedLocalBranches: null,
      mergedRemoteBranches: null,
      orphan: project === null,
      storeRead: project === null ? 'not read: orphan directory' : await verdictOf(project),
    };
    byHash.set(projectHash, rollup);
    return rollup;
  };
  for (const entry of registered) await seed(entry.project, entry.projectHash);
  for (const row of rows) {
    const rollup = await seed(row.project, row.projectHash);
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

/** The plan shape the worker returns (a subset of the SDK prune plan). */
export interface BoundedPrunePlan {
  candidates: Array<{ kind: string; branch?: string | undefined }>;
}

/** Where the compiled worker file lives, or `null` (resolveWorkerPath pattern). */
function resolvePrunePlanWorkerPath(): string | null {
  try {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    // dist build: the compiled .js next to census.js; vitest/source: the .ts
    // sibling (Node 24 type stripping runs it, and it exists in the checkout).
    for (const name of ['prune-plan-worker.js', 'prune-plan-worker.ts']) {
      const candidate = join(currentDir, name);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The SDK integration probe, run in a Worker built from a REAL module file
 * (never eval — an eval worker inherits the parent's `--input-type=module`
 * and cannot bootstrap) that the shared deadline TERMINATES (T14440, round 5).
 * The napi `pruneWorktrees` walk over a large repository is synchronous and
 * uninterruptible in-process, so it runs off-thread and a deadline overrun
 * kills it before the census releases its lock. Any failure yields `null` —
 * a failed probe is never a zero.
 *
 * @param repoRoot - The repository root to probe.
 * @param integrationTarget - The branch "merged" is tested against.
 * @param deadline - Wall-clock ms epoch; past it the worker is terminated.
 * @returns The prune plan, or `null`.
 */
export async function prunePlanBounded(
  repoRoot: string,
  integrationTarget: string,
  deadline: number,
  /** Test hook: the worker writes this file markerDelayMs after the walk. */
  markerPath?: string,
  /** Test hook: the marker delay (ms) after the walk completes. */
  markerDelayMs?: number,
  /** Test hook: invoked when the worker has fully exited (round 7, item 5). */
  onWorkerExit?: () => void,
): Promise<BoundedPrunePlan | null> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return null;
  const workerPath = resolvePrunePlanWorkerPath();
  if (workerPath === null) {
    // No worker file (unexpected — the build emits it next to this module):
    // fall back in-process. Not interruptible; the census re-checks the
    // deadline afterwards and marks the record partial.
    const { buildGitAwarePrunePlan } = await import('@cleocode/worktree');
    return buildGitAwarePrunePlan(repoRoot, integrationTarget) as BoundedPrunePlan | null;
  }
  const worker = new Worker(workerPath, {
    // Round 7 (item 4): execArgv literally [] — the parent may run with
    // --input-type=module (the lazy census child spawns that way), and an
    // inherited --input-type makes the Worker throw ERR_INPUT_TYPE_NOT_ALLOWED.
    execArgv: [],
    workerData: {
      requireFrom: fileURLToPath(import.meta.url),
      repoRoot,
      integrationTarget,
      markerPath,
      markerDelayMs,
    },
  });
  // Resolution contract: the plan resolves on `message`; a deadline
  // termination resolves only on `exit` — which fires after `terminate()`
  // completes — so the census never releases its lock while the worker's
  // native git walk is still running (T14440 review round 4).
  interface PrunePlanWorkerMessage {
    plan?: { candidates?: Array<{ kind: string; branch?: string | undefined }> };
    error?: string;
  }
  let received: PrunePlanWorkerMessage | null = null;
  return new Promise((resolvePromise) => {
    let settled = false;
    const settle = (value: BoundedPrunePlan | null) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolvePromise(value);
    };
    // AC1 (round 4): no deadline means no timer — `Infinity` clamps to 1 ms
    // and would kill every probe while it still runs.
    const timer = Number.isFinite(remainingMs)
      ? setTimeout(() => {
          void worker.terminate();
        }, remainingMs)
      : null;
    worker.once('message', (message: PrunePlanWorkerMessage) => {
      received = message;
    });
    worker.once('error', (error: Error) => {
      received = { error: error.message };
    });
    worker.once('exit', () => {
      onWorkerExit?.();
      const plan = received?.plan;
      settle(plan && Array.isArray(plan.candidates) ? { candidates: plan.candidates } : null);
    });
  });
}

/**
 * Merged-branch counts for one project: local via the worker-bounded SDK
 * integration probe (primary checkout and target excluded), remote via
 * `git for-each-ref --merged` with HEAD refs excluded, all under the shared
 * walk deadline. `null` per side when its probe fails or the deadline ends -
 * a failed probe is never a zero (T14440).
 *
 * @param projectRoot - The registered project's repository root.
 * @param deadline - Wall-clock ms epoch past which probes stop.
 * @param planOf - The SDK probe (tests stub it; default {@link prunePlanBounded}).
 * @returns Merged local and remote branch counts.
 */
export async function mergedBranchCounts(
  projectRoot: string,
  deadline = Number.POSITIVE_INFINITY,
  planOf: (
    repoRoot: string,
    integrationTarget: string,
    deadline: number,
  ) => Promise<BoundedPrunePlan | null> = prunePlanBounded,
): Promise<{ mergedLocal: number | null; mergedRemote: number | null }> {
  if (Date.now() > deadline) return { mergedLocal: null, mergedRemote: null };
  let mergedLocal: number | null = null;
  let mergedRemote: number | null = null;
  try {
    const plan = await planOf(projectRoot, 'main', deadline);
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
 * @param read - The lock reader (`readWorktreeTaskLock`).
 * @param projectHash - The project hash directory.
 * @param taskId - The owning task, or `null`.
 * @returns True when a live task lock record exists.
 */
function readTaskLockSafe(
  read: (projectHash: string, taskId: string) => WorktreeLockRecord | null,
  projectHash: string,
  taskId: string | null,
): boolean {
  if (taskId === null) return false;
  return read(projectHash, taskId) !== null;
}

/**
 * The global pnpm content-addressable store and its apparent size (T14440).
 * `pnpm store path` resolves the location from the home dir (an inherited
 * per-worktree cwd would honour that worktree's `.npmrc` store-dir); any
 * failure yields `null`, never a zero-sized store.
 *
 * @param deadline - Past it, `null`.
 * @returns The store census, or `null`.
 */
export function pnpmStoreCensus(deadline = Number.POSITIVE_INFINITY): PnpmStoreCensus | null {
  if (Date.now() > deadline) return null;
  let storePath: string;
  try {
    storePath = execFileSync('pnpm', ['store', 'path'], {
      cwd: homedir(),
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
    /** Canonical project root: each project has its own daily claim. */
    projectRoot?: string;
  } = {},
): string | null {
  const dir = deps.dir ?? censusDir();
  const now = deps.now ?? Date.now();
  mkdirSync(dir, { recursive: true });
  if (censusLockHeld(dir, now)) return 'another census holds the lock';
  if (!claimCensus(now, dir, deps.projectRoot)) return 'already claimed in the last 24 h';
  const entry = import.meta.url;
  const script = `import(${JSON.stringify(entry)}).then((m) => m.runLazyCensus(${JSON.stringify(dir)}, ${JSON.stringify(deps.projectRoot)}))`;
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
 * @param projectRoot - The project captured by the scheduling caller.
 * @task T14275
 */
export async function runLazyCensus(dir = censusDir(), projectRoot?: string): Promise<void> {
  try {
    setPriority(19);
  } catch {
    // Not permitted here: the budget still bounds the run.
  }
  setTimeout(() => process.exit(2), LAZY_CENSUS_BUDGET_MS + 60_000).unref();
  const { getProjectRoot } = await import('../paths.js');
  try {
    projectRoot ??= getProjectRoot();
  } catch {
    /* no project: report only */
  }
  const result = await runWorktreeCensus({
    apply: projectRoot !== undefined,
    applyProjects: projectRoot !== undefined ? [projectRoot] : [],
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
 * Claim today's lazy census, atomically: one caller per project per interval,
 * or one machine-wide report when no project is supplied.
 *
 * @param now - Current time (ms).
 * @param dir - The census directory (tests).
 * @param projectRoot - The canonical project root whose daily run is claimed.
 * @returns True when this caller should start the census.
 * @task T14275
 */
export function claimCensus(now = Date.now(), dir = censusDir(), projectRoot?: string): boolean {
  mkdirSync(dir, { recursive: true });
  const name = projectRoot === undefined ? 'census' : `census-${computeProjectHash(projectRoot)}`;
  return claimAtMostEvery(join(dir, `${name}.claim`), CENSUS_INTERVAL_MS, now);
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
