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

/**
 * Prefix of the value a NOT NULL machine-local path cell holds in a row that
 * only another machine has (a project or skill restored by the cloud vault
 * that does not live on this machine): a placeholder, not a path (T12336).
 */
export const VAULT_REMOTE_PATH_PREFIX = 'cleo-vault-remote:';

/** A path segment that starts with {@link VAULT_REMOTE_PATH_PREFIX}: a placeholder resolved against a directory. */
const VAULT_REMOTE_SEGMENT = /(^|[\\/])cleo-vault-remote:/;

/**
 * Whether a path value is, or was resolved from, the cloud vault's
 * placeholder for a row another machine holds: the raw value, or a path with
 * a segment that starts with {@link VAULT_REMOTE_PATH_PREFIX} (the placeholder
 * resolved against a working directory, T13021). Such a value names no
 * location here: nothing may resolve, probe or open it as a path (T13006).
 *
 * @param value - A path value (a registry `project_path`, a `cwd`, a resolved root).
 * @returns `true` for a placeholder, raw or resolved.
 *
 * @example
 * ```typescript
 * isVaultRemotePath('cleo-vault-remote:nexus_project_registry:["p2"]:project_path'); // true
 * isVaultRemotePath('/tmp/x/cleo-vault-remote:nexus_project_registry:["p2"]:project_path'); // true
 * isVaultRemotePath('/home/me/p2'); // false
 * ```
 *
 * @public
 */
export function isVaultRemotePath(value: string | null | undefined): boolean {
  return typeof value === 'string' && VAULT_REMOTE_SEGMENT.test(value);
}
