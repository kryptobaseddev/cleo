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

import { constants as fsConstants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type {
  NexusGitProbeErrorCode,
  NexusProjectGitState,
  NexusProjectsStatusParams,
  NexusProjectsStatusResult,
} from '@cleocode/contracts';
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import {
  type BoundedGitRun,
  DEADLINE_EXCEEDED,
  DEFAULT_GIT_MAX_OUTPUT_BYTES,
  filterConfig,
  type GitConfigPair,
  GitOutputBudget,
  runBoundedGit,
  withDeadline,
} from '../git/bounded-git.js';
import { parseConfiguredGitRoot } from '../git/work-tree.js';
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
  /** Git output held in memory at once across the whole run, bytes. */
  runOutputBudgetBytes: 64 * 1024 * 1024,
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
  /** Cap on one git call's output, bytes. Default 8 MiB. */
  maxOutputBytes?: number;
  /** Run-wide in-flight output budget shared by every location. */
  budget?: GitOutputBudget;
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

/** Remote a branch tracks, every remote's URL, and every filter driver name. */
function parseProbeConfig(raw: string): {
  branchRemote: Map<string, string>;
  remoteUrl: Map<string, string>;
  filters: Set<string>;
} {
  const branchRemote = new Map<string, string>();
  const remoteUrl = new Map<string, string>();
  const filters = new Set<string>();
  // `-z`: each entry is `key\nvalue\0`.
  for (const entry of raw.split('\0')) {
    const nl = entry.indexOf('\n');
    const key = nl < 0 ? entry : entry.slice(0, nl);
    const value = nl < 0 ? '' : entry.slice(nl + 1);
    if (key.startsWith('branch.') && key.endsWith('.remote')) {
      branchRemote.set(key.slice('branch.'.length, -'.remote'.length), value);
    } else if (key.startsWith('remote.') && key.endsWith('.url')) {
      const name = key.slice('remote.'.length, -'.url'.length);
      if (!remoteUrl.has(name)) remoteUrl.set(name, value);
    } else if (key.startsWith('filter.')) {
      const name = key.slice('filter.'.length, key.lastIndexOf('.'));
      if (name.length > 0) filters.add(name);
    }
  }
  return { branchRemote, remoteUrl, filters };
}

/** Schemes whose userinfo user is an account name, not a credential. */
const SSH_SCHEMES = new Set(['ssh', 'git+ssh', 'ssh+git']);

/**
 * Remove credentials from a remote URL before it is stored or shown.
 *
 * - `scheme://user:pass@host/…` (http, https, ftp, git, …) → `scheme://host/…`:
 *   for these schemes even a bare user is typically a token.
 * - `ssh://user:pass@host/…` → `ssh://user@host/…`: the ssh login (`git`) is not
 *   a secret; a password is.
 * - scp-style `user:pass@host:path` → `user@host:path`.
 * - A query string or fragment is dropped (`?access_token=…`).
 * - Local paths and `file://` are otherwise unchanged.
 *
 * @param raw - Configured remote URL.
 * @returns The URL without secrets.
 * @example
 * ```ts
 * redactRemoteUrl('https://alice:ghp_x@github.com/o/r.git'); // 'https://github.com/o/r.git'
 * ```
 */
export function redactRemoteUrl(raw: string): string {
  // A query or fragment can carry a token (`?access_token=…`); a remote URL
  // never needs one to identify the repository.
  const url = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw.replace(/[?#].*$/s, '') : raw;
  const withScheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)@(.*)$/s.exec(url);
  if (withScheme) {
    const [, scheme = '', userinfo = '', rest = ''] = withScheme;
    if (!SSH_SCHEMES.has(scheme.toLowerCase())) return `${scheme}://${rest}`;
    const user = userinfo.split(':')[0] ?? '';
    return user.length > 0 ? `${scheme}://${user}@${rest}` : `${scheme}://${rest}`;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) return url;
  const scp = /^([^@/]+)@([^/:]+:.*)$/s.exec(url);
  if (scp) {
    const [, userinfo = '', rest = ''] = scp;
    return `${userinfo.split(':')[0]}@${rest}`;
  }
  return url;
}

/**
 * Apply {@link redactRemoteUrl} to every URL embedded in free text (git's
 * stderr quotes the remote URL verbatim, credentials included).
 *
 * @param text - Message text.
 * @returns The text with URL credentials removed.
 */
export function redactUrlsInText(text: string): string {
  return text.replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"<>]+/g, (url) => redactRemoteUrl(url));
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
function gitMessage(run: BoundedGitRun, fallback: string): string {
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
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_GIT_MAX_OUTPUT_BYTES;
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
    row.probeError = redactUrlsInText(message);
    row.durationMs = Date.now() - started;
    return row;
  };
  const failRun = (run: BoundedGitRun, what: string): NexusProjectGitState => {
    if (run.timedOut) {
      return fail('E_GIT_TIMEOUT', `${what} exceeded ${timeoutMs}ms; git process group killed`);
    }
    if (run.overflowed) {
      return fail(
        'E_GIT_FAILED',
        `${what} output exceeded ${maxOutputBytes} bytes (or the run-wide output budget); killed`,
      );
    }
    if (run.spawnError !== null) return fail('E_GIT_FAILED', `cannot run git: ${run.stderr}`);
    return fail('E_GIT_FAILED', gitMessage(run, what));
  };
  const git = (
    args: readonly string[],
    cwd: string,
    config: readonly GitConfigPair[] = [],
  ): Promise<BoundedGitRun> =>
    runBoundedGit(args, { cwd, deadline, gitBin, maxOutputBytes, config, budget: options.budget });
  const fsTimeout = (what: string): NexusProjectGitState =>
    fail('E_GIT_TIMEOUT', `${what} of ${target.path} exceeded ${timeoutMs}ms (filesystem)`);

  // 1. The directory itself — bounded: a dead mount must not stall the row.
  try {
    const s = await withDeadline(stat(target.path), deadline);
    if (s === DEADLINE_EXCEEDED) return fsTimeout('stat');
    if (!s.isDirectory()) return fail('E_PATH_MISSING', `not a directory: ${target.path}`);
    const ok = await withDeadline(
      access(target.path, fsConstants.R_OK | fsConstants.X_OK),
      deadline,
    );
    if (ok === DEADLINE_EXCEEDED) return fsTimeout('access');
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
  let rev = await git(revParseArgs, runDir);
  if (rev.code !== 0 && !rev.timedOut && rev.spawnError === null) {
    if (/not a git repository/i.test(rev.stderr)) {
      const contextFile = join(target.path, '.cleo', 'project-context.json');
      const raw = await withDeadline(
        readFile(contextFile, 'utf-8').catch(() => null),
        deadline,
      );
      if (raw === DEADLINE_EXCEEDED) return fsTimeout('reading .cleo/project-context.json');
      const declared = raw === null ? null : parseConfiguredGitRoot(raw);
      if (declared === null) {
        return fail('E_NOT_GIT_REPO', `not inside a git work tree: ${target.path}`);
      }
      runDir = isAbsolute(declared) ? declared : resolve(target.path, declared);
      rev = await git(revParseArgs, runDir);
      if (rev.code !== 0 && !rev.timedOut && !rev.overflowed) {
        return fail(
          'E_NOT_GIT_REPO',
          `declared git root ${runDir} (from .cleo/project-context.json evidence.gitRoot="${declared}") is not a git work tree: ${gitMessage(rev, 'git rev-parse')}`,
        );
      }
    }
  }
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

  // 3. Remotes and filter drivers. Reading config runs no repository code;
  //    the filter names are what lets every later call disable them.
  const config = await git(
    [
      'config',
      '-z',
      '--get-regexp',
      '^(branch\\..+\\.remote|remote\\..+\\.url|filter\\..+\\.(clean|smudge|process))$',
    ],
    runDir,
  );
  // exit 1 = nothing matched (no remotes, no filters).
  if (config.code !== 0 && config.code !== 1) return failRun(config, 'git config');
  const cfg = parseProbeConfig(config.code === 0 ? config.stdout : '');
  const noFilters = filterConfig(cfg.filters);

  // 4. Optional fetch — non-fatal: the row still describes the local state
  //    and the previous fetch.
  let fetchFailure: string | null = null;
  if (doFetch) {
    const fetched = await git(
      [
        'fetch',
        '--quiet',
        '--no-recurse-submodules',
        // Beats `remote.<name>.uploadpack`; a config override does not (the
        // first configured value wins for that key).
        '--upload-pack=git-upload-pack',
      ],
      runDir,
      noFilters,
    );
    if (fetched.timedOut) return failRun(fetched, 'git fetch');
    if (fetched.code !== 0) fetchFailure = gitMessage(fetched, 'git fetch');
  }

  // 5. Status. Submodule work trees are not entered (`dirty`): a child git
  //    there would read that repository's own, unenumerated filters.
  const status = await git(
    // --no-renames: rename detection reads blob contents, which in a partial
    // clone means a lazy fetch (GIT_NO_LAZY_FETCH also forbids it).
    ['status', '--porcelain=v2', '--branch', '-z', '--ignore-submodules=dirty', '--no-renames'],
    runDir,
    noFilters,
  );
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

  const tracked = parsed.branch !== null ? cfg.branchRemote.get(parsed.branch) : undefined;
  row.remoteName =
    tracked ?? (cfg.remoteUrl.has('origin') ? 'origin' : ([...cfg.remoteUrl.keys()][0] ?? null));
  const url = row.remoteName !== null ? cfg.remoteUrl.get(row.remoteName) : undefined;
  // Never store or share a token or password embedded in the URL.
  row.remoteUrl = url === undefined ? null : redactRemoteUrl(url);

  // 6. Upstream tracking-ref commit (as of the last fetch).
  if (parsed.upstream !== null) {
    const up = await git(['rev-parse', '--verify', '--quiet', '@{upstream}'], runDir);
    if (up.timedOut || up.overflowed) return failRun(up, 'git rev-parse @{upstream}');
    // exit 1: upstream configured but its tracking ref is gone — leave null.
    if (up.code === 0) row.remoteHeadSha = up.stdout.trim() || null;
  }

  // 7. Remote freshness: FETCH_HEAD is per-worktree, the tracking refs are
  //    shared, so a fetch from any worktree of this repo counts.
  const fetchedAt = await withDeadline(
    newestMtime(
      [gitDir, commonDir]
        .filter((d): d is string => typeof d === 'string' && d.length > 0)
        .map((d) => join(d, 'FETCH_HEAD')),
    ),
    deadline,
  );
  if (fetchedAt === DEADLINE_EXCEEDED) return fsTimeout('stat of FETCH_HEAD');
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
 * Upsert probe rows into `nexus_project_git_state`, one transaction. With
 * `pruneDeviceId`, that device's rows not in `rows` are deleted in the same
 * transaction.
 *
 * @param db - Global registry handle.
 * @param rows - Probe results.
 * @param options - `pruneDeviceId`: the device whose full row set `rows` is.
 */
export function recordGitStates(
  db: GitStateStoreHandle,
  rows: readonly NexusProjectGitState[],
  options: { pruneDeviceId?: string } = {},
): void {
  if (rows.length === 0 && options.pruneDeviceId === undefined) return;
  db.transaction((tx) => {
    if (options.pruneDeviceId !== undefined) {
      // A row whose location is no longer probed (superseded, deleted,
      // deduplicated) must not linger as this device's current state.
      const keep = new Set(rows.map((r) => `${r.projectId}\0${r.path}`));
      const existing = tx
        .select({ projectId: projectGitState.projectId, path: projectGitState.path })
        .from(projectGitState)
        .where(eq(projectGitState.deviceId, options.pruneDeviceId))
        .all();
      for (const e of existing) {
        if (keep.has(`${e.projectId}\0${e.path}`)) continue;
        tx.delete(projectGitState)
          .where(
            and(
              eq(projectGitState.projectId, e.projectId),
              eq(projectGitState.deviceId, options.pruneDeviceId),
              eq(projectGitState.path, e.path),
            ),
          )
          .run();
      }
    }
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
 * Drop targets of the same project whose paths resolve to the same directory
 * (a symlink and its target, `/tmp` and `/private/tmp`), keeping the first.
 * Each `realpath` is bounded by `timeoutMs`; an unresolvable path is kept
 * as-is so its probe records the error.
 */
async function dedupeByRealPath(
  targets: readonly GitProbeTarget[],
  concurrency: number,
  timeoutMs: number,
): Promise<GitProbeTarget[]> {
  const real = await runWithConcurrency(targets, concurrency, async (t) => {
    const r = await withDeadline(
      realpath(t.path).catch(() => t.path),
      Date.now() + timeoutMs,
    );
    return r === DEADLINE_EXCEEDED ? t.path : r;
  });
  const seen = new Set<string>();
  return targets.filter((t, i) => {
    const key = `${t.projectId}\0${real[i] ?? t.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

  const targets = await dedupeByRealPath(
    listLocalProbeTargets(db, deviceId),
    concurrency,
    timeoutMs,
  );
  const rows = await probeGitStates(targets, {
    budget: new GitOutputBudget(GIT_STATE_DEFAULTS.runOutputBudgetBytes),
    fetch,
    concurrency,
    timeoutMs,
    staleAfterMs,
    now: overrides.now,
    gitBin: overrides.gitBin,
  });
  recordGitStates(db, rows, { pruneDeviceId: deviceId });
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
