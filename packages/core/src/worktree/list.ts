/**
 * Structured worktree enumeration with status classification (T9546).
 *
 * Exposes {@link listWorktrees} — the SDK primitive behind the
 * `cleo worktree list` CLI command and the `worktree.list` dispatch operation.
 *
 * For each worktree returned by `git worktree list --porcelain`, the function
 * resolves:
 *  - `taskId` (regex match against the branch name `task/T####`).
 *  - `owningTaskStatus` (read from the tasks SSoT via {@link openCleoDb}).
 *  - `lastActivity` (newest commit on the branch, falling back to dir mtime).
 *  - `isLocked` (porcelain `locked` line).
 *  - `isMerged` (`git merge-base --is-ancestor <branch> main`, exit-0 ⇒ merged).
 *  - `isStale`  (no commits in >N days AND (task done/cancelled OR merged)).
 *  - `owningAgent` (best-effort from `.git/worktree.json` if present).
 *  - `statusCategory` — one of `locked|orphan|merged|stale|active`, resolved
 *    by precedence in {@link classifyStatus}.
 *  - `source` — origin of the worktree: `cleo-spawn`, `claude-agent`, `manual`,
 *                or `adopted`. Set by consulting the sentinel index at
 *                `<projectRoot>/.cleo/worktrees.json` (T9804).
 *
 * Multi-source listing (T9804): After enumerating git-native worktrees the
 * function reads the sentinel index and appends any entries whose `path` is
 * NOT already present in the porcelain output. This ensures that worktrees
 * created by Claude Code Agent `isolation:worktree` (and subsequently adopted
 * via `cleo worktree adopt`) appear in `cleo worktree list` alongside the
 * canonical CLEO-spawned worktrees.
 *
 * All git invocations are bounded by an explicit 60-second supervisor
 * timeout, matching the {@link runGitWithLockRetry} discipline used elsewhere
 * in `packages/core/src/release/engine-ops.ts`. We intentionally do NOT use
 * `runGitWithLockRetry` directly here — these read-only queries never touch
 * `.git/index.lock`, so the retry/backoff dance would be pure overhead.
 *
 * @task T9546
 * @task T9804 — multi-source listing (sentinel index union)
 * @adr ADR-068 — DB chokepoint (openCleoDb)
 * @adr ADR-062 — git merge-no-ff integration semantics
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, join, resolve as resolvePath } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  type EngineResult,
  engineError,
  engineSuccess,
  type ListWorktreesOpts,
  type ListWorktreesResult,
  type WorktreeInfo,
  type WorktreeSource,
  type WorktreeStatusCategory,
} from '@cleocode/contracts';
import { resolveOrCwd } from '../paths.js';
import { openCleoDb } from '../store/open-cleo-db.js';
import { readSentinelIndex } from './sentinel-index.js';

/** Default staleness threshold — branches/worktrees idle longer than this are stale candidates. */
const DEFAULT_STALE_DAYS = 7;

/** Default supervisor timeout for every git invocation (matches engine-ops.ts). */
const GIT_TIMEOUT_MS = 60_000;

/** Default upstream branch name used for `merge-base --is-ancestor` checks. */
const DEFAULT_MAIN_BRANCH = 'main';

/**
 * One row of porcelain output from `git worktree list --porcelain`.
 *
 * @internal
 */
interface PorcelainEntry {
  path: string;
  branch: string;
  locked: boolean;
}

/**
 * List all worktrees attached to the given project root, classify each one
 * by activity / merge / lock / orphan state, and return a structured envelope.
 *
 * @param opts - Listing options including project root, filter, and stale-days threshold.
 * @returns EngineResult containing a {@link ListWorktreesResult} on success.
 *
 * @example
 * ```ts
 * const result = await listWorktrees({ projectRoot: process.cwd() });
 * if (result.success) {
 *   for (const wt of result.data.worktrees) {
 *     console.log(wt.path, wt.statusCategory);
 *   }
 * }
 * ```
 */
export async function listWorktrees(
  opts: ListWorktreesOpts = {},
): Promise<EngineResult<ListWorktreesResult>> {
  const projectRoot = resolveOrCwd(opts.projectRoot);
  const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS;
  const staleThresholdMs = staleDays * 24 * 60 * 60 * 1000;
  const nowMs = Date.now();

  let porcelainEntries: PorcelainEntry[];
  try {
    porcelainEntries = enumerateWorktrees(projectRoot);
  } catch (err) {
    return engineError<ListWorktreesResult>(
      'E_GIT_FAILED',
      `Failed to enumerate worktrees: ${err instanceof Error ? err.message : String(err)}`,
      { fix: 'Run `git worktree list --porcelain` manually to diagnose.' },
    );
  }

  // --- T9804: Load sentinel index to resolve source labels and union entries ---
  // Read the sentinel index (`.cleo/worktrees.json`) for adopted/claude-agent
  // worktrees. We build a path → source map so each git-native entry can be
  // labelled accurately, and we track which sentinel paths are NOT in the
  // porcelain output so we can append them as sentinel-only entries below.
  const sentinelEntries = readSentinelIndex(projectRoot);
  const sentinelByPath = new Map(sentinelEntries.map((e) => [e.path, e]));
  // Track paths from porcelain so we can detect sentinel-only entries later.
  const porcelainPaths = new Set(porcelainEntries.map((e) => e.path));

  // Resolve unique task IDs once, then batch-load their statuses through the
  // ADR-068 chokepoint. We open the tasks DB read-only via openCleoDb so the
  // command picks up the SSoT pragma set (T9189) — never via raw DatabaseSync.
  const branchToTaskId = new Map<string, string | null>();
  for (const entry of porcelainEntries) {
    branchToTaskId.set(entry.branch, taskIdFromBranch(entry.branch));
  }
  // Also seed task IDs for sentinel-only entries so they can be batch-loaded.
  for (const sentinel of sentinelEntries) {
    if (!porcelainPaths.has(sentinel.path)) {
      branchToTaskId.set(sentinel.branch, sentinel.taskId ?? taskIdFromBranch(sentinel.branch));
    }
  }
  const taskIds = Array.from(branchToTaskId.values()).filter((id): id is string => id !== null);
  const taskStatusByid = await loadOwningTaskStatuses(taskIds, projectRoot);

  // Pre-resolve the default upstream branch presence — if `main` is absent,
  // `branchIsMergedToMain` would otherwise spuriously throw for every entry.
  const mainBranch = resolveMainBranch(projectRoot);

  // Pre-resolve the primary worktree path. The primary worktree is the
  // canonical project checkout (NOT a `git worktree add` derivative) — it
  // must never be classified as `merged`/`orphan`/`stale`, even though its
  // branch (typically `main`) is trivially an ancestor of itself. Without
  // this guard, `cleo worktree prune --orphaned` would offer to delete the
  // project root.
  const primaryWorktreePath = resolvePrimaryWorktreePath(projectRoot);

  // Pre-resolve the git common dir so `createdAt` can stat the per-worktree
  // admin file `<gitCommonDir>/worktrees/<basename(path)>/HEAD`, which is
  // written exactly once by `git worktree add` and therefore acts as a stable
  // creation-timestamp proxy. Null on failure → callers fall back to dir mtime.
  const gitCommonDir = resolveGitCommonDir(projectRoot);
  // Build a sentinel-path → adoptedAt lookup so adopted entries that ARE in
  // git porcelain (i.e. registered both ways) report the sentinel timestamp
  // as their createdAt — the adopt time is the canonical "tracked by CLEO" moment.
  const sentinelAdoptedAtByPath = new Map(sentinelEntries.map((e) => [e.path, e.adoptedAt]));

  // --- Build WorktreeInfo entries from git-native porcelain output ---
  const worktrees: WorktreeInfo[] = porcelainEntries.map((entry) => {
    const taskId = branchToTaskId.get(entry.branch) ?? null;
    const lastActivityMs =
      getLastCommitTimestampMs(entry.branch, projectRoot) ?? mtimeMs(entry.path);
    const lastActivity = new Date(lastActivityMs).toISOString();
    const isPrimary = isPrimaryWorktree(entry.path, primaryWorktreePath);
    const isMerged = mainBranch
      ? branchIsMergedToMain(entry.branch, projectRoot, mainBranch)
      : false;
    const owningTaskStatus = taskId ? (taskStatusByid.get(taskId) ?? null) : null;
    const owningAgent = readOwningAgent(entry.path);

    const idleMs = nowMs - lastActivityMs;
    const idleOlderThanThreshold = idleMs > staleThresholdMs;
    const ownerTerminal = owningTaskStatus === 'done' || owningTaskStatus === 'cancelled';
    const isOrphan =
      owningTaskStatus === 'cancelled' || (taskId !== null && owningTaskStatus === null);
    // Stale = idle longer than threshold AND (owner is terminal OR branch already integrated).
    const isStale = idleOlderThanThreshold && (ownerTerminal || isMerged);

    const statusCategory = classifyStatus({
      isPrimary,
      isLocked: entry.locked,
      isOrphan,
      isMerged,
      isStale,
    });

    // T9804: look up source from sentinel index. A git-native entry whose path
    // is present in the sentinel index was adopted (or registered externally);
    // entries absent from the index are canonical CLEO-spawned worktrees.
    const sentinelSource = sentinelByPath.get(entry.path)?.source;
    const source: WorktreeSource = sentinelSource ?? 'cleo-spawn';

    // T9546 AC4: createdAt — resolved from the per-worktree git admin file
    // when available, then sentinel adoptedAt, then dir mtime. The git admin
    // HEAD is set exactly once at `git worktree add` time, so its mtime is the
    // best available creation-time proxy for git-native entries.
    const createdAt = resolveCreatedAt({
      worktreePath: entry.path,
      gitCommonDir,
      primaryWorktreePath,
      sentinelAdoptedAt: sentinelAdoptedAtByPath.get(entry.path),
    });

    return {
      path: entry.path,
      branch: entry.branch,
      taskId,
      owningAgent,
      lastActivity,
      createdAt,
      isLocked: entry.locked,
      lockState: entry.locked ? 'locked' : 'unlocked',
      isStale,
      isMerged,
      owningTaskStatus,
      statusCategory,
      source,
    };
  });

  // --- T9804: Append sentinel-only entries (not in git porcelain output) ---
  // These are worktrees that exist in the index but whose directories may have
  // been removed or are NOT known to git (e.g. adopted entries for stale
  // agent worktrees that have already been cleaned up by git gc). We include
  // them so callers know they exist in the registry and can clean them up.
  for (const sentinel of sentinelEntries) {
    if (porcelainPaths.has(sentinel.path)) continue; // Already in git output.

    const taskId = sentinel.taskId ?? taskIdFromBranch(sentinel.branch);
    const owningTaskStatus = taskId ? (taskStatusByid.get(taskId) ?? null) : null;
    const lastActivityMs = mtimeMs(sentinel.path);
    const lastActivity = new Date(lastActivityMs).toISOString();
    const ownerTerminal = owningTaskStatus === 'done' || owningTaskStatus === 'cancelled';
    const idleMs = nowMs - lastActivityMs;
    const isStale = idleMs > staleThresholdMs && (ownerTerminal || true);
    const isOrphan =
      owningTaskStatus === 'cancelled' || (taskId !== null && owningTaskStatus === null);

    const statusCategory = classifyStatus({
      isPrimary: false,
      isLocked: false,
      isOrphan,
      isMerged: false,
      isStale,
    });

    worktrees.push({
      path: sentinel.path,
      branch: sentinel.branch,
      taskId,
      owningAgent: null,
      lastActivity,
      // For sentinel-only entries the canonical creation moment is the
      // adopt time (the directory may have been mtime-touched arbitrarily
      // since registration).
      createdAt: sentinel.adoptedAt,
      isLocked: false,
      lockState: 'unlocked',
      isStale,
      isMerged: false,
      owningTaskStatus,
      statusCategory,
      source: sentinel.source,
    });
  }

  const filtered =
    opts.statusFilter && opts.statusFilter.length > 0
      ? worktrees.filter((w) => opts.statusFilter?.includes(w.statusCategory))
      : worktrees;

  return engineSuccess<ListWorktreesResult>({ worktrees: filtered });
}

// ---------------------------------------------------------------------------
// Internal helpers — exported for tests only.
// ---------------------------------------------------------------------------

/**
 * Parse `git worktree list --porcelain` into structured rows.
 *
 * The porcelain grammar is documented at
 * https://git-scm.com/docs/git-worktree#_porcelain_format — each record is
 * separated by a blank line and may contain `worktree <path>`, `HEAD <sha>`,
 * `branch refs/heads/<name>` and `locked [<reason>]` lines.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns Parsed porcelain rows, one per worktree.
 * @internal Exported for tests only.
 */
export function enumerateWorktrees(projectRoot: string): PorcelainEntry[] {
  const stdout = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: projectRoot,
    encoding: 'utf-8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const entries: PorcelainEntry[] = [];
  let current: Partial<PorcelainEntry> & { locked?: boolean } = {};

  const flush = (): void => {
    if (current.path && current.branch) {
      entries.push({
        path: current.path,
        branch: current.branch,
        locked: current.locked === true,
      });
    }
    current = {};
  };

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trimEnd();
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith('worktree ')) {
      // New record begins — flush any in-progress entry first.
      if (current.path) flush();
      current.path = line.slice('worktree '.length);
      continue;
    }
    if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length);
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
      continue;
    }
    if (line === 'detached') {
      // Detached HEAD has no branch — represent as 'HEAD' so downstream
      // filters still see something deterministic. Tests assert that
      // detached worktrees yield taskId=null.
      current.branch = current.branch ?? 'HEAD';
      continue;
    }
    if (line === 'locked' || line.startsWith('locked ')) {
      current.locked = true;
    }
  }
  flush();

  return entries;
}

/**
 * Extract a task ID from a branch name following the `task/T####` convention.
 *
 * @param branch - Git branch name.
 * @returns The task ID string, or null if the branch does not match the convention.
 * @internal Exported for tests only.
 */
export function taskIdFromBranch(branch: string): string | null {
  const match = branch.match(/^task\/(T\d+)$/);
  return match ? (match[1] ?? null) : null;
}

/**
 * Get the timestamp (ms since epoch) of the newest commit on the given branch.
 *
 * Uses `git log -1 --format=%cI` and returns null if the branch resolution or
 * the log invocation fails — callers fall back to the worktree directory mtime.
 *
 * @param branch - Branch name.
 * @param projectRoot - Project root for the git invocation.
 * @returns ms since epoch, or null on failure.
 * @internal Exported for tests only.
 */
export function getLastCommitTimestampMs(branch: string, projectRoot: string): number | null {
  try {
    const iso = execFileSync('git', ['log', '-1', '--format=%cI', branch], {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!iso) return null;
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

/**
 * Test whether the given branch is reachable from the canonical upstream branch.
 *
 * Implementation: `git merge-base --is-ancestor <branch> <main>` exits 0 if
 * <branch> is an ancestor of <main> (i.e. has been merged or fast-forwarded
 * into it). Any other exit code is interpreted as "not merged".
 *
 * @param branch - Branch name to test.
 * @param projectRoot - Project root.
 * @param mainBranch - Upstream branch to test reachability against.
 * @returns true iff branch is reachable from main.
 * @internal Exported for tests only.
 */
export function branchIsMergedToMain(
  branch: string,
  projectRoot: string,
  mainBranch: string = DEFAULT_MAIN_BRANCH,
): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', branch, mainBranch], {
      cwd: projectRoot,
      timeout: GIT_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply orphan/merged/stale/locked precedence to produce the single
 * mutually-exclusive `statusCategory` field. See the {@link WorktreeStatusCategory}
 * docstring for the resolution order.
 *
 * Primary-worktree guard: the canonical project checkout is always classified
 * as `active`, regardless of merge state. The primary worktree's branch is
 * trivially an ancestor of itself (`main` is reachable from `main`), so the
 * naive ancestry check would label it `merged` and make it a prune candidate.
 *
 * @param flags - The set of pre-computed boolean classifiers.
 * @returns The resolved status category.
 * @internal Exported for tests only.
 */
export function classifyStatus(flags: {
  isPrimary?: boolean;
  isLocked: boolean;
  isOrphan: boolean;
  isMerged: boolean;
  isStale: boolean;
}): WorktreeStatusCategory {
  if (flags.isPrimary === true) return 'active';
  if (flags.isLocked) return 'locked';
  if (flags.isOrphan) return 'orphan';
  if (flags.isMerged) return 'merged';
  if (flags.isStale) return 'stale';
  return 'active';
}

/**
 * Load the `status` column for each of the given task IDs through the
 * ADR-068 DB chokepoint.
 *
 * Returns a map (taskId → status) for IDs that resolved; missing IDs are
 * absent from the map (callers treat absent as `null` for downstream
 * orphan detection).
 *
 * @param taskIds - Task IDs to look up.
 * @param projectRoot - Project root for DB resolution.
 * @returns Map of taskId → status.
 * @internal Exported for tests only.
 */
export async function loadOwningTaskStatuses(
  taskIds: string[],
  projectRoot: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (taskIds.length === 0) return out;

  // Task-status enrichment is BEST-EFFORT: `git worktree list` is the primary
  // source of truth and must succeed even when the tasks DB cannot be opened
  // (no `.cleo/` project resolvable from `projectRoot`, fresh checkout, or a
  // transient open failure). Degrade to no status rather than failing the whole
  // listing — callers treat a missing entry as `owningTaskStatus: null`.
  let handle: Awaited<ReturnType<typeof openCleoDb>>;
  try {
    // openCleoDb returns CleoDbHandle whose `.db` field is `unknown` — we narrow
    // here to the node:sqlite DatabaseSync surface we actually use. The cast is
    // localised and the alternative (changing the chokepoint signature) would
    // ripple across every store-using package.
    handle = await openCleoDb('tasks', projectRoot);
  } catch {
    return out;
  }
  try {
    const db = handle.db as DatabaseSync;
    const placeholders = taskIds.map(() => '?').join(', ');
    const sql = `SELECT id, status FROM tasks WHERE id IN (${placeholders})`;
    const rows = db.prepare(sql).all(...taskIds) as Array<{ id: string; status: string }>;
    for (const row of rows) {
      out.set(row.id, row.status);
    }
  } finally {
    await handle.close();
  }
  return out;
}

/**
 * Best-effort read of the owning agent identifier from a per-worktree metadata
 * file (`<path>/.git/worktree.json`). Returns null if the file is absent or
 * malformed.
 *
 * @param worktreePath - Absolute path to the worktree directory.
 * @returns The owningAgent string, or null.
 * @internal Exported for tests only.
 */
export function readOwningAgent(worktreePath: string): string | null {
  const candidate = join(worktreePath, '.git', 'worktree.json');
  if (!existsSync(candidate)) return null;
  try {
    const raw = readFileSync(candidate, 'utf-8');
    const parsed = JSON.parse(raw) as { owningAgent?: unknown };
    return typeof parsed.owningAgent === 'string' ? parsed.owningAgent : null;
  } catch {
    return null;
  }
}

/**
 * Return the mtime (ms) of the worktree directory, or current time if the
 * directory has been removed since enumeration.
 *
 * @param path - Absolute path to the worktree directory.
 * @returns ms since epoch.
 * @internal
 */
function mtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Date.now();
  }
}

/**
 * Resolve the canonical upstream branch name for merge-base checks.
 *
 * Currently hard-coded to {@link DEFAULT_MAIN_BRANCH} — falls back to null
 * if the branch does not exist locally, in which case callers skip the
 * merge check entirely (no spurious "not merged" classifications).
 *
 * @param projectRoot - Project root.
 * @returns The main branch name if it resolves, else null.
 * @internal
 */
function resolveMainBranch(projectRoot: string): string | null {
  try {
    execFileSync('git', ['rev-parse', '--verify', `refs/heads/${DEFAULT_MAIN_BRANCH}`], {
      cwd: projectRoot,
      timeout: GIT_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return DEFAULT_MAIN_BRANCH;
  } catch {
    return null;
  }
}

/**
 * Resolve the absolute path to the repository's `.git` common directory.
 *
 * For the primary worktree this is `<projectRoot>/.git`. For linked worktrees
 * this is also the primary's `.git` (the common dir is shared across all
 * worktrees — each linked worktree only owns its admin subdirectory under
 * `.git/worktrees/<name>/`).
 *
 * Returns null on failure — callers degrade gracefully to dir-mtime for the
 * `createdAt` field.
 *
 * @param projectRoot - Project root for the git invocation.
 * @returns Absolute path to the `.git` common directory, or null.
 * @internal Exported for tests only.
 */
export function resolveGitCommonDir(projectRoot: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the `createdAt` ISO timestamp for a worktree entry (T9546 AC4).
 *
 * Resolution order:
 *  1. Per-worktree admin file `<gitCommonDir>/worktrees/<basename(path)>/HEAD`.
 *     Git writes this exactly once at `git worktree add` time; its mtime is the
 *     most reliable proxy for worktree creation time.
 *  2. For the primary worktree (which has no per-worktree admin dir), the
 *     mtime of the `.git` common dir itself — set when the repo was created
 *     or cloned.
 *  3. Sentinel index `adoptedAt`, when the entry was registered via
 *     `cleo worktree adopt`.
 *  4. Fallback — `mtime` of the worktree directory.
 *
 * @internal Exported for tests only.
 */
export function resolveCreatedAt(input: {
  worktreePath: string;
  gitCommonDir: string | null;
  primaryWorktreePath: string | null;
  sentinelAdoptedAt: string | undefined;
}): string {
  // Primary worktree: stat the .git common dir itself.
  if (
    input.gitCommonDir !== null &&
    isPrimaryWorktree(input.worktreePath, input.primaryWorktreePath)
  ) {
    try {
      return new Date(statSync(input.gitCommonDir).mtimeMs).toISOString();
    } catch {
      // Fall through to other resolvers.
    }
  }
  // Linked worktree: stat the per-worktree admin HEAD file.
  if (input.gitCommonDir !== null) {
    const adminHead = join(input.gitCommonDir, 'worktrees', basename(input.worktreePath), 'HEAD');
    if (existsSync(adminHead)) {
      try {
        return new Date(statSync(adminHead).mtimeMs).toISOString();
      } catch {
        // Fall through.
      }
    }
  }
  // Sentinel adopted entry that also lives in git porcelain.
  if (input.sentinelAdoptedAt !== undefined) return input.sentinelAdoptedAt;
  // Final fallback — worktree dir mtime.
  return new Date(mtimeMs(input.worktreePath)).toISOString();
}

/**
 * Resolve the canonical primary worktree path — i.e. the directory containing
 * the repository's `.git` directory (not a `.git` file pointing into
 * `.git/worktrees/<name>`).
 *
 * Implementation: `git rev-parse --path-format=absolute --git-common-dir`
 * returns the absolute path to `.git` regardless of which worktree the
 * command is invoked from. The primary worktree is the parent of that path.
 *
 * Falls back to null on failure — callers treat missing detection as "do
 * nothing special" (no primary guard applied). This is safe: every worktree
 * still gets classified, just the same way the old code did.
 *
 * @param projectRoot - Project root for the git invocation.
 * @returns Absolute path to the primary worktree, or null on failure.
 * @internal Exported for tests only.
 */
export function resolvePrimaryWorktreePath(projectRoot: string): string | null {
  try {
    const commonDir = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        cwd: projectRoot,
        encoding: 'utf-8',
        timeout: GIT_TIMEOUT_MS,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ).trim();
    if (!commonDir) return null;
    // The primary worktree is the parent of `.git` (or `.git/`). Strip the
    // trailing `/.git` segment to recover the worktree path itself.
    const normalized = commonDir.replace(/\/?\.git\/?$/, '');
    return normalized || null;
  } catch {
    return null;
  }
}

/**
 * Test whether the given worktree path is the canonical primary worktree.
 *
 * Compares both raw and `realpath`-resolved variants to handle the common
 * case where the project root is symlinked or contains symlinked ancestors.
 *
 * @param worktreePath - Path from `git worktree list --porcelain`.
 * @param primaryPath - Output of {@link resolvePrimaryWorktreePath}, or null.
 * @returns true iff the two paths resolve to the same canonical location.
 * @internal Exported for tests only.
 */
export function isPrimaryWorktree(worktreePath: string, primaryPath: string | null): boolean {
  if (primaryPath === null) return false;
  if (resolvePath(worktreePath) === resolvePath(primaryPath)) return true;
  try {
    return realpathSync(worktreePath) === realpathSync(primaryPath);
  } catch {
    return false;
  }
}
