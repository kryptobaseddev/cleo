/**
 * Whether a project is rooted at the home directory (T13227, T13257).
 * Providers load instruction files from the working directory up through
 * every ancestor, so a project-scope instruction file at `$HOME` reaches every
 * session under it. Kept in its own dependency-light module so commands can
 * check it without loading the injector.
 *
 * @task T13257
 */

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/** `path` through the native realpath (on-disk case), else resolved. */
function canonicalDir(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Whether `projectDir` is the home directory: a project-scope instruction
 * file there would be loaded into every session under `$HOME` (T13227).
 * Compared through the native realpath, case-folded where volumes are
 * case-insensitive by default (darwin, win32).
 *
 * @param projectDir - the project root.
 * @returns `true` when it is the home directory.
 *
 * @example
 * ```typescript
 * isHomeProject(os.homedir()); // true
 * ```
 *
 * @public
 */
export function isHomeProject(projectDir: string): boolean {
  const fold = (p: string): string =>
    process.platform === 'darwin' || process.platform === 'win32' ? p.toLowerCase() : p;
  return fold(canonicalDir(projectDir)) === fold(canonicalDir(homedir()));
}
