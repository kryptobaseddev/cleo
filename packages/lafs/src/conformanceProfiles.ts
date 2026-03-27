import profilesJson from '../schemas/v1/conformance-profiles.json' with { type: 'json' };

export type ConformanceTier = 'core' | 'standard' | 'complete';

export interface ConformanceProfiles {
  version: string;
  tiers: Record<ConformanceTier, string[]>;
}

export function getConformanceProfiles(): ConformanceProfiles {
  return profilesJson as ConformanceProfiles;
}

export function getChecksForTier(tier: ConformanceTier): string[] {
  const profiles = getConformanceProfiles();
  return profiles.tiers[tier] ?? [];
}

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
