/**
 * Git tracking of `.cleo/` runtime files (T14549 · ADR-013 §9 · T5158).
 *
 * A project whose git repository tracks `.cleo/cleo.db` (or any other runtime
 * file) corrupts its store on `git checkout` / `git pull`: git replaces the
 * main database file while its `-wal` sidecar stays behind, and SQLite then
 * replays a WAL that belongs to a different database. This module detects
 * such tracking, untracks it losslessly, and finds the commits that added it.
 *
 * The set of runtime files is NOT a second list: it is the EXPLICIT DENY
 * block of the shipped `.cleo/.gitignore` template ({@link getGitignoreContent}),
 * the same rules that keep the files out of git in the first place. The
 * tracked identity files (`project.json`, `project-id`, ADR-094/096) are never
 * runtime files.
 *
 * @task T14549
 */

import { execFileSync } from 'node:child_process';
import type { CheckResult } from '@cleocode/contracts/scaffold-diagnostics';
import { PORTABLE_PROJECT_ID_FILE, PROJECT_MANIFEST_FILE } from '@cleocode/paths';
import { discoveryEnv } from '../git/work-tree.js';
import { ensureGitignore, getGitignoreContent } from '../scaffold/ensure-config.js';

/** Identity files inside `.cleo/` that stay tracked (ADR-094, ADR-096). */
const TRACKED_IDENTITY_FILES: ReadonlySet<string> = new Set([
  PROJECT_MANIFEST_FILE,
  PORTABLE_PROJECT_ID_FILE,
]);

/** The command `cleo doctor --fix` prints after untracking runtime files. */
export const UNTRACK_RUNTIME_COMMIT_COMMAND =
  'git commit -m "chore: stop tracking .cleo runtime files (ADR-013 §9)"';

/**
 * The runtime-file patterns: every rule of the EXPLICIT DENY block of a
 * `.cleo/.gitignore` (gitignore syntax, relative to `.cleo/`).
 *
 * @param gitignoreContent - The `.cleo/.gitignore` text. @defaultValue the shipped template
 * @returns The deny patterns in file order; empty when the block is absent.
 * @task T14549
 */
export function runtimeDenyPatterns(gitignoreContent: string = getGitignoreContent()): string[] {
  const patterns: string[] = [];
  let inDeny = false;
  for (const raw of gitignoreContent.split('\n')) {
    const line = raw.trim();
    if (/explicit deny/i.test(line)) {
      inDeny = true;
      continue;
    }
    if (!inDeny || line === '' || line.startsWith('#') || line.startsWith('!')) continue;
    patterns.push(line);
  }
  return patterns;
}

/** Translate one gitignore glob segment (`*`, `?`) into an anchored regex source. */
function globSource(glob: string): string {
  return glob
    .split('')
    .map((ch) =>
      ch === '*' ? '[^/]*' : ch === '?' ? '[^/]' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&'),
    )
    .join('');
}

/** Compile gitignore deny patterns into a predicate over `.cleo/`-relative paths. */
function compileDenyPatterns(patterns: readonly string[]): (rel: string) => boolean {
  const regexes = patterns.map((pattern) => {
    const dirOnly = pattern.endsWith('/');
    const body = dirOnly ? pattern.slice(0, -1) : pattern;
    // A pattern with an inner slash is anchored to `.cleo/`; one without
    // matches a path segment at any depth (gitignore semantics).
    const anchored = body.includes('/');
    const core = globSource(body.replace(/^\//, ''));
    const prefix = anchored ? '^' : '(^|/)';
    // A directory pattern matches only paths beneath it; a plain pattern
    // matches the entry itself or anything beneath a directory of that name.
    const suffix = dirOnly ? '/' : '(/|$)';
    return new RegExp(`${prefix}${core}${suffix}`);
  });
  return (rel) => regexes.some((re) => re.test(rel));
}

/**
 * Whether `path` (relative to the project root, e.g. `.cleo/cleo.db`) is a
 * `.cleo/` runtime file: under `.cleo/`, matched by a deny pattern, and not a
 * tracked identity file.
 *
 * @param path - Project-relative path with forward slashes.
 * @param patterns - Deny patterns. @defaultValue {@link runtimeDenyPatterns}()
 * @returns `true` for a runtime file git must never track.
 * @task T14549
 */
export function isCleoRuntimePath(
  path: string,
  patterns: readonly string[] = runtimeDenyPatterns(),
): boolean {
  if (!path.startsWith('.cleo/')) return false;
  const rel = path.slice('.cleo/'.length);
  if (TRACKED_IDENTITY_FILES.has(rel)) return false;
  return compileDenyPatterns(patterns)(rel);
}

/**
 * Whether a project-relative path is a SQLite store file or sidecar
 * (`*.db`, `*.db-wal`, `*.db-shm`, `*.db-journal`), the files whose tracking
 * corrupts the store on checkout.
 *
 * @param path - Project-relative path.
 * @returns `true` for a SQLite database file or sidecar.
 * @task T14549
 */
export function isSqliteStorePath(path: string): boolean {
  return /\.db(-wal|-shm|-journal)?$/.test(path);
}

/** Outcome of one git call. */
type GitRun = { ok: true; out: string } | { ok: false; error: string };

/** Run git in `cwd` with no ambient repo variables. Never throws. */
function runGit(cwd: string, args: readonly string[]): GitRun {
  try {
    const out = execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
      cwd,
      encoding: 'utf-8',
      env: discoveryEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, out };
  } catch (err) {
    const stderr =
      err instanceof Error && 'stderr' in err && typeof err.stderr === 'string' ? err.stderr : '';
    const first = (stderr.trim() || (err instanceof Error ? err.message : String(err))).split(
      '\n',
    )[0];
    return { ok: false, error: first ?? 'git failed' };
  }
}

/** Whether `cwd` is inside a git work tree (distinguishes "no repo" from a failed read). */
function insideWorkTree(cwd: string): boolean {
  const r = runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  return r.ok && r.out.trim() === 'true';
}

/**
 * Outcome of reading git for the runtime checks: no repository, a read that
 * failed inside a real repository (coverage missing, never a clean result),
 * or the value read.
 *
 * @typeParam T - The value read on success.
 * @task T14549
 */
export type RuntimeGitScan<T> =
  | { state: 'not-git' }
  | { state: 'incomplete'; error: string }
  | { state: 'ok'; value: T };

/** Classify a failed git read as "no repository" or "incomplete". */
function failedScan<T>(cwd: string, error: string): RuntimeGitScan<T> {
  return insideWorkTree(cwd) ? { state: 'incomplete', error } : { state: 'not-git' };
}

/**
 * The `.cleo/` runtime files the project's git index tracks. One
 * `git ls-files` call, cheap enough for init, upgrade and session start.
 *
 * @param projectRoot - Project root (the directory holding `.cleo/`).
 * @returns The tracked runtime paths relative to `projectRoot`, `not-git`
 *   outside a work tree, or `incomplete` when git failed inside one.
 * @task T14549
 */
export function scanTrackedCleoRuntimeFiles(projectRoot: string): RuntimeGitScan<string[]> {
  const r = runGit(projectRoot, ['ls-files', '-z', '--', '.cleo']);
  if (!r.ok) return failedScan(projectRoot, r.error);
  const patterns = runtimeDenyPatterns();
  return {
    state: 'ok',
    value: r.out.split('\0').filter((path) => path !== '' && isCleoRuntimePath(path, patterns)),
  };
}

/**
 * The `.cleo/` runtime files the project's git index tracks, for the cheap
 * advisory callers (init, upgrade, session start).
 *
 * @param projectRoot - Project root (the directory holding `.cleo/`).
 * @returns Tracked runtime paths relative to `projectRoot`, or `null` when
 *   git could not be read (no repository, or a failed read; `cleo doctor`
 *   reports the difference).
 * @task T14549
 */
export function listTrackedCleoRuntimeFiles(projectRoot: string): string[] | null {
  const scan = scanTrackedCleoRuntimeFiles(projectRoot);
  return scan.state === 'ok' ? scan.value : null;
}

/** `info` result for a check whose git read failed inside a real repository. */
function incompleteResult(id: string, what: string, error: string): CheckResult {
  return {
    id,
    category: 'configuration',
    status: 'info',
    message:
      `Check incomplete: git could not read ${what} (${error}); this is not proof that no ` +
      '.cleo runtime file is tracked',
    details: { incomplete: true, error },
    fix: null,
  };
}

/**
 * One-line warning for init, upgrade and session start when git tracks
 * `.cleo/` runtime files, or `null` when it does not (or git is absent).
 *
 * @param projectRoot - Project root.
 * @returns The warning text, naming the files and the fix.
 * @task T14549
 */
export function trackedCleoRuntimeWarning(projectRoot: string): string | null {
  const tracked = listTrackedCleoRuntimeFiles(projectRoot);
  if (!tracked || tracked.length === 0) return null;
  return (
    `git tracks ${tracked.length} .cleo runtime file(s) (${tracked.join(', ')}); a checkout or ` +
    'pull overwrites them, and for the SQLite store that replaces the live database while ' +
    'its WAL stays behind (ADR-013 §9). Fix: cleo doctor --fix (untracks them with git rm ' +
    '--cached; files stay on disk)'
  );
}

/**
 * Doctor check: git must track no `.cleo/` runtime file (T14549 AC1).
 *
 * @param projectRoot - Project root.
 * @returns `failed` for a tracked SQLite store file, `warning` for other runtime
 *   files, `info` outside git or when git could not be read, else `passed`.
 * @task T14549
 */
export function checkTrackedCleoRuntime(projectRoot: string): CheckResult {
  const scan = scanTrackedCleoRuntimeFiles(projectRoot);
  if (scan.state === 'incomplete') {
    return incompleteResult('tracked_cleo_runtime', 'the index', scan.error);
  }
  if (scan.state === 'not-git') {
    return {
      id: 'tracked_cleo_runtime',
      category: 'configuration',
      status: 'info',
      message: 'Not a git repository (skipping tracked .cleo runtime file check)',
      details: {},
      fix: null,
    };
  }
  const tracked = scan.value;
  if (tracked.length > 0) {
    const sqlite = tracked.filter(isSqliteStorePath);
    const other = tracked.filter((path) => !isSqliteStorePath(path));
    // SQLite store files and sidecars corrupt the store on checkout; other
    // runtime files (config, logs, metrics) lose local state but cannot
    // desynchronize a WAL, so they warn.
    const parts: string[] = [];
    if (sqlite.length > 0) {
      parts.push(
        `git tracks ${sqlite.length} .cleo SQLite store file(s): ${sqlite.join(', ')}. A ` +
          'checkout or pull can replace the live database while its WAL stays behind and ' +
          'corrupt the store (ADR-013 §9, T5158)',
      );
    }
    if (other.length > 0) {
      parts.push(
        `git tracks ${other.length} other .cleo runtime file(s): ${other.join(', ')}. A ` +
          'checkout or pull overwrites this local runtime state',
      );
    }
    return {
      id: 'tracked_cleo_runtime',
      category: 'configuration',
      status: sqlite.length > 0 ? 'failed' : 'warning',
      message: parts.join('. '),
      details: { tracked, sqlite, other },
      fix: 'cleo doctor --fix',
    };
  }
  return {
    id: 'tracked_cleo_runtime',
    category: 'configuration',
    status: 'passed',
    message: 'git tracks no .cleo runtime file',
    details: {},
    fix: null,
  };
}

/** Outcome of {@link untrackCleoRuntimeFiles}. */
export interface UntrackCleoRuntimeResult {
  /** `fixed` when paths were untracked, `skipped` when none were tracked, `failed` on a git error. */
  action: 'fixed' | 'skipped' | 'failed';
  /** Paths removed from the index (working files untouched). */
  untracked: string[];
  /** The commit the owner makes to record the untracking, or `null` when nothing changed. */
  commitCommand: string | null;
  /** Human-readable summary. */
  message: string;
}

/**
 * Untrack every `.cleo/` runtime file with `git rm --cached` only (T14549
 * AC2): working files stay byte-identical, `.cleo/.gitignore` is refreshed
 * from the template, and nothing is committed. Idempotent: a second run
 * finds nothing tracked and skips.
 *
 * @param projectRoot - Project root.
 * @returns What was untracked and the commit to make.
 * @task T14549
 */
export async function untrackCleoRuntimeFiles(
  projectRoot: string,
): Promise<UntrackCleoRuntimeResult> {
  const scan = scanTrackedCleoRuntimeFiles(projectRoot);
  if (scan.state === 'incomplete') {
    return {
      action: 'failed',
      untracked: [],
      commitCommand: null,
      message: `git could not read the index (${scan.error}); nothing was untracked`,
    };
  }
  const tracked = scan.state === 'ok' ? scan.value : [];
  if (tracked.length === 0) {
    return {
      action: 'skipped',
      untracked: [],
      commitCommand: null,
      message: 'git tracks no .cleo runtime file',
    };
  }
  // The deny rules must be in place before untracking, or the next
  // `git add -A` stages the files again.
  await ensureGitignore(projectRoot, { checkoutOnly: true });
  // Batched to stay under the argument-length limit on large backup trees.
  for (let i = 0; i < tracked.length; i += 500) {
    const batch = tracked.slice(i, i + 500);
    const removed = runGit(projectRoot, [
      'rm',
      '--cached',
      '-q',
      '--ignore-unmatch',
      '--',
      ...batch,
    ]);
    if (!removed.ok) {
      return {
        action: 'failed',
        untracked: tracked.slice(0, i),
        commitCommand: i > 0 ? UNTRACK_RUNTIME_COMMIT_COMMAND : null,
        message: `git rm --cached failed (${removed.error}) for: ${batch.join(', ')}`,
      };
    }
  }
  return {
    action: 'fixed',
    untracked: tracked,
    commitCommand: UNTRACK_RUNTIME_COMMIT_COMMAND,
    message:
      `untracked ${tracked.length} .cleo runtime file(s) with git rm --cached (files kept on ` +
      `disk): ${tracked.join(', ')}. Commit it: ${UNTRACK_RUNTIME_COMMIT_COMMAND}. Each ` +
      'other clone runs cleo backup add before pulling that commit: a pull deletes a removed ' +
      'file whose local copy still matches the old commit',
  };
}

/** One commit that added a `.cleo/` runtime file. */
export interface RuntimeFileAddition {
  /** Full commit sha. */
  sha: string;
  /** Committer date (YYYY-MM-DD). */
  date: string;
  /** Commit subject. */
  subject: string;
  /** Runtime paths that commit added, relative to the project root. */
  paths: string[];
}

/** Git glob pathspecs for the deny patterns under `.cleo/`. */
function runtimePathspecs(patterns: readonly string[]): string[] {
  return patterns.map((pattern) => {
    const dirOnly = pattern.endsWith('/');
    const body = (dirOnly ? pattern.slice(0, -1) : pattern).replace(/^\//, '');
    const base = body.includes('/') ? `.cleo/${body}` : `.cleo/**/${body}`;
    return `:(glob)${base}${dirOnly ? '/**' : ''}`;
  });
}

/**
 * Commits on ANY ref (branches, tags, remotes, stash) that added a `.cleo/`
 * runtime file (T14549 AC6). One `git log --all --diff-filter=A` restricted to
 * the runtime pathspecs. History is reported, never rewritten.
 *
 * @param projectRoot - Project root.
 * @returns The additions, newest first; `not-git` outside a work tree, or
 *   `incomplete` when git failed inside one.
 * @task T14549
 */
export function findRuntimeFileAdditions(
  projectRoot: string,
): RuntimeGitScan<RuntimeFileAddition[]> {
  const patterns = runtimeDenyPatterns();
  const r = runGit(projectRoot, [
    'log',
    '--all',
    '--diff-filter=A',
    '--relative',
    '--name-only',
    '-z',
    '--format=%x01%H%x09%cs%x09%s',
    '--',
    ...runtimePathspecs(patterns),
  ]);
  if (!r.ok) return failedScan(projectRoot, r.error);
  const additions: RuntimeFileAddition[] = [];
  for (const record of r.out.split('\x01')) {
    if (record.trim() === '') continue;
    const [header = '', ...rest] = record.split('\n');
    const [sha = '', date = '', subject = ''] = header.split('\t');
    const paths = rest
      .join('\n')
      .split('\0')
      .map((p) => p.trim())
      .filter((p) => p !== '' && isCleoRuntimePath(p, patterns));
    if (sha && paths.length > 0) additions.push({ sha, date, subject, paths });
  }
  return { state: 'ok', value: additions };
}

/**
 * Doctor check: git history holds no commit that added a `.cleo/` runtime
 * file. Such a commit is a likely cause of store corruption: checking it out
 * (or any later commit still tracking the file) swaps the live database.
 *
 * @param projectRoot - Project root.
 * @returns `warning` naming the commits, `info` outside git or when git could
 *   not be read, else `passed`.
 * @task T14549
 */
export function checkRuntimeFileHistory(projectRoot: string): CheckResult {
  const scan = findRuntimeFileAdditions(projectRoot);
  if (scan.state === 'incomplete') {
    return incompleteResult('cleo_runtime_history', 'the history', scan.error);
  }
  if (scan.state === 'not-git') {
    return {
      id: 'cleo_runtime_history',
      category: 'configuration',
      status: 'info',
      message: 'Not a git repository (skipping .cleo runtime history check)',
      details: {},
      fix: null,
    };
  }
  const additions = scan.value;
  if (additions.length > 0) {
    const shown = additions
      .slice(0, 5)
      .map((a) => `${a.sha.slice(0, 12)} ${a.date} (${a.paths.join(', ')})`)
      .join('; ');
    return {
      id: 'cleo_runtime_history',
      category: 'configuration',
      status: 'warning',
      message:
        `git history (all refs) has ${additions.length} commit(s) that added .cleo runtime files: ${shown}` +
        `${additions.length > 5 ? '; …' : ''}. A likely cause of store corruption: checking out ` +
        'such a commit replaces the live database while its WAL stays behind. History is ' +
        'reported, not rewritten',
      details: { additions },
      fix: null,
    };
  }
  return {
    id: 'cleo_runtime_history',
    category: 'configuration',
    status: 'passed',
    message: 'No commit on any ref added a .cleo runtime file',
    details: {},
    fix: null,
  };
}
