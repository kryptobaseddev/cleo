/**
 * Canonical release-version normalisation (gh#1440).
 *
 * ## Why this is a shared module
 *
 * Release versions are accepted from operators in both spellings — `2026.9.4`
 * and `v2026.9.4` — and the pipeline stores, tags and names files with the
 * `v`-prefixed form. Every verb therefore has to normalise, and before this
 * module two verbs did it from private copies while a third did not do it at
 * all:
 *
 * | verb | behaviour before |
 * |---|---|
 * | `release plan` | private copy in `plan.ts` — normalised |
 * | manifest reads | private copy in `release-manifest.ts` — normalised |
 * | `release reconcile` | **took the argument verbatim** |
 *
 * The consequence, measured cutting v2026.9.4: `cleo release plan 2026.9.4`
 * wrote `.cleo/release/v2026.9.4.plan.json` and reported success, then
 * `cleo release reconcile 2026.9.4` — the same string — failed with
 * `E_PLAN_NOT_FOUND` looking for `2026.9.4.plan.json`, and its `fix` told the
 * operator to run `cleo release plan 2026.9.4`: the command that had just
 * succeeded and produced the file it could not see. Following the fix loops
 * forever, and the documented runbook in AGENTS.md uses the bare form for both
 * verbs, so the runbook as written could not work.
 *
 * Two copies of a rule is how the third callsite comes to not have it. One
 * function, one place — the same conclusion `collection-keys.ts` reached after
 * three outages of its own.
 *
 * @task gh#1440
 */

/**
 * Normalise a release version to its canonical `v`-prefixed form.
 *
 * Idempotent: an already-prefixed version is returned unchanged.
 *
 * @param version - Version as supplied by an operator (`2026.9.4` or `v2026.9.4`).
 * @returns The `v`-prefixed form (`v2026.9.4`).
 *
 * @example
 * ```ts
 * normalizeVersion('2026.9.4');  // 'v2026.9.4'
 * normalizeVersion('v2026.9.4'); // 'v2026.9.4'
 * ```
 */
export function normalizeVersion(version: string): string {
  return version.startsWith('v') ? version : `v${version}`;
}
