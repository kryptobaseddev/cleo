/**
 * CAAMP Capability Checking
 *
 * Dynamic capability checking for providers using providerSupports
 * and providerSupportsById from @cleocode/caamp.
 *
 * @module
 */

import { type Provider, providerSupports, providerSupportsById } from '@cleocode/caamp';

/**
 * Check if provider supports a specific capability
 * @param provider - Provider object or ID
 * @param capabilityPath - Dot notation path (e.g., 'spawn.supportsSubagents')
 * @returns boolean
 *
 * Examples:
 * - providerSupports(provider, 'spawn.supportsSubagents')
 * - providerSupports(provider, 'hooks.supported')
 * - providerSupportsById('claude-code', 'spawn.supportsParallelSpawn')
 * - providerSupportsById('gemini-cli', 'skills.precedence')
 */

export function checkProviderCapability(
  provider: Provider | string,
  capabilityPath: string,
): boolean {
  if (typeof provider === 'string') {
    return providerSupportsById(provider, capabilityPath);
  }
  return providerSupports(provider, capabilityPath);
}

/**
 * Check multiple capabilities at once
 */
export function checkProviderCapabilities(
  providerId: string,
  capabilities: string[],
): Record<string, boolean> {
  const results: Record<string, boolean> = {};
  for (const cap of capabilities) {
    results[cap] = providerSupportsById(providerId, cap);
  }
  return results;
}
