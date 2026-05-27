/**
 * Version-bump contracts — types describing how `cleo release ship` finds
 * and updates version-bearing files across a project's ecosystem(s).
 *
 * The implementation lives in `@cleocode/core/release/version-bump.ts`. The
 * types live here so contracts consumers (CLI, studio, downstream tools)
 * can describe / validate the same shapes without depending on core.
 *
 * @adr ADR-063
 */

/** Supported version-bump strategies. */
export type VersionBumpStrategy = 'plain' | 'json' | 'toml' | 'sed';

/**
 * Version bump target — a single file the release pipeline knows how to
 * bump. Discovery returns these, an explicit config in
 * `.cleo/config.json` (`release.versionBump.files`) populates them.
 */
export interface VersionBumpTarget {
  /** Path relative to the project root. */
  file: string;
  /** Update strategy. */
  strategy: VersionBumpStrategy;
  /** JSON field path for `strategy='json'` (e.g. `version`, `package.version`). */
  field?: string;
  /** TOML key for `strategy='toml'` (default: `version`). */
  key?: string;
  /** TOML section for `strategy='toml'` (e.g. `package`, `workspace.package`). */
  section?: string;
  /** Sed pattern with `{{VERSION}}` placeholder for `strategy='sed'`. */
  pattern?: string;
}

/** Bump type used by `calculateNewVersion`. */
export type BumpType = 'patch' | 'minor' | 'major';

/** Result for a single file's bump attempt. */
export interface BumpResult {
  /** Path relative to the project root. */
  file: string;
  /** Strategy used. */
  strategy: VersionBumpStrategy | string;
  /** Whether the bump succeeded. */
  success: boolean;
  /** Version found in the file before the bump, if it could be extracted. */
  previousVersion?: string;
  /** Version written to the file. */
  newVersion?: string;
  /** Human-readable error when `success === false`. */
  error?: string;
}

/**
 * Where the version-bump targets came from. Lets callers log / diagnose why
 * a release commit included or omitted version files.
 */
export type VersionBumpTargetSource = 'config' | 'workspace' | 'none';

/** Envelope returned by `resolveVersionBumpTargets`. */
export interface ResolveVersionBumpTargetsResult {
  /** Targets to bump. Empty when `source === 'none'`. */
  targets: VersionBumpTarget[];
  /**
   * How the targets were resolved:
   *   - `'config'`     — explicit `release.versionBump.files` entry
   *   - `'workspace'`  — auto-discovered from filesystem markers
   *   - `'none'`       — neither config nor a recognised workspace
   */
  source: VersionBumpTargetSource;
}

/** Bulk-bump result envelope. */
export interface BumpVersionFromConfigResult {
  /** Per-file results. */
  results: BumpResult[];
  /** `true` iff every result succeeded. */
  allSuccess: boolean;
}
