/**
 * Release channel resolution and validation.
 *
 * Maps Git branches to npm dist-tags and validates that version strings
 * conform to the expectations of their target channel.
 *
 * @task T5586
 */

import type { ChannelConfig } from './release-config.js';

export type { ChannelConfig };

/** npm dist-tag channel for a release. */
export type ReleaseChannel = 'latest' | 'beta' | 'alpha';

/** Result of validating a version string against a channel's expectations. */
export interface ChannelValidationResult {
  valid: boolean;
  expected?: string;
  actual?: string;
  message: string;
}

/** Return the default branch-to-channel mapping. */
export function getDefaultChannelConfig(): ChannelConfig {
  return {
    main: 'main',
    develop: 'develop',
    feature: 'feature/',
  };
}

/**
 * Resolve the release channel for a given Git branch name.
 *
 * Resolution order:
 * 1. Exact match in `config.custom`
 * 2. Prefix match in `config.custom`
 * 3. Exact match against `config.main` → 'latest'
 * 4. Exact match against `config.develop` → 'beta'
 * 5. Starts with 'feature/', 'hotfix/', 'release/', or `config.feature` → 'alpha'
 * 6. Fallback → 'alpha'
 */
export function resolveChannelFromBranch(
  branch: string,
  config?: ChannelConfig,
): ReleaseChannel {
  const cfg = config ?? getDefaultChannelConfig();

  // 1. Exact match in custom map
  if (cfg.custom) {
    if (Object.prototype.hasOwnProperty.call(cfg.custom, branch)) {
      return cfg.custom[branch] as ReleaseChannel;
    }

    // 2. Prefix match in custom map (longest matching prefix wins)
    let bestPrefix = '';
    let bestChannel: ReleaseChannel | undefined;
    for (const [key, channel] of Object.entries(cfg.custom)) {
      if (branch.startsWith(key) && key.length > bestPrefix.length) {
        bestPrefix = key;
        bestChannel = channel as ReleaseChannel;
      }
    }
    if (bestChannel !== undefined) {
      return bestChannel;
    }
  }

  // 3. Exact match against main branch → stable
  if (branch === cfg.main) {
    return 'latest';
  }

  // 4. Exact match against develop branch → beta
  if (branch === cfg.develop) {
    return 'beta';
  }

  // 5. Well-known prefixes and configured feature prefix → alpha
  const alphaPrefixes = ['feature/', 'hotfix/', 'release/'];
  if (cfg.feature && !alphaPrefixes.includes(cfg.feature)) {
    alphaPrefixes.push(cfg.feature);
  }
  for (const prefix of alphaPrefixes) {
    if (branch.startsWith(prefix)) {
      return 'alpha';
    }
  }

  // 6. Default fallback
  return 'alpha';
}

/**
 * Map a release channel to its npm dist-tag string.
 *
 * Kept as an explicit function (rather than a direct cast) so that callers
 * remain decoupled from the string values and the mapping can be extended
 * without changing call sites.
 */
export function channelToDistTag(channel: ReleaseChannel): string {
  const tags: Record<ReleaseChannel, string> = {
    latest: 'latest',
    beta: 'beta',
    alpha: 'alpha',
  };
  return tags[channel];
}

/**
 * Validate that a version string satisfies the pre-release conventions for
 * the given channel.
 *
 * Rules:
 * - 'latest': version must NOT contain '-' (no pre-release suffix)
 * - 'beta':   version must contain '-beta' or '-rc'
 * - 'alpha':  version must contain '-alpha', '-dev', '-rc', or '-beta'
 */
export function validateVersionChannel(
  version: string,
  channel: ReleaseChannel,
): ChannelValidationResult {
  switch (channel) {
    case 'latest': {
      if (version.includes('-')) {
        return {
          valid: false,
          expected: 'no pre-release suffix (e.g. 2026.3.16)',
          actual: version,
          message: `Version "${version}" has a pre-release suffix but channel is 'latest'. Stable releases must not include '-'.`,
        };
      }
      return { valid: true, message: 'ok' };
    }

    case 'beta': {
      const hasBetaOrRc = version.includes('-beta') || version.includes('-rc');
      if (!hasBetaOrRc) {
        return {
          valid: false,
          expected: 'pre-release suffix containing -beta or -rc (e.g. 2026.3.16-beta.1)',
          actual: version,
          message: `Version "${version}" does not contain '-beta' or '-rc' required for the 'beta' channel.`,
        };
      }
      return { valid: true, message: 'ok' };
    }

    case 'alpha': {
      const hasAlphaSuffix =
        version.includes('-alpha') ||
        version.includes('-dev') ||
        version.includes('-rc') ||
        version.includes('-beta');
      if (!hasAlphaSuffix) {
        return {
          valid: false,
          expected:
            'pre-release suffix containing -alpha, -dev, -rc, or -beta (e.g. 2026.3.16-alpha.1)',
          actual: version,
          message: `Version "${version}" does not contain a recognized pre-release suffix for the 'alpha' channel.`,
        };
      }
      return { valid: true, message: 'ok' };
    }
  }
}

/** Return a human-readable description of the given release channel. */
export function describeChannel(channel: ReleaseChannel): string {
  const descriptions: Record<ReleaseChannel, string> = {
    latest: 'stable release published to npm @latest',
    beta: 'pre-release published to npm @beta (develop branch)',
    alpha: 'early pre-release published to npm @alpha (feature/hotfix branches)',
  };
  return descriptions[channel];
}
