/**
 * Directory containment by file identity, for the Gate B/C key location
 * check (T12641).
 *
 * Comparing path strings is wrong on two counts. A symlink puts one
 * directory under two names. A case-insensitive filesystem (the macOS
 * default, and Windows) does the same with `Out` and `out`, and
 * `fs.realpathSync` (the JS implementation) keeps the caller's case. So the
 * check resolves the candidate with `realpathSync.native`, which folds case
 * where the OS does. Then it walks up the candidate's ancestors, comparing
 * each one's device and inode with the directory's. That catches any
 * remaining alias whatever its spelling.
 *
 * @module scripts/lib/path-containment
 */

import { realpathSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Whether `dir` is `target`'s parent directory or one of that directory's
 * ancestors. `target` itself may not exist yet, but its parent directory
 * must.
 *
 * @param {string} target - Path of a file to create (for example a key).
 * @param {string} dir - An existing directory.
 * @param {{ stat?: (p: string) => { dev: number | bigint, ino: number | bigint },
 *   realpath?: (p: string) => string }} [fsOps] - Overrides for tests
 *   (the defaults are `statSync` and `realpathSync.native`).
 * @returns {boolean} `true` when `target` would be inside `dir`'s tree.
 */
export function isInsideDirectoryTree(target, dir, fsOps = {}) {
  // bigint: device and inode numbers can exceed 2^53 and must compare exactly.
  const stat = fsOps.stat ?? ((p) => statSync(p, { bigint: true }));
  const realpath = fsOps.realpath ?? ((p) => realpathSync.native(p));
  const want = stat(realpath(dir));
  for (let d = realpath(dirname(target)); ; d = dirname(d)) {
    const s = stat(d);
    if (s.dev === want.dev && s.ino === want.ino) return true;
    if (dirname(d) === d) return false;
  }
}
