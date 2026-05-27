/**
 * `cleo release validate-changelog <version>` — canonical CHANGELOG header
 * validator.
 *
 * Replaces the brittle inline `grep -qF "## [${VERSION}]"` step in
 * `.github/workflows/release.yml` (and any consumer-shipped release
 * workflow) with a typed CLEO verb that returns a LAFS envelope and is
 * version-format aware.
 *
 * Background — caught during the v2026.5.94 hotfix-2 ship: the aggregator
 * emitted `## [vVERSION]` (with v-prefix) while the workflow grep expected
 * `## [VERSION]` (no v-prefix) per ADR-028 §2.5. The version-prefix
 * normalisation lived in two places (the aggregator + the workflow shell
 * step) and drifted. Centralising the canonical-header check inside CLEO
 * removes the shell-quoting risk and gives consumer projects a single
 * source of truth that travels with the SDK.
 *
 * Canonical header shape (per ADR-028 §2.5):
 *   `## [<VERSION>]` — VERSION carries NO `v` prefix (CalVer or SemVer).
 *
 * Inputs accepted (all normalised to the no-v form internally):
 *   `2026.5.94`, `v2026.5.94`, `2026.5.94 ` (trailing whitespace).
 *
 * @module release/validate-changelog
 * @task T9937
 * @saga T9862
 * @adr ADR-028 §2.5 — canonical CHANGELOG header is `## [VERSION]` (no v)
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { getLogger } from '../logger.js';

const log = getLogger('release:validate-changelog');

/** Default CHANGELOG filename relative to the project root. */
const DEFAULT_CHANGELOG_FILE = 'CHANGELOG.md';

/**
 * Options accepted by {@link validateChangelog}.
 *
 * @task T9937
 */
export interface ValidateChangelogOptions {
  /**
   * Version under release. Accepts `v2026.5.94`, `2026.5.94`, or
   * `2026.5.94 ` (trailing whitespace tolerated). Always normalised to the
   * no-v form before the header check runs.
   */
  version: string;
  /**
   * Project root used to resolve `CHANGELOG.md` when `changelogPath` is
   * omitted. Required so the verb is project-agnostic (consumer projects
   * pass their own root via the dispatch layer).
   */
  projectRoot: string;
  /**
   * Explicit override for the changelog file path. When supplied, this is
   * used verbatim and `projectRoot` is ignored for path resolution. Useful
   * for repositories that pin release notes outside `CHANGELOG.md`.
   */
  changelogPath?: string;
}

/**
 * Result envelope returned by {@link validateChangelog}.
 *
 * @task T9937
 */
export interface ValidateChangelogResult {
  /** True iff the canonical `## [<version>]` header was found. */
  valid: boolean;
  /** Caller-supplied version string, verbatim. */
  version: string;
  /** Version normalised to the no-v form used for the header match. */
  normalizedVersion: string;
  /** Absolute path to the CHANGELOG.md inspected. */
  changelogPath: string;
  /**
   * The matching `## [<version>]` literal extracted from the file. `null`
   * when no header matched (or the file was missing).
   */
  headerFound: string | null;
  /**
   * Human-readable explanation of WHY `valid=false`. Absent when `valid=true`.
   * Operators see this string in the LAFS envelope's `data.reason` field.
   */
  reason?: string;
}

/**
 * Normalise a release version string to the canonical CHANGELOG header
 * form (no `v` prefix per ADR-028 §2.5).
 *
 * @internal
 * @task T9937
 */
function normaliseVersionForHeader(input: string): string {
  const trimmed = input.trim();
  return trimmed.startsWith('v') ? trimmed.slice(1) : trimmed;
}

/**
 * Resolve the changelog path — explicit override wins; otherwise
 * `<projectRoot>/CHANGELOG.md`. Relative `changelogPath` values are
 * resolved against `projectRoot`.
 *
 * @internal
 * @task T9937
 */
function resolveChangelogPath(opts: ValidateChangelogOptions): string {
  if (opts.changelogPath) {
    return isAbsolute(opts.changelogPath)
      ? opts.changelogPath
      : join(opts.projectRoot, opts.changelogPath);
  }
  return join(opts.projectRoot, DEFAULT_CHANGELOG_FILE);
}

/**
 * Validate that `CHANGELOG.md` contains the canonical `## [<version>]`
 * header for the given release version.
 *
 * Semantics:
 *  - Both `2026.5.94` and `v2026.5.94` accepted as input; matched against
 *    the canonical no-v form on disk.
 *  - The header MAY be followed by `(YYYY-MM-DD)` or other trailing text
 *    on the same line — only the `## [<version>]` literal anchors the match.
 *  - Missing CHANGELOG.md → `valid=false` + `reason` describing the gap.
 *  - Missing canonical header → `valid=false` + `reason` containing the
 *    exact header literal the gate expected.
 *
 * @param opts See {@link ValidateChangelogOptions}.
 * @returns A {@link ValidateChangelogResult} envelope. Pure — no writes,
 *          no network, no shell-out.
 *
 * @task T9937
 * @saga T9862
 *
 * @example
 * ```ts
 * const result = await validateChangelog({
 *   version: 'v2026.5.94',
 *   projectRoot: process.cwd(),
 * });
 * if (!result.valid) {
 *   console.error(result.reason);
 *   process.exit(1);
 * }
 * ```
 */
export async function validateChangelog(
  opts: ValidateChangelogOptions,
): Promise<ValidateChangelogResult> {
  const normalizedVersion = normaliseVersionForHeader(opts.version);
  const changelogPath = resolveChangelogPath(opts);
  const expectedHeader = `## [${normalizedVersion}]`;

  if (!existsSync(changelogPath)) {
    log.warn({ changelogPath, version: opts.version }, 'CHANGELOG.md not found');
    return {
      valid: false,
      version: opts.version,
      normalizedVersion,
      changelogPath,
      headerFound: null,
      reason: `CHANGELOG.md not found at ${changelogPath}`,
    };
  }

  let contents: string;
  try {
    contents = await readFile(changelogPath, 'utf-8');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      version: opts.version,
      normalizedVersion,
      changelogPath,
      headerFound: null,
      reason: `failed to read CHANGELOG.md: ${message}`,
    };
  }

  // Canonical match: literal `## [<version>]` at the start of a line. The
  // line MAY continue with `(date)` or other trailing text — we anchor on
  // the bracketed version literal so the check is equivalent to the legacy
  // `grep -qF "## [VERSION]"` semantics that consumers have relied on
  // since ADR-028 was first issued.
  if (contents.includes(expectedHeader)) {
    return {
      valid: true,
      version: opts.version,
      normalizedVersion,
      changelogPath,
      headerFound: expectedHeader,
    };
  }

  return {
    valid: false,
    version: opts.version,
    normalizedVersion,
    changelogPath,
    headerFound: null,
    reason:
      `CHANGELOG.md at ${changelogPath} does not contain the canonical ` +
      `header for v${normalizedVersion}. Expected to find: ${expectedHeader}. ` +
      `Add a section locally (or re-run \`cleo release plan v${normalizedVersion}\`) ` +
      `before pushing the tag.`,
  };
}
