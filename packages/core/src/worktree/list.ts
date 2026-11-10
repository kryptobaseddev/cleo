/**
 * Structured worktree enumeration with status classification (T9546).
 *
 * Exposes {@link listWorktrees} — the SDK primitive behind the
 * `cleo worktree list` CLI command and the `worktree.list` dispatch operation.
 *
 * For each worktree returned by `git worktree list --porcelain`, the function
 * resolves:
 *  - `taskId` (the task adopt recorded in the sentinel index, else the branch
 *    name `task|feat|fix|test|chore/T####[-slug]`, else a `T####[-slug]`
 *    directory name; T14236).
 *  - `owningTaskStatus` (read from the project cleo.db tasks SSoT via `getDb`).
 *  - `lastActivity` (the worktree's own HEAD commit, falling back to dir mtime).
 *  - `isLocked` (porcelain `locked` line).
 *  - `isMerged` (the worktree's own HEAD is reachable from main and is not a
 *    commit on main's first-parent line, i.e. it carried commits of its own
 *    that were merged; a fresh branch at a main commit is never merged; T14236).
 *  - `isStale`  (annotation: no commits in >N days AND (task done/cancelled OR merged)).
 *  - `owningAgent` (the sentinel index's `adoptedBy`, else null).
 *  - `statusCategory` — `active|redundant|keep|unknown` (T14274): a worktree
 *    whose task is done or cancelled, or that has no stored task and has been
 *    idle past the stale window, is classified by the one disposal proof
 *    (`disposeWorktree`, dry run): `redundant` when nothing in it would be
 *    lost, `keep` naming the failing clause, `unknown` when a probe could not
 *    answer. Everything else is `active` ({@link classifyStatus}).
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
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, join, resolve as resolvePath } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  DisposeWorktreeResult,
  EngineResult,
  ListWorktreesOpts,
  ListWorktreesResult,
  WorktreeInfo,
  WorktreeSource,
} from '@cleocode/contracts';
import { engineError, engineSuccess } from '@cleocode/contracts/engine-result.js';
import { readWorktreePorcelain } from '@cleocode/worktree/worktree-locate.js';
import { resolveOrCwd } from '../paths.js';
import { claimClockNow, DERIVED_STATUS_SQL } from '../store/task-claim.js';
import { worktreeInUseProbe } from './in-use-probe.js';
import { readSentinelIndex, taskIdFromBranch, taskIdFromWorktreeDir } from './sentinel-index.js';

export { taskIdFromBranch } from './sentinel-index.js';

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
  /** The worktree's own HEAD commit, or null when git did not report one (T14236). */
  head: string | null;
}

/** The task a worktree names: its branch, else its directory (T14236). */
function taskIdOf(branch: string, path: string): string | null {
  return taskIdFromBranch(branch) ?? taskIdFromWorktreeDir(path);
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
  // Lazy: keeps @cleocode/worktree out of this module's static graph (T13696).
  const { disposeWorktree, readKeepMarker, readWorktreeTaskLock } = await import(
    '@cleocode/worktree'
  );
  /**
   * T14274: what the one disposal proof says, for a disposal candidate. A dry
   * run: nothing is written, archived or removed (prune re-proves with the
   * task's evidence before it acts).
   */
  const proveRedundant = (path: string, taskId: string | null, isMerged: boolean) =>
    disposeWorktree({
      worktreePath: path,
      projectRoot,
      taskId,
      reason: 'list',
      exemptRegenerable: isMerged,
      inUse: worktreeInUseProbe(readWorktreeTaskLock, projectRoot, taskId),
      dryRun: true,
    });

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
  // ADR-068 chokepoint. We open the project cleo.db via getDb() so the command
  // picks up the SSoT pragma set (T9189) — never via raw DatabaseSync.
  // T14165: the task adopt recorded for a path wins over the branch name.
  const taskIdByPath = new Map<string, string | null>();
  for (const entry of porcelainEntries) {
    taskIdByPath.set(
      entry.path,
      sentinelByPath.get(entry.path)?.taskId ?? taskIdOf(entry.branch, entry.path),
    );
  }
  // Also seed task IDs for sentinel-only entries so they can be batch-loaded.
  for (const sentinel of sentinelEntries) {
    if (!porcelainPaths.has(sentinel.path)) {
      taskIdByPath.set(sentinel.path, sentinel.taskId ?? taskIdOf(sentinel.branch, sentinel.path));
    }
  }
  const taskIds = Array.from(taskIdByPath.values()).filter((id): id is string => id !== null);
  const taskStatusByid = await loadOwningTaskStatuses(taskIds, projectRoot);

  // Pre-resolve the default upstream branch presence — if `main` is absent,
  // `branchIsMergedToMain` would otherwise spuriously throw for every entry.
  const mainBranch = resolveMainBranch(projectRoot);
  // T14236: main's first-parent line, read once. A worktree whose own HEAD is
  // ON it carries no commits of its own (a fresh branch, or a detached
  // checkout of a main commit), so it is never "merged".
  const mainLine = mainBranch ? readFirstParentLine(projectRoot, mainBranch) : new Set<string>();

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
    const taskId = taskIdByPath.get(entry.path) ?? null;
    // T14236: every git test uses the worktree's OWN HEAD. A detached entry's
    // branch is the literal 'HEAD', which from projectRoot named the primary
    // checkout's commit.
    const lastActivityMs =
      (entry.head ? getLastCommitTimestampMs(entry.head, projectRoot) : null) ??
      mtimeMs(entry.path);
    const lastActivity = new Date(lastActivityMs).toISOString();
    const isPrimary = isPrimaryWorktree(entry.path, primaryWorktreePath);
    const isMerged =
      mainBranch !== null && entry.head !== null
        ? headIsMergedWork(entry.head, projectRoot, mainBranch, mainLine)
        : false;
    const owningTaskStatus = taskId ? (taskStatusByid.get(taskId) ?? null) : null;
    const owningAgent = sentinelByPath.get(entry.path)?.adoptedBy ?? null;

    const idleMs = nowMs - lastActivityMs;
    const idleOlderThanThreshold = idleMs > staleThresholdMs;
    const ownerTerminal = owningTaskStatus === 'done' || owningTaskStatus === 'cancelled';
    // Stale (an annotation) = idle longer than threshold AND (owner is terminal OR branch already integrated).
    const isStale = idleOlderThanThreshold && (ownerTerminal || isMerged);

    const candidate = isDisposalCandidate({
      isPrimary,
      owningTaskStatus,
      // At or past the window: a zero-day window makes every taskless worktree a candidate.
      idlePastWindow: idleMs >= staleThresholdMs,
    });
    const classified = classifyStatus(
      candidate ? proveRedundant(entry.path, taskId, isMerged) : null,
    );

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
      ...classified,
      source,
      ...keptField(entry.path, readKeepMarker),
    };
  });

  // --- T9804: Append sentinel-only entries (not in git porcelain output) ---
  // These are worktrees that exist in the index but whose directories may have
  // been removed or are NOT known to git (e.g. adopted entries for stale
  // agent worktrees that have already been cleaned up by git gc). We include
  // them so callers know they exist in the registry and can clean them up.
  for (const sentinel of sentinelEntries) {
    if (porcelainPaths.has(sentinel.path)) continue; // Already in git output.

    const taskId = sentinel.taskId ?? taskIdOf(sentinel.branch, sentinel.path);
    const owningTaskStatus = taskId ? (taskStatusByid.get(taskId) ?? null) : null;
    const lastActivityMs = mtimeMs(sentinel.path);
    const lastActivity = new Date(lastActivityMs).toISOString();
    const idleMs = nowMs - lastActivityMs;
    const isStale = idleMs > staleThresholdMs;
    const candidate = isDisposalCandidate({
      isPrimary: false,
      owningTaskStatus,
      idlePastWindow: idleMs >= staleThresholdMs,
    });
    const classified = classifyStatus(
      candidate ? proveRedundant(sentinel.path, taskId, false) : null,
    );

    worktrees.push({
      path: sentinel.path,
      branch: sentinel.branch,
      taskId,
      owningAgent: sentinel.adoptedBy,
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
      ...classified,
      source: sentinel.source,
      ...keptField(sentinel.path, readKeepMarker),
    });
  }

  const filtered =
    opts.statusFilter && opts.statusFilter.length > 0
      ? worktrees.filter((w) => opts.statusFilter?.includes(w.statusCategory))
      : worktrees;

  return engineSuccess<ListWorktreesResult>({ worktrees: filtered });
}

/** `{ kept }` when a disposal kept this worktree (its keep marker), else `{}` (T13701). */
function keptField(
  path: string,
  readKeepMarker: typeof import('@cleocode/worktree').readKeepMarker,
): Pick<WorktreeInfo, 'kept'> {
  const kept = readKeepMarker(path);
  return kept ? { kept } : {};
}

// ---------------------------------------------------------------------------
// Internal helpers — exported for tests only.
// ---------------------------------------------------------------------------

/**
 * The worktrees git has registered for `projectRoot`, read through the
 * `@cleocode/worktree` facade's light locate subpath (T10866). A detached
 * worktree reports branch `'HEAD'` so downstream filters see something
 * deterministic (detached worktrees yield `taskId=null`); a bare repository
 * entry is skipped.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns One row per registered worktree.
 * @throws Error when git cannot list the worktrees.
 * @internal Exported for tests only.
 */
export function enumerateWorktrees(projectRoot: string): PorcelainEntry[] {
  return readWorktreePorcelain(projectRoot)
    .filter((entry) => entry.bare !== true)
    .map((entry) => ({
      path: entry.path,
      branch: entry.branch ?? 'HEAD',
      locked: entry.locked,
      head: entry.head ?? null,
    }));
}

/**
 * The commits on `mainBranch`'s first-parent line (T14236). Empty when git
 * fails, which makes {@link headIsMergedWork} answer "not merged".
 *
 * @param projectRoot - Project root for the git invocation.
 * @param mainBranch - Upstream branch.
 * @returns The set of full commit shas.
 * @internal Exported for tests only.
 */
export function readFirstParentLine(projectRoot: string, mainBranch: string): Set<string> {
  try {
    const out = execFileSync('git', ['rev-list', '--first-parent', mainBranch], {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
    });
    return new Set(out.split('\n').filter(Boolean));
  } catch {
    return new Set();
  }
}

/**
 * Whether a worktree's HEAD is work that has been merged into main (T14236):
 * reachable from main AND not itself a commit on main's first-parent line.
 * A fresh branch, or a detached checkout of a main commit, has no commits of
 * its own and is never merged; a HEAD not reachable from main never is.
 * Fails closed: an unknown answer is "not merged".
 *
 * @param head - The worktree's own HEAD sha.
 * @param projectRoot - Project root for the git invocation.
 * @param mainBranch - Upstream branch.
 * @param mainLine - {@link readFirstParentLine} of `mainBranch`.
 * @returns true only for merged work.
 * @internal Exported for tests only.
 */
export function headIsMergedWork(
  head: string,
  projectRoot: string,
  mainBranch: string,
  mainLine: ReadonlySet<string>,
): boolean {
  if (mainLine.size === 0 || mainLine.has(head)) return false;
  return branchIsMergedToMain(head, projectRoot, mainBranch);
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
 * Whether a worktree is a disposal candidate at all (T14274): not the primary
 * checkout (T9686-D), and its task is done or cancelled, or it has no stored
 * task and has been idle past the stale window. Everything else is `active`.
 *
 * @param flags - The primary guard, the owning task's status and idleness.
 * @returns Whether the disposal proof decides its category.
 * @internal Exported for tests only.
 */
export function isDisposalCandidate(flags: {
  isPrimary: boolean;
  owningTaskStatus: string | null;
  idlePastWindow: boolean;
}): boolean {
  if (flags.isPrimary) return false;
  if (flags.owningTaskStatus === 'done' || flags.owningTaskStatus === 'cancelled') return true;
  if (flags.owningTaskStatus !== null) return false; // an open task
  return flags.idlePastWindow;
}

/**
 * The status category from the disposal proof (T14274): `active` for a
 * non-candidate (`proof === null`), `redundant` when the proof holds,
 * `unknown` when a probe could not answer, else `keep` with the failing
 * clause as `keepReason`.
 *
 * @param proof - The dry-run `disposeWorktree` result, or `null` for a non-candidate.
 * @returns The category, and the reason for `keep` / `unknown`.
 * @internal Exported for tests only.
 */
export function classifyStatus(
  proof: DisposeWorktreeResult | null,
): Pick<WorktreeInfo, 'statusCategory' | 'keepReason'> {
  if (proof === null) return { statusCategory: 'active' };
  if (proof.keptReason === undefined) return { statusCategory: 'redundant' };
  return {
    statusCategory: proof.indeterminate === true ? 'unknown' : 'keep',
    keepReason: proof.keptReason,
  };
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
  //
  // E6-L6 (T11526): query the legacy `tasks` table via getDb(), which runs the
  // drizzle-tasks migrations against the consolidated project `cleo.db` and
  // therefore guarantees the `tasks` family exists. The dual-scope consolidated
  // schema alone (openDualScopeDb) creates only `tasks_tasks`, not bare `tasks`.
  let db: DatabaseSync | null;
  let close: (() => void) | null = null;
  try {
    // T14440 (census AC3): the census (and any caller) may list ANOTHER
    // project's worktrees. The read goes through the strictly read-only
    // accessor — `getDb` restores, seeds and migrates on open, a write — and
    // only when the verdict says the schema is fully known and applied, so
    // this query cannot even misread a foreign schema. Every other store is
    // skipped and the listing degrades to owningTaskStatus null.
    const { projectStoreReadVerdict } = await import('../doctor/migrations.js');
    if (projectStoreReadVerdict(projectRoot) !== 'readable') return out;
    const { openProjectTasksReadOnly } = await import('../store/sqlite.js');
    const snap = openProjectTasksReadOnly(projectRoot);
    if (snap === null) return out;
    db = snap.db;
    close = snap.close;
  } catch {
    return out;
  }
  if (!db) return out;
  try {
    const placeholders = taskIds.map(() => '?').join(', ');
    const sql = `SELECT id, ${DERIVED_STATUS_SQL} AS status FROM tasks_tasks WHERE id IN (${placeholders})`;
    const rows = db.prepare(sql).all(claimClockNow(), ...taskIds) as Array<{
      id: string;
      status: string;
    }>;
    for (const row of rows) {
      out.set(row.id, row.status);
    }
    return out;
  } catch {
    return out;
  } finally {
    close?.();
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
