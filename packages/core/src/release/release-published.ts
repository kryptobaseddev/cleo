/**
 * Whether a release tag actually shipped (T14173).
 *
 * A tag whose `release.yml` run failed before creating its GitHub Release
 * (v2026.11.1-canary.1) published nothing, so it must not become the base of
 * the next release's notes, CHANGELOG section or reconcile range: its
 * changesets and tasks would drop out of every later release.
 *
 * @task T14173
 */

/**
 * The GitHub Release state of `tag`: `true` when a published (non-draft)
 * release exists, `false` when there is none (HTTP 404) or it is a draft,
 * `null` when `gh` could not tell (no auth, no remote, network). Callers
 * decide what unknown means: the cut refuses, reconcile keeps the tag.
 *
 * @param tag - Release tag, e.g. `v2026.11.1-canary.1`.
 * @param runGh - Runs `gh` with the given args in the repository and returns stdout; throws on failure.
 * @returns The state, or `null` when unknown.
 *
 * @example
 * ```ts
 * githubReleaseState('v2026.10.27', (args) => execFileSync('gh', [...args], { encoding: 'utf-8' })); // true
 * ```
 */
export function githubReleaseState(
  tag: string,
  runGh: (args: readonly string[]) => string,
): boolean | null {
  try {
    const release: { draft?: boolean } = JSON.parse(
      runGh(['api', `repos/{owner}/{repo}/releases/tags/${tag}`]),
    );
    return release.draft !== true;
  } catch (err) {
    return err instanceof Error && /HTTP 404|Not Found/.test(err.message) ? false : null;
  }
}
