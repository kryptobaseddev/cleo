/**
 * Standing release authorization seam (owner decision D11212). `cleo release
 * cut --yes` tags when the owner stored a standing authorization for it (an
 * agent), or when the person at the terminal types the version.
 *
 * @task T14102
 */

/**
 * The stored standing authorization that lets a caller cut `version` without a
 * typed terminal confirmation, or null.
 *
 * shortcut: always null; T14141 (`cleo release authorize` with scope, expiry,
 * revoke and an audit row) replaces this with the stored authorization.
 *
 * @param _projectRoot - Project whose authorization is read.
 * @param _version - Version being cut.
 * @returns The authorization's id when an unexpired, unrevoked one covers the cut.
 *
 * @example
 * ```ts
 * const auth = releaseAuthorizationFor(projectRoot, 'v2026.10.28');
 * ```
 *
 * @task T14102
 */
export function releaseAuthorizationFor(
  _projectRoot: string,
  _version: string,
): { id: string } | null {
  return null;
}
