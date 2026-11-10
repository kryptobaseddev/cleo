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
 * @task T14275
 */

import { type SpawnOptions, spawn } from 'node:child_process';
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
import type { WorktreeInfo, WorktreeStatusCategory } from '@cleocode/contracts';
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
  /** Selected by the TTL and retained-size budget, including in a dry run. */
  selected?: boolean;
  /** Set when `--apply` removed it. */
  removed?: boolean;
}

/** The record one census run writes. */
export interface CensusRecord {
  /** Record format version. */
  schemaVersion: 1;
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
  const { disposeWorktree } = await import('@cleocode/worktree');
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
      const terminal =
        worktree.taskId !== null &&
        (worktree.owningTaskStatus === 'done' || worktree.owningTaskStatus === 'cancelled');
      const classified =
        terminal && worktree.taskId !== null
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
      const row: CensusRow = {
        project,
        projectHash: computeProjectHash(project),
        path,
        taskId: worktree.taskId,
        category: classified.statusCategory,
        ...(classified.keepReason !== undefined ? { keepReason: classified.keepReason } : {}),
        apparentBytes: apparentBytes(path, deadline),
        branch: worktree.branch,
        lastActivity: worktree.lastActivity,
        taskStatus: worktree.owningTaskStatus,
      };
      // A known task id without readable task state is not a taskless orphan.
      if (row.taskStatus === null && (row.taskId !== null || row.category === 'redundant')) {
        row.category = 'unknown';
        row.keepReason =
          row.taskId === null
            ? 'task ownership unavailable (report only)'
            : 'owning task state unavailable (report only)';
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
      if (status === undefined || status !== row.taskStatus || status === 'active') {
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
  return {
    schemaVersion: 1,
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
  };
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
