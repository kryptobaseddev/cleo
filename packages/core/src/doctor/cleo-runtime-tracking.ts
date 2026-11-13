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

/** Run git in `cwd` with no ambient repo variables; `null` on any failure. */
function git(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
      cwd,
      encoding: 'utf-8',
      env: discoveryEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * The `.cleo/` runtime files the project's git index tracks. One
 * `git ls-files` call, cheap enough for init, upgrade and session start.
 *
 * @param projectRoot - Project root (the directory holding `.cleo/`).
 * @returns Tracked runtime paths relative to `projectRoot`, or `null` when
 *   `projectRoot` is not inside a git work tree.
 * @task T14549
 */
export function listTrackedCleoRuntimeFiles(projectRoot: string): string[] | null {
  const out = git(projectRoot, ['ls-files', '-z', '--', '.cleo']);
  if (out === null) return null;
  const patterns = runtimeDenyPatterns();
  return out.split('\0').filter((path) => path !== '' && isCleoRuntimePath(path, patterns));
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
    'pull can then replace the live database while its WAL stays behind and corrupt the store ' +
    '(ADR-013 §9). Fix: cleo doctor --fix (untracks them with git rm --cached; files stay on disk)'
  );
}

/**
 * Doctor check: git must track no `.cleo/` runtime file (T14549 AC1).
 *
 * @param projectRoot - Project root.
 * @returns `failed` naming each tracked runtime file, `info` outside git, else `passed`.
 * @task T14549
 */
export function checkTrackedCleoRuntime(projectRoot: string): CheckResult {
  const tracked = listTrackedCleoRuntimeFiles(projectRoot);
  if (tracked === null) {
    return {
      id: 'tracked_cleo_runtime',
      category: 'configuration',
      status: 'info',
      message: 'Not a git repository (skipping tracked .cleo runtime file check)',
      details: {},
      fix: null,
    };
  }
  if (tracked.length > 0) {
    return {
      id: 'tracked_cleo_runtime',
      category: 'configuration',
      status: 'failed',
      message:
        `git tracks ${tracked.length} .cleo runtime file(s): ${tracked.join(', ')}. A checkout ` +
        'or pull can replace the live database while its WAL stays behind and corrupt the ' +
        'store (ADR-013 §9, T5158)',
      details: { tracked },
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
  const tracked = listTrackedCleoRuntimeFiles(projectRoot);
  if (tracked === null || tracked.length === 0) {
    return {
      action: 'skipped',
      untracked: [],
      commitCommand: null,
      message: 'git tracks no .cleo runtime file',
    };
  }
  // The deny rules must be in place before untracking, or the next
  // `git add -A` stages the files again.
  await ensureGitignore(projectRoot);
  // Batched to stay under the argument-length limit on large backup trees.
  for (let i = 0; i < tracked.length; i += 500) {
    const batch = tracked.slice(i, i + 500);
    if (git(projectRoot, ['rm', '--cached', '-q', '--ignore-unmatch', '--', ...batch]) === null) {
      return {
        action: 'failed',
        untracked: tracked.slice(0, i),
        commitCommand: i > 0 ? UNTRACK_RUNTIME_COMMIT_COMMAND : null,
        message: `git rm --cached failed for: ${batch.join(', ')}`,
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
 * Commits in history that added a `.cleo/` runtime file (T14549 AC6). One
 * `git log --diff-filter=A` restricted to the runtime pathspecs. History is
 * reported, never rewritten.
 *
 * @param projectRoot - Project root.
 * @returns The additions, newest first, or `null` outside git.
 * @task T14549
 */
export function findRuntimeFileAdditions(projectRoot: string): RuntimeFileAddition[] | null {
  const patterns = runtimeDenyPatterns();
  const out = git(projectRoot, [
    'log',
    '--diff-filter=A',
    '--relative',
    '--name-only',
    '-z',
    '--format=%x01%H%x09%cs%x09%s',
    '--',
    ...runtimePathspecs(patterns),
  ]);
  if (out === null) return null;
  const additions: RuntimeFileAddition[] = [];
  for (const record of out.split('\x01')) {
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
  return additions;
}

/**
 * Doctor check: git history holds no commit that added a `.cleo/` runtime
 * file. Such a commit is a likely cause of store corruption: checking it out
 * (or any later commit still tracking the file) swaps the live database.
 *
 * @param projectRoot - Project root.
 * @returns `warning` naming the commits, `info` outside git, else `passed`.
 * @task T14549
 */
export function checkRuntimeFileHistory(projectRoot: string): CheckResult {
  const additions = findRuntimeFileAdditions(projectRoot);
  if (additions === null) {
    return {
      id: 'cleo_runtime_history',
      category: 'configuration',
      status: 'info',
      message: 'Not a git repository (skipping .cleo runtime history check)',
      details: {},
      fix: null,
    };
  }
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
        `git history has ${additions.length} commit(s) that added .cleo runtime files: ${shown}` +
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
    message: 'git history never added a .cleo runtime file',
    details: {},
    fix: null,
  };
}
