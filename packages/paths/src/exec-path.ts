/**
 * Cross-platform PATH composition and executable lookup.
 *
 * `PATH` is `:`-delimited on POSIX and `;`-delimited on Windows, where the
 * variable is also commonly spelled `Path` and a bare command name resolves
 * through `PATHEXT` (`git` → `git.exe`, `cleo` → `cleo.cmd`). Building PATH as
 * `${dir}:${PATH}` on Windows fuses the new directory with the first real
 * entry, and splitting on `:` cuts every `C:\…` drive-letter entry in half, so
 * each helper here takes the platform explicitly (defaulting to the running
 * one) and joins with that platform's path module. Tests inject `win32` on
 * any host.
 *
 * Lookups are in-process filesystem probes — no `which`/`where` child — so
 * they behave identically on every OS and cost no process spawn.
 *
 * @task T12605
 */

import { accessSync, constants, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';

/** Platform-injection options shared by the PATH helpers. */
export interface ExecPathOptions {
  /** Platform whose PATH rules apply. @defaultValue `process.platform` */
  platform?: NodeJS.Platform;
  /** Environment holding `PATH`/`Path` and `PATHEXT`. @defaultValue `process.env` */
  env?: NodeJS.ProcessEnv;
  /**
   * Predicate deciding whether a candidate file is runnable.
   * @defaultValue a regular file that is executable (POSIX) or exists (win32)
   */
  isExecutable?: (candidate: string) => boolean;
}

/** `PATHEXT` used on Windows when the variable is unset. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * Return the PATH list delimiter for a platform (`;` on win32, `:` elsewhere).
 *
 * @param platform - Target platform. @defaultValue `process.platform`
 * @returns The delimiter character.
 */
export function pathDelimiterFor(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? win32.delimiter : posix.delimiter;
}

/**
 * Return the environment key that holds the executable search path.
 *
 * Windows environment names are case-insensitive and the system spelling is
 * `Path`; writing a second `PATH` key beside it leaves the child with two
 * conflicting values. The existing key is reused whatever its case.
 *
 * @param env - Environment to inspect.
 * @param platform - Target platform. @defaultValue `process.platform`
 * @returns `PATH`, or the existing case-variant on win32.
 */
export function pathEnvKey(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') return 'PATH';
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
}

/**
 * Split a PATH value into its non-empty directory entries.
 *
 * @param value - Raw PATH value (may be undefined).
 * @param platform - Target platform. @defaultValue `process.platform`
 * @returns Directory entries in search order.
 * @example
 * ```ts
 * splitPathEnv('C:\\Windows;C:\\Git\\cmd', 'win32'); // ['C:\\Windows', 'C:\\Git\\cmd']
 * ```
 */
export function splitPathEnv(
  value: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string[] {
  return (value ?? '').split(pathDelimiterFor(platform)).filter(Boolean);
}

/**
 * Prepend a directory to a PATH value using the platform's delimiter.
 *
 * @param dir - Directory to search first.
 * @param currentPath - Existing PATH value (may be empty or undefined).
 * @param platform - Target platform. @defaultValue `process.platform`
 * @returns The composed PATH value; `dir` alone when `currentPath` is empty.
 * @example
 * ```ts
 * prependPathEntry('C:\\shim', 'C:\\Windows', 'win32'); // 'C:\\shim;C:\\Windows'
 * ```
 */
export function prependPathEntry(
  dir: string,
  currentPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  return currentPath ? `${dir}${pathDelimiterFor(platform)}${currentPath}` : dir;
}

/**
 * List the file names a bare command can resolve to on a platform.
 *
 * On win32 each `PATHEXT` extension is tried, and the bare name only when it
 * already carries one of those extensions. Elsewhere the name is used as-is.
 *
 * @param name - Command name, e.g. `git`.
 * @param opts - Platform and environment overrides.
 * @returns Candidate file names in resolution order.
 */
export function executableNames(name: string, opts: ExecPathOptions = {}): string[] {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') return [name];
  const env = opts.env ?? process.env;
  const exts = (env[pathExtKey(env)] || DEFAULT_PATHEXT)
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
  const lower = name.toLowerCase();
  if (exts.some((ext) => lower.endsWith(ext))) return [name];
  return exts.map((ext) => `${name}${ext}`);
}

/**
 * Resolve a command to the absolute path the OS would run, or `null`.
 *
 * Honours the platform's PATH delimiter, the win32 `Path` spelling, and
 * `PATHEXT`. A name containing a path separator is checked directly rather
 * than searched for.
 *
 * @param name - Command name or path.
 * @param opts - Platform, environment and executability overrides.
 * @returns Absolute path of the first match, or `null`.
 * @example
 * ```ts
 * findOnPath('git'); // '/usr/bin/git' on Linux, 'C:\\Program Files\\Git\\cmd\\git.exe' on Windows
 * ```
 */
export function findOnPath(name: string, opts: ExecPathOptions = {}): string | null {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const pathApi = platform === 'win32' ? win32 : posix;
  const isExecutable = opts.isExecutable ?? ((p: string) => defaultIsExecutable(p, platform));
  const names = executableNames(name, { platform, env });

  const hasSeparator = platform === 'win32' ? /[\\/]/.test(name) : name.includes('/');
  const dirs = hasSeparator ? [''] : splitPathEnv(env[pathEnvKey(env, platform)], platform);
  for (const dir of dirs) {
    for (const candidateName of names) {
      const candidate = dir ? pathApi.join(dir, candidateName) : candidateName;
      if (isExecutable(candidate)) return pathApi.resolve(candidate);
    }
  }
  return null;
}

/** A shell command line resolved to an argv the platform can spawn. */
export interface ShellInvocation {
  /** Shell executable. */
  file: string;
  /** Arguments that make the shell run the command line once. */
  args: string[];
  /** Pass to `child_process` so cmd.exe receives the quoted line untouched. */
  windowsVerbatimArguments: boolean;
}

/**
 * Resolve how to run a shell command line on a platform.
 *
 * `/bin/sh -c` on POSIX; on win32 `%ComSpec%` (cmd.exe) with `/d /s /c` and
 * the line quoted verbatim — the same resolution Node applies for
 * `shell: true`, made explicit so every caller that runs user-authored
 * command strings (worktree hooks, release build commands) shares one
 * resolver and tests can pin the platform.
 *
 * @param command - Command line to run.
 * @param opts - Platform and environment overrides.
 * @returns The executable, its argv and the verbatim-arguments flag.
 * @example
 * ```ts
 * const sh = shellInvocation('pnpm build');
 * execFile(sh.file, sh.args, { windowsVerbatimArguments: sh.windowsVerbatimArguments });
 * ```
 */
export function shellInvocation(command: string, opts: ExecPathOptions = {}): ShellInvocation {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') {
    return { file: '/bin/sh', args: ['-c', command], windowsVerbatimArguments: false };
  }
  const env = opts.env ?? process.env;
  const comSpecKey = Object.keys(env).find((key) => key.toUpperCase() === 'COMSPEC');
  const file = (comSpecKey && env[comSpecKey]) || 'cmd.exe';
  return { file, args: ['/d', '/s', '/c', `"${command}"`], windowsVerbatimArguments: true };
}

/** Environment key for `PATHEXT`, matched case-insensitively. */
function pathExtKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATHEXT') ?? 'PATHEXT';
}

/** A regular file that the current user may execute (existence alone on win32). */
function defaultIsExecutable(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    if (platform !== 'win32') accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
