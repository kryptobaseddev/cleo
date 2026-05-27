import profilesJson from '../schemas/v1/conformance-profiles.json' with { type: 'json' };

/**
 * Named conformance tier indicating the breadth of checks applied.
 *
 * @remarks
 * Tiers are cumulative: `core` is a subset of `standard`, which is
 * a subset of `complete`.
 */
export type ConformanceTier = 'core' | 'standard' | 'complete';

/**
 * Schema for the conformance-profiles JSON file.
 *
 * @remarks
 * Maps each {@link ConformanceTier} to the set of check names it includes.
 */
export interface ConformanceProfiles {
  /** Semantic version of the conformance-profiles schema. */
  version: string;
  /** Mapping from tier name to the ordered list of check names in that tier. */
  tiers: Record<ConformanceTier, string[]>;
}

/**
 * Loads the conformance profiles from the bundled JSON schema.
 *
 * @remarks
 * Returns the parsed `conformance-profiles.json` as a typed object.
 * The profiles define which checks belong to each conformance tier.
 *
 * @returns The full {@link ConformanceProfiles} object.
 *
 * @example
 * ```ts
 * const profiles = getConformanceProfiles();
 * console.log(profiles.tiers.core);
 * ```
 */
export function getConformanceProfiles(): ConformanceProfiles {
  return profilesJson as ConformanceProfiles;
}

/**
 * Returns the list of check names that belong to the given conformance tier.
 *
 * @remarks
 * Retrieves the tier from the bundled profiles JSON. Returns an empty
 * array when the tier key is not found (defensive fallback).
 *
 * @param tier - The conformance tier to retrieve checks for.
 * @returns An array of check name strings for the specified tier.
 *
 * @example
 * ```ts
 * const coreChecks = getChecksForTier('core');
 * ```
 */
export function getChecksForTier(tier: ConformanceTier): string[] {
  const profiles = getConformanceProfiles();
  return profiles.tiers[tier] ?? [];
}

/**
 * Validates that the conformance profiles are internally consistent and reference only known checks.
 *
 * @remarks
 * Verifies two invariants:
 * 1. Tier superset containment: every `core` check appears in `standard`,
 *    and every `standard` check appears in `complete`.
 * 2. Known-check coverage: every check name referenced in any tier exists
 *    in the provided `availableChecks` list.
 *
 * @param availableChecks - The full list of check names implemented by the conformance runner.
 * @returns An object with `valid` (true when no errors) and an `errors` array of diagnostic strings.
 *
 * @example
 * ```ts
 * const result = validateConformanceProfiles(['envelope_schema_valid', 'envelope_invariants']);
 * if (!result.valid) {
 *   console.error(result.errors);
 * }
 * ```
 */
export function validateConformanceProfiles(availableChecks: string[]): {
  valid: boolean;
  errors: string[];
} {
  const profiles = getConformanceProfiles();
  const errors: string[] = [];

  const core = new Set(profiles.tiers.core);
  const standard = new Set(profiles.tiers.standard);
  const complete = new Set(profiles.tiers.complete);

  for (const check of core) {
    if (!standard.has(check)) {
      errors.push(`standard tier must include core check: ${check}`);
    }
  }

  for (const check of standard) {
    if (!complete.has(check)) {
      errors.push(`complete tier must include standard check: ${check}`);
    }
  }

  const known = new Set(availableChecks);
  for (const [tier, checks] of Object.entries(profiles.tiers) as Array<
    [ConformanceTier, string[]]
  >) {
    for (const check of checks) {
      if (!known.has(check)) {
        errors.push(`unknown check in ${tier} tier: ${check}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
