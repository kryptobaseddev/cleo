/**
 * Git state probe for project locations (`nexus_project_git_state`, T12511).
 *
 * For every location of every project on THIS device, record branch, HEAD,
 * detached/shallow, dirty and untracked counts, upstream, ahead/behind, remote
 * URL and remote head, and when the remote was last fetched. Other devices
 * sharing the store read those rows to answer "which machines is this project
 * on, where, and in what state".
 *
 * ## Bounded
 *
 * - Locations are probed {@link GIT_STATE_DEFAULTS.concurrency} at a time.
 * - Every git call of one location shares ONE deadline ({@link GitStateProbeOptions.timeoutMs}).
 *   Git runs in its own process group, and on expiry the whole group is
 *   SIGKILLed — a credential helper or ssh child that inherited git's pipes
 *   would otherwise keep the call alive after git itself died.
 * - `GIT_TERMINAL_PROMPT=0` and `GIT_OPTIONAL_LOCKS=0`: git never waits on a
 *   prompt, and `status` never takes `index.lock` (so it neither blocks nor is
 *   blocked by a concurrent `git` in the same checkout).
 *
 * ## No network unless asked
 *
 * `git fetch` runs only with `fetch: true`. Otherwise ahead/behind and the
 * remote head come from the local tracking ref — i.e. the LAST fetch — and
 * `remoteFetchedAt` is that fetch's instant (the newest `FETCH_HEAD` mtime of
 * the worktree and common git dirs). `remoteStale` is set when that instant is
 * unknown or older than {@link GitStateProbeOptions.staleAfterMs}, so a
 * `behind: 0` is never presented as current on the strength of an old fetch.
 *
 * ## Errors are rows
 *
 * A location that cannot be probed — missing directory, EACCES, not a git
 * repo, timeout, git failure — still yields a row, with `probeErrorCode` and
 * `probeError` set and every field that WAS learned kept. Nothing throws out
 * of {@link probeGitState}; nothing is filtered out of {@link probeGitStates}.
 *
 * @task T12511
 * @epic T12496
 */

import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type {
  NexusGitProbeErrorCode,
  NexusProjectGitState,
  NexusProjectsStatusParams,
  NexusProjectsStatusResult,
} from '@cleocode/contracts';
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { discoveryEnv, resolveDeclaredEvidenceGitRoot } from '../git/work-tree.js';
import { runWithConcurrency } from '../lib/concurrency.js';
import {
  type ProjectGitStateRow,
  projectGitState,
  projectLocations,
  projectRegistry,
} from '../store/schema/nexus-schema.js';
import { adoptLocalDeviceRows, currentDeviceId } from './path-map.js';

/** Defaults and limits for the git state probe. */
export const GIT_STATE_DEFAULTS = {
  /** Locations probed at once. */
  concurrency: 8,
  /** Upper bound on `concurrency`. */
  maxConcurrency: 64,
  /** Per-location budget without a fetch, ms. */
  timeoutMs: 10_000,
  /** Per-location budget with a fetch, ms. */
  fetchTimeoutMs: 30_000,
  /** A fetch older than this is stale, ms (24 h). */
  staleAfterMs: 24 * 60 * 60 * 1000,
} as const;

/** One location to probe. */
export interface GitProbeTarget {
  /** Project id. */
  projectId: string;
  /** Device the location is on. */
  deviceId: string;
  /** Location path. */
  path: string;
  /** Registered project name, when known. */
  projectName?: string | null;
}

/** Options for {@link probeGitState} / {@link probeGitStates}. */
export interface GitStateProbeOptions {
  /** Run `git fetch` first. Default `false`. */
  fetch?: boolean;
  /** Budget shared by every git call of ONE location, ms. */
  timeoutMs?: number;
  /** A fetch older than this is `remoteStale`, ms. */
  staleAfterMs?: number;
  /** Locations probed at once ({@link probeGitStates} only). */
  concurrency?: number;
  /** Clock (tests). */
  now?: () => Date;
  /** Git executable (tests substitute a hanging one). Default `git`. */
  gitBin?: string;
}

/** Outcome of one git invocation. */
interface GitRun {
  /** Exit code; `null` when killed or never started. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Killed at the deadline. */
  timedOut: boolean;
  /** Spawn failure (ENOENT for a missing git, EACCES for the cwd, …). */
  spawnError: NodeJS.ErrnoException | null;
}

/** Probe environment: no ambient repo, no prompts, no optional locks. */
function probeEnv(): NodeJS.ProcessEnv {
  return { ...discoveryEnv(), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
}

/**
 * Run one git command in `cwd`, killed with its whole process group when
 * `deadline` passes. Never rejects.
 */
function runGit(
  gitBin: string,
  args: readonly string[],
  cwd: string,
  deadline: number,
): Promise<GitRun> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return Promise.resolve({
      code: null,
      stdout: '',
      stderr: '',
      timedOut: true,
      spawnError: null,
    });
  }
  return new Promise((resolveRun) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const settle = (run: GitRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun(run);
    };
    // A new process group (POSIX) so the deadline can kill git AND whatever it
    // spawned (ssh, credential helpers) — they hold the pipes open otherwise.
    const child = spawn(gitBin, [...args], {
      cwd,
      env: probeEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined && process.platform !== 'win32') {
          process.kill(-child.pid, 'SIGKILL');
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        // Already exited between the deadline and the kill.
      }
      // Resolve now rather than on 'close': a grandchild that escaped the
      // group could still hold the pipes.
      settle({
        code: null,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut: true,
        spawnError: null,
      });
    }, remaining);
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.on('error', (e: NodeJS.ErrnoException) =>
      settle({ code: null, stdout: '', stderr: e.message, timedOut: false, spawnError: e }),
    );
    child.on('close', (code) =>
      settle({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut: false,
        spawnError: null,
      }),
    );
  });
}

/** Parsed `git status --porcelain=v2 --branch -z`. */
interface ParsedStatus {
  headSha: string | null;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  dirtyCount: number;
  untrackedCount: number;
}

/**
 * Parse `git status --porcelain=v2 --branch -z`.
 *
 * @param raw - NUL-separated status output.
 * @returns Branch headers and entry counts.
 */
export function parsePorcelainV2Status(raw: string): ParsedStatus {
  const parsed: ParsedStatus = {
    headSha: null,
    branch: null,
    detached: false,
    upstream: null,
    ahead: null,
    behind: null,
    dirtyCount: 0,
    untrackedCount: 0,
  };
  const fields = raw.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i] as string;
    if (f.startsWith('# branch.oid ')) {
      const oid = f.slice('# branch.oid '.length);
      parsed.headSha = oid === '(initial)' ? null : oid;
    } else if (f.startsWith('# branch.head ')) {
      const head = f.slice('# branch.head '.length);
      parsed.detached = head === '(detached)';
      parsed.branch = parsed.detached ? null : head;
    } else if (f.startsWith('# branch.upstream ')) {
      parsed.upstream = f.slice('# branch.upstream '.length);
    } else if (f.startsWith('# branch.ab ')) {
      const m = /^\+(\d+) -(\d+)$/.exec(f.slice('# branch.ab '.length));
      if (m) {
        parsed.ahead = Number(m[1]);
        parsed.behind = Number(m[2]);
      }
    } else if (f.startsWith('1 ') || f.startsWith('u ')) {
      parsed.dirtyCount++;
    } else if (f.startsWith('2 ')) {
      parsed.dirtyCount++;
      i++; // a rename/copy entry is followed by its original path
    } else if (f.startsWith('? ')) {
      parsed.untrackedCount++;
    }
  }
  return parsed;
}

/** Remote a branch tracks, and every remote's URL, from `git config`. */
function parseRemoteConfig(raw: string): {
  branchRemote: Map<string, string>;
  remoteUrl: Map<string, string>;
} {
  const branchRemote = new Map<string, string>();
  const remoteUrl = new Map<string, string>();
  // `-z`: each entry is `key\nvalue\0`.
  for (const entry of raw.split('\0')) {
    const nl = entry.indexOf('\n');
    if (nl < 0) continue;
    const key = entry.slice(0, nl);
    const value = entry.slice(nl + 1);
    if (key.startsWith('branch.') && key.endsWith('.remote')) {
      branchRemote.set(key.slice('branch.'.length, -'.remote'.length), value);
    } else if (key.startsWith('remote.') && key.endsWith('.url')) {
      const name = key.slice('remote.'.length, -'.url'.length);
      if (!remoteUrl.has(name)) remoteUrl.set(name, value);
    }
  }
  return { branchRemote, remoteUrl };
}

/** Newest mtime among the given files, or `null` when none exists. */
async function newestMtime(paths: readonly string[]): Promise<Date | null> {
  let newest: Date | null = null;
  for (const p of paths) {
    try {
      const s = await stat(p);
      if (newest === null || s.mtime > newest) newest = s.mtime;
    } catch {
      // absent — never fetched from this git dir
    }
  }
  return newest;
}

/** First meaningful line of git's stderr, for a row's `probeError`. */
function gitMessage(run: GitRun, fallback: string): string {
  const line = run.stderr
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ?? `${fallback} (exit ${String(run.code)})`;
}

/**
 * Probe one location. Never throws: every failure is a row with
 * `probeErrorCode` set.
 *
 * @param target - The location.
 * @param options - Timeout, fetch, staleness, clock and git overrides.
 * @returns The location's git state.
 * @example
 * ```ts
 * const row = await probeGitState({ projectId: 'p', deviceId: 'd', path: '/w/p' });
 * if (row.probeErrorCode) console.error(row.probeError);
 * ```
 */
export async function probeGitState(
  target: GitProbeTarget,
  options: GitStateProbeOptions = {},
): Promise<NexusProjectGitState> {
  const now = options.now ?? (() => new Date());
  const gitBin = options.gitBin ?? 'git';
  const doFetch = options.fetch === true;
  const timeoutMs =
    options.timeoutMs ??
    (doFetch ? GIT_STATE_DEFAULTS.fetchTimeoutMs : GIT_STATE_DEFAULTS.timeoutMs);
  const staleAfterMs = options.staleAfterMs ?? GIT_STATE_DEFAULTS.staleAfterMs;
  const started = Date.now();
  const deadline = started + timeoutMs;
  const probedAt = now();

  const row: NexusProjectGitState = {
    projectId: target.projectId,
    projectName: target.projectName ?? null,
    deviceId: target.deviceId,
    current: true,
    path: target.path,
    gitRoot: null,
    branch: null,
    headSha: null,
    detached: false,
    shallow: false,
    dirtyCount: null,
    untrackedCount: null,
    upstream: null,
    ahead: null,
    behind: null,
    remoteName: null,
    remoteUrl: null,
    remoteHeadSha: null,
    remoteFetchedAt: null,
    remoteStale: false,
    probedAt: probedAt.toISOString(),
    durationMs: 0,
    probeErrorCode: null,
    probeError: null,
  };
  const fail = (code: NexusGitProbeErrorCode, message: string): NexusProjectGitState => {
    row.probeErrorCode = code;
    row.probeError = message;
    row.durationMs = Date.now() - started;
    return row;
  };
  const failRun = (run: GitRun, what: string): NexusProjectGitState =>
    run.timedOut
      ? fail('E_GIT_TIMEOUT', `${what} exceeded ${timeoutMs}ms; git process group killed`)
      : fail('E_GIT_FAILED', gitMessage(run, what));

  // 1. The directory itself.
  try {
    const s = await stat(target.path);
    if (!s.isDirectory()) return fail('E_PATH_MISSING', `not a directory: ${target.path}`);
    await access(target.path, fsConstants.R_OK | fsConstants.X_OK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return fail('E_PATH_MISSING', `directory does not exist: ${target.path}`);
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return fail('E_PATH_ACCESS', `${code}: cannot read ${target.path}`);
    }
    return fail('E_PATH_ACCESS', `${code ?? 'error'}: ${(e as Error).message}`);
  }

  // 2. Which work tree: the path, else its declared evidence.gitRoot (a CLEO
  //    root that parents several repositories — gh#1462 · T12308).
  const revParseArgs = [
    'rev-parse',
    '--absolute-git-dir',
    '--git-common-dir',
    '--is-shallow-repository',
    '--show-toplevel',
  ];
  let runDir = target.path;
  let rev = await runGit(gitBin, revParseArgs, runDir, deadline);
  if (rev.code !== 0 && !rev.timedOut && rev.spawnError === null) {
    if (/not a git repository/i.test(rev.stderr)) {
      const declared = resolveDeclaredEvidenceGitRoot(target.path, {});
      if (declared === null) {
        return fail('E_NOT_GIT_REPO', `not inside a git work tree: ${target.path}`);
      }
      runDir = declared.path;
      rev = await runGit(gitBin, revParseArgs, runDir, deadline);
      if (rev.code !== 0 && !rev.timedOut) {
        return fail(
          'E_NOT_GIT_REPO',
          `declared git root ${declared.path} (from ${declared.source}) is not a git work tree: ${gitMessage(rev, 'git rev-parse')}`,
        );
      }
    }
  }
  if (rev.spawnError !== null) return fail('E_GIT_FAILED', `cannot run git: ${rev.stderr}`);
  if (rev.code !== 0) return failRun(rev, 'git rev-parse');
  const [gitDir, commonDirRaw, shallow, toplevel] = rev.stdout.trim().split('\n');
  row.shallow = shallow === 'true';
  row.gitRoot = toplevel ?? runDir;
  const commonDir =
    commonDirRaw === undefined
      ? undefined
      : isAbsolute(commonDirRaw)
        ? commonDirRaw
        : resolve(runDir, commonDirRaw);

  // 3. Optional fetch — non-fatal: the row still describes the local state
  //    and the previous fetch.
  let fetchFailure: string | null = null;
  if (doFetch) {
    const fetched = await runGit(gitBin, ['fetch', '--quiet'], runDir, deadline);
    if (fetched.timedOut) {
      return failRun(fetched, 'git fetch');
    }
    if (fetched.code !== 0) fetchFailure = gitMessage(fetched, 'git fetch');
  }

  // 4. Status and remote config together.
  const [status, config] = await Promise.all([
    runGit(gitBin, ['status', '--porcelain=v2', '--branch', '-z'], runDir, deadline),
    runGit(
      gitBin,
      ['config', '-z', '--get-regexp', '^(branch\\..+\\.remote|remote\\..+\\.url)$'],
      runDir,
      deadline,
    ),
  ]);
  if (status.code !== 0) return failRun(status, 'git status');
  const parsed = parsePorcelainV2Status(status.stdout);
  row.headSha = parsed.headSha;
  row.branch = parsed.branch;
  row.detached = parsed.detached;
  row.upstream = parsed.upstream;
  row.ahead = parsed.ahead;
  row.behind = parsed.behind;
  row.dirtyCount = parsed.dirtyCount;
  row.untrackedCount = parsed.untrackedCount;

  // `git config --get-regexp` exits 1 when nothing matches: no remotes.
  if (config.timedOut) return failRun(config, 'git config');
  const remotes = parseRemoteConfig(config.code === 0 ? config.stdout : '');
  const tracked = parsed.branch !== null ? remotes.branchRemote.get(parsed.branch) : undefined;
  row.remoteName =
    tracked ??
    (remotes.remoteUrl.has('origin') ? 'origin' : ([...remotes.remoteUrl.keys()][0] ?? null));
  row.remoteUrl = row.remoteName !== null ? (remotes.remoteUrl.get(row.remoteName) ?? null) : null;

  // 5. Upstream tracking-ref commit (as of the last fetch).
  if (parsed.upstream !== null) {
    const up = await runGit(
      gitBin,
      ['rev-parse', '--verify', '--quiet', '@{upstream}'],
      runDir,
      deadline,
    );
    if (up.timedOut) return failRun(up, 'git rev-parse @{upstream}');
    // exit 1: upstream configured but its tracking ref is gone — leave null.
    if (up.code === 0) row.remoteHeadSha = up.stdout.trim() || null;
  }

  // 6. Remote freshness: FETCH_HEAD is per-worktree, the tracking refs are
  //    shared, so a fetch from any worktree of this repo counts.
  const fetchedAt = await newestMtime(
    [gitDir, commonDir]
      .filter((d): d is string => typeof d === 'string' && d.length > 0)
      .map((d) => join(d, 'FETCH_HEAD')),
  );
  row.remoteFetchedAt = fetchedAt?.toISOString() ?? null;
  row.remoteStale = isRemoteStale(row, probedAt, staleAfterMs);

  if (fetchFailure !== null) return fail('E_FETCH_FAILED', fetchFailure);
  row.durationMs = Date.now() - started;
  return row;
}

/**
 * Whether a row's remote state is stale at `now`: it has a remote, and its
 * last fetch is unknown or older than `staleAfterMs`. A repository with no
 * remote has nothing to be stale against.
 *
 * @param row - Row with `remoteName` and `remoteFetchedAt`.
 * @param now - Reference instant.
 * @param staleAfterMs - Staleness window.
 * @returns `true` when the remote fields should not be trusted as current.
 */
export function isRemoteStale(
  row: Pick<NexusProjectGitState, 'remoteName' | 'upstream' | 'remoteFetchedAt'>,
  now: Date,
  staleAfterMs: number,
): boolean {
  if (row.remoteName === null && row.upstream === null) return false;
  if (row.remoteFetchedAt === null) return true;
  return now.getTime() - Date.parse(row.remoteFetchedAt) > staleAfterMs;
}

/**
 * Probe many locations with bounded concurrency. Every target yields exactly
 * one row, in input order.
 *
 * @param targets - Locations to probe.
 * @param options - Concurrency, timeout, fetch and staleness options.
 * @returns One row per target.
 * @example
 * ```ts
 * const rows = await probeGitStates(targets, { concurrency: 8, timeoutMs: 5000 });
 * ```
 */
export async function probeGitStates(
  targets: readonly GitProbeTarget[],
  options: GitStateProbeOptions = {},
): Promise<NexusProjectGitState[]> {
  return runWithConcurrency(targets, clampConcurrency(options.concurrency), (t) =>
    probeGitState(t, options),
  );
}

/** Clamp a requested concurrency to `1..maxConcurrency`, defaulting when absent. */
function clampConcurrency(requested: number | undefined): number {
  const n =
    requested === undefined || !Number.isFinite(requested)
      ? GIT_STATE_DEFAULTS.concurrency
      : Math.trunc(requested);
  return Math.min(GIT_STATE_DEFAULTS.maxConcurrency, Math.max(1, n));
}

/** Registry handle subset the git state functions need. */
export type GitStateStoreHandle = Pick<
  NodeSQLiteDatabase,
  'select' | 'insert' | 'delete' | 'update' | 'transaction'
>;

/**
 * This device's locations worth probing: `live` and `missing` (a missing one
 * yields an `E_PATH_MISSING` row, which is the fact another device wants).
 *
 * @param db - Global registry handle.
 * @param deviceId - This device's id.
 * @returns Probe targets with project names.
 */
export function listLocalProbeTargets(db: GitStateStoreHandle, deviceId: string): GitProbeTarget[] {
  adoptLocalDeviceRows(db, deviceId);
  return db
    .select({
      projectId: projectLocations.projectId,
      deviceId: projectLocations.deviceId,
      path: projectLocations.path,
      projectName: projectRegistry.name,
    })
    .from(projectLocations)
    .leftJoin(projectRegistry, eq(projectRegistry.projectId, projectLocations.projectId))
    .where(
      and(
        eq(projectLocations.deviceId, deviceId),
        inArray(projectLocations.state, ['live', 'missing']),
      ),
    )
    .orderBy(projectLocations.projectId, projectLocations.path)
    .all();
}

/**
 * Upsert probe rows into `nexus_project_git_state`, one transaction.
 *
 * @param db - Global registry handle.
 * @param rows - Probe results.
 */
export function recordGitStates(
  db: GitStateStoreHandle,
  rows: readonly NexusProjectGitState[],
): void {
  if (rows.length === 0) return;
  db.transaction((tx) => {
    for (const r of rows) {
      const values = {
        gitRoot: r.gitRoot,
        branch: r.branch,
        headSha: r.headSha,
        detached: r.detached,
        shallow: r.shallow,
        dirtyCount: r.dirtyCount,
        untrackedCount: r.untrackedCount,
        upstream: r.upstream,
        ahead: r.ahead,
        behind: r.behind,
        remoteName: r.remoteName,
        remoteUrl: r.remoteUrl,
        remoteHeadSha: r.remoteHeadSha,
        remoteFetchedAt: r.remoteFetchedAt,
        probedAt: r.probedAt,
        durationMs: r.durationMs,
        probeErrorCode: r.probeErrorCode,
        probeError: r.probeError,
      };
      tx.insert(projectGitState)
        .values({ projectId: r.projectId, deviceId: r.deviceId, path: r.path, ...values })
        .onConflictDoUpdate({
          target: [projectGitState.projectId, projectGitState.deviceId, projectGitState.path],
          set: values,
        })
        .run();
    }
  });
}

/**
 * Read recorded git state rows, recomputing `remoteStale` at `now`.
 *
 * @param db - Global registry handle.
 * @param options - `excludeDeviceId` to skip one device (this one), clock and window.
 * @returns Stored rows, by project then device then path.
 */
export function listGitStates(
  db: GitStateStoreHandle,
  options: { excludeDeviceId?: string; now?: Date; staleAfterMs?: number } = {},
): NexusProjectGitState[] {
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? GIT_STATE_DEFAULTS.staleAfterMs;
  const self = currentDeviceId();
  return db
    .select({ row: projectGitState, projectName: projectRegistry.name })
    .from(projectGitState)
    .leftJoin(projectRegistry, eq(projectRegistry.projectId, projectGitState.projectId))
    .where(
      options.excludeDeviceId !== undefined
        ? ne(projectGitState.deviceId, options.excludeDeviceId)
        : undefined,
    )
    .orderBy(projectGitState.projectId, projectGitState.deviceId, projectGitState.path)
    .all()
    .map(({ row, projectName }) => storedToState(row, projectName, self, now, staleAfterMs));
}

/** Convert a stored row to the contract shape. */
function storedToState(
  row: ProjectGitStateRow,
  projectName: string | null,
  self: string,
  now: Date,
  staleAfterMs: number,
): NexusProjectGitState {
  const state: NexusProjectGitState = {
    projectId: row.projectId,
    projectName,
    deviceId: row.deviceId,
    current: row.deviceId === self,
    path: row.path,
    gitRoot: row.gitRoot,
    branch: row.branch,
    headSha: row.headSha,
    detached: row.detached,
    shallow: row.shallow,
    dirtyCount: row.dirtyCount,
    untrackedCount: row.untrackedCount,
    upstream: row.upstream,
    ahead: row.ahead,
    behind: row.behind,
    remoteName: row.remoteName,
    remoteUrl: row.remoteUrl,
    remoteHeadSha: row.remoteHeadSha,
    remoteFetchedAt: row.remoteFetchedAt,
    remoteStale: false,
    probedAt: row.probedAt,
    durationMs: row.durationMs,
    probeErrorCode: row.probeErrorCode,
    probeError: row.probeError,
  };
  state.remoteStale = isRemoteStale(state, now, staleAfterMs);
  return state;
}

/**
 * Probe and record every location on this device, and return the fresh rows
 * together with the last recorded rows of every other device.
 *
 * @param db - Global registry handle.
 * @param params - Fetch, concurrency, timeout and staleness.
 * @param overrides - Device id, clock and git executable (tests).
 * @returns The status result.
 * @example
 * ```ts
 * const res = await runProjectsGitStatus(await getNexusRegistryDb(getCleoHome()), {});
 * ```
 */
export async function runProjectsGitStatus(
  db: GitStateStoreHandle,
  params: NexusProjectsStatusParams = {},
  overrides: { deviceId?: string; now?: () => Date; gitBin?: string } = {},
): Promise<NexusProjectsStatusResult> {
  const started = Date.now();
  const deviceId = overrides.deviceId ?? currentDeviceId();
  const fetch = params.fetch === true;
  const concurrency = clampConcurrency(params.concurrency);
  const timeoutMs =
    params.timeoutMs !== undefined && params.timeoutMs > 0
      ? Math.trunc(params.timeoutMs)
      : fetch
        ? GIT_STATE_DEFAULTS.fetchTimeoutMs
        : GIT_STATE_DEFAULTS.timeoutMs;
  const staleAfterMs =
    params.staleAfterMs !== undefined && params.staleAfterMs >= 0
      ? params.staleAfterMs
      : GIT_STATE_DEFAULTS.staleAfterMs;

  const targets = listLocalProbeTargets(db, deviceId);
  const rows = await probeGitStates(targets, {
    fetch,
    concurrency,
    timeoutMs,
    staleAfterMs,
    now: overrides.now,
    gitBin: overrides.gitBin,
  });
  recordGitStates(db, rows);
  const otherDevices = listGitStates(db, {
    excludeDeviceId: deviceId,
    now: overrides.now?.(),
    staleAfterMs,
  });

  return {
    rows,
    otherDevices,
    count: rows.length,
    deviceId,
    fetched: fetch,
    concurrency,
    timeoutMs,
    staleAfterMs,
    durationMs: Date.now() - started,
    summary: {
      ok: rows.filter((r) => r.probeErrorCode === null).length,
      errored: rows.filter((r) => r.probeErrorCode !== null).length,
      timedOut: rows.filter((r) => r.probeErrorCode === 'E_GIT_TIMEOUT').length,
      dirty: rows.filter((r) => (r.dirtyCount ?? 0) + (r.untrackedCount ?? 0) > 0).length,
      remoteStale: rows.filter((r) => r.remoteStale).length,
    },
  };
}
