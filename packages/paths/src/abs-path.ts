/**
 * Cross-platform absolute path detection.
 *
 * Recognises POSIX absolute paths (`/...`), Windows drive letters (`C:\...`,
 * `D:/...`), and UNC paths (`\\server\share`). Used in path-resolution code
 * that needs to short-circuit when given an already-absolute path without
 * importing the heavier `node:path#isAbsolute`.
 *
 * @task T1883
 */

const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;

/**
 * Check if a path is absolute on any supported platform.
 *
 * @param path - Filesystem path to check.
 * @returns `true` for POSIX absolute, Windows drive-rooted, or UNC paths.
 *
 * @example
 * ```typescript
 * isAbsolutePath('/usr/bin');     // true
 * isAbsolutePath('C:\\Users');    // true
 * isAbsolutePath('\\\\srv\\sh');  // true
 * isAbsolutePath('./relative');   // false
 * ```
 *
 * @public
 */
export function isAbsolutePath(path: string): boolean {
  if (path.startsWith('/')) return true;
  if (WINDOWS_DRIVE_RE.test(path)) return true;
  if (path.startsWith('\\\\')) return true;
  return false;
}
