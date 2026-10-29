/**
 * Standing release authorization seam (owner decision D11212). A non-interactive
 * `cleo release cut --yes` (an agent) tags only when the owner stored a
 * standing authorization for it; a human at a terminal confirms directly.
 *
 * @task T14102
 */

/**
 * Whether a stored standing authorization lets a non-interactive caller cut
 * `version`.
 *
 * shortcut: always false; T14141 (`cleo release authorize` with scope, expiry,
 * revoke and an audit row) replaces this with the stored authorization.
 *
 * @param _projectRoot - Project whose authorization is read.
 * @param _version - Version being cut.
 * @returns True when an unexpired, unrevoked authorization covers the cut.
 *
 * @example
 * ```ts
 * if (!hasReleaseAuthorization(projectRoot, 'v2026.10.28')) refuse();
 * ```
 *
 * @task T14102
 */
export function hasReleaseAuthorization(_projectRoot: string, _version: string): boolean {
  return false;
}
