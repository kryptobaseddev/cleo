/**
 * Dependency registry contracts for CLEO runtime dependency verification.
 *
 * This is the single source of truth (SSoT) for all CLEO dependency types.
 * All health check systems that inspect external dependencies MUST use these
 * contracts rather than defining inline or ad-hoc types.
 *
 * @task T507
 */

/**
 * Classification of a CLEO dependency by necessity.
 *
 * - `required` — CLEO cannot function without this dependency.
 * - `optional` — CLEO works without this but specific features are disabled.
 * - `feature` — A bundled or internally-managed dependency (e.g. native addons).
 */
export type DependencyCategory = 'required' | 'optional' | 'feature';

/**
 * Static specification describing a single CLEO dependency.
 *
 * This is the registry entry — it does NOT carry check results.
 * Use {@link DependencyCheckResult} for runtime check outcomes.
 */
export interface DependencySpec {
  /** Canonical identifier used as a lookup key (e.g. `"git"`, `"gh"`). */
  name: string;
  /** Classification of the dependency by necessity. */
  category: DependencyCategory;
  /** Human-readable description of what the dependency is used for. */
  description: string;
  /** Semver-style constraint string (e.g. `">=24.0.0"`). Optional. */
  versionConstraint?: string;
  /** URL pointing to installation or documentation for this dependency. */
  documentationUrl?: string;
  /** Shell command to install the dependency (informational only). */
  installCommand?: string;
  /**
   * Platforms on which this dependency applies.
   * When absent the dependency is considered applicable on all platforms.
   */
  platforms?: ('linux' | 'darwin' | 'win32')[];
}

/**
 * Runtime check result for a single CLEO dependency.
 *
 * Produced by `checkDependency()` and collected into a {@link DependencyReport}.
 */
export interface DependencyCheckResult {
  /** Canonical identifier matching the corresponding {@link DependencySpec}. */
  name: string;
  /** Classification of the dependency (copied from its spec). */
  category: DependencyCategory;
  /** Whether the dependency is present on the system. */
  installed: boolean;
  /** Detected version string, if available (e.g. `"2.43.0"`). */
  version?: string;
  /** Filesystem path where the dependency was found (e.g. `/usr/bin/git`). */
  location?: string;
  /**
   * Whether the dependency passes all health criteria.
   *
   * For `required` dependencies this means installed AND the version satisfies
   * `versionConstraint`. For `optional` and `feature` dependencies a missing
   * dependency is still considered healthy (the feature is simply disabled).
   */
  healthy: boolean;
  /** Human-readable error or diagnostic message when `healthy` is `false`. */
  error?: string;
  /** Actionable fix suggestion to show the user when `healthy` is `false`. */
  suggestedFix?: string;
}

/**
 * Full dependency report produced by `checkAllDependencies()`.
 *
 * Intended for consumption by `coreDoctorReport()` and any CLI output layer.
 */
export interface DependencyReport {
  /** ISO 8601 timestamp of when the report was generated. */
  timestamp: string;
  /** `process.platform` value at check time (e.g. `"linux"`, `"darwin"`). */
  platform: string;
  /** Node.js version string without the `v` prefix (e.g. `"24.0.0"`). */
  nodeVersion: string;
  /** Per-dependency check results. */
  results: DependencyCheckResult[];
  /**
   * `true` when every `required` dependency is healthy.
   * Optional and feature dependencies do not affect this flag.
   */
  allRequiredMet: boolean;
  /** Non-fatal advisory messages (e.g. optional dep missing, feature unavailable). */
  warnings: string[];
}
