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

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
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
}

/** Where the census keeps its record, claim and lock. */
function censusDir(): string {
  return join(getCleoHome(), 'hygiene', 'census');
}

/** Apparent size of a tree: the sum of sizes, symlinks not followed; 0 when unreadable. */
export function apparentBytes(path: string): number {
  let total = 0;
  const stack = [path];
  while (stack.length > 0) {
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

/** Registered project roots from the nexus registry; `[]` when it cannot be read. */
async function registeredProjects(): Promise<string[]> {
  try {
    const { nexusList } = await import('../nexus/registry.js');
    return (await nexusList()).map((p) => p.path);
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
  try {
    return writeRecord(dir, await census(opts));
  } finally {
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
  const { listWorktrees, worktreeInUseProbe } = await import('../worktree/list.js');
  const { loadTaskEvidence } = await import('../worktree/prune.js');
  const startedAt = new Date().toISOString();
  const machineRoot = opts.machineRoot ?? getCleoWorktreesRoot();
  const apply = opts.apply === true;
  const applyProjects = new Set((opts.applyProjects ?? []).map(canonical));
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
    const hashDir = join(machineRoot, projectHash);
    const project = projectByHash.get(projectHash) ?? null;
    const listed = new Map<
      string,
      {
        category: WorktreeStatusCategory;
        keepReason?: string;
        taskId: string | null;
        isMerged: boolean;
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
      const path = join(hashDir, name);
      const hit = listed.get(canonical(path));
      const row: CensusRow = hit
        ? {
            project,
            projectHash,
            path,
            taskId: hit.taskId,
            category: hit.category,
            ...(hit.keepReason !== undefined ? { keepReason: hit.keepReason } : {}),
            apparentBytes: apparentBytes(path),
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
            apparentBytes: apparentBytes(path),
          };
      rows.push(row);
      meta.set(row, { isMerged: hit?.isMerged ?? false });
    }
  }

  const dfFreeBefore = apply ? freeBytes(machineRoot) : null;
  let reclaimed = 0;
  if (apply) {
    const { disposeWorktree, readWorktreeTaskLock } = await import('@cleocode/worktree');
    for (const row of rows) {
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
  };
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
