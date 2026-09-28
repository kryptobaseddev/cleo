/**
 * Install the `git` launcher(s) that route a shim-dir PATH lookup to the shim.
 *
 * POSIX resolves `<shimDir>/git` through a symlink to `dist/shim.js`, whose
 * shebang runs Node. Windows can do neither: `PATHEXT` never matches an
 * extensionless file, and an unprivileged process cannot create a file
 * symlink. There the launchers are real files — `git.cmd` for cmd.exe and
 * PowerShell, plus an extensionless `/bin/sh` script for Git Bash/MSYS, which
 * searches PATH for the bare name. Without them branch protection is silently
 * absent on Windows (T12605).
 *
 * @task T12605
 */

import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/** Options for {@link installGitShimLaunchers}. */
export interface GitShimLauncherOptions {
  /**
   * Platform whose launcher form to install. Only the launcher FORM follows
   * this; files are written with the host path module.
   * @defaultValue `process.platform`
   */
  platform?: NodeJS.Platform;
  /** Node executable the win32 launchers invoke. @defaultValue `process.execPath` */
  nodePath?: string;
}

/**
 * Install the launcher files for `git` in `shimDir`. Idempotent.
 *
 * @param shimDir - Directory prepended to the worker's PATH.
 * @param shimBinPath - Absolute path to the shim entry point (`dist/shim.js`).
 * @param opts - Platform and Node-path overrides.
 * @returns Absolute paths of the launchers now present.
 * @throws When a launcher cannot be written.
 * @example
 * ```ts
 * installGitShimLaunchers('/repo/.cleo/bin/git-shim', '/repo/node_modules/@cleocode/git-shim/dist/shim.js');
 * ```
 */
export function installGitShimLaunchers(
  shimDir: string,
  shimBinPath: string,
  opts: GitShimLauncherOptions = {},
): string[] {
  const platform = opts.platform ?? process.platform;
  mkdirSync(shimDir, { recursive: true });

  if (platform !== 'win32') {
    const linkPath = join(shimDir, 'git');
    if (!isSymlinkTo(linkPath, shimBinPath)) {
      removeIfPresent(linkPath);
      symlinkSync(shimBinPath, linkPath);
      // Only on create/replace: an existing correct link needs no write to
      // the (possibly package-owned, read-only) shim binary.
      chmodSync(shimBinPath, 0o755);
    }
    return [linkPath];
  }

  const node = opts.nodePath ?? process.execPath;
  const cmdPath = join(shimDir, 'git.cmd');
  const shPath = join(shimDir, 'git');
  // `%*` forwards every argument; the launcher's exit code is Node's.
  writeIfChanged(cmdPath, `@"${node}" "${shimBinPath}" %*\r\n`);
  // Git Bash accepts forward-slash Windows paths; a symlink here would need
  // privileges, so the sh launcher replaces any stale one.
  const toSh = (p: string): string => p.replace(/\\/g, '/');
  writeIfChanged(shPath, `#!/bin/sh\nexec "${toSh(node)}" "${toSh(shimBinPath)}" "$@"\n`);
  return [cmdPath, shPath];
}

/** Whether `linkPath` is a symlink whose target is exactly `target`. */
function isSymlinkTo(linkPath: string, target: string): boolean {
  try {
    return lstatSync(linkPath).isSymbolicLink() && readlinkSync(linkPath) === target;
  } catch {
    return false;
  }
}

/** Remove a file or (dangling) symlink when one exists. */
function removeIfPresent(path: string): void {
  try {
    lstatSync(path);
  } catch {
    return;
  }
  unlinkSync(path);
}

/** Write `content`, replacing a symlink or differing file; skip identical content. */
function writeIfChanged(path: string, content: string): void {
  try {
    if (!lstatSync(path).isSymbolicLink() && readFileSync(path, 'utf-8') === content) return;
  } catch {
    // absent or unreadable — (re)write below
  }
  removeIfPresent(path);
  writeFileSync(path, content, { encoding: 'utf-8', mode: 0o755 });
}
