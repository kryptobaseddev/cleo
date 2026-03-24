/**
 * Provider Hook Capabilities - Phase 2C of T5237
 *
 * Helper functions for querying which providers support which hook events.
 * Wraps CAAMP's provider discovery and normalizer functions with CLEO-specific helpers.
 *
 * Updated for CAAMP 1.9.1: uses CanonicalHookEvent and toNative/toCanonical normalizers.
 *
 * @module @cleocode/cleo/hooks/provider-hooks
 */

import {
  type CanonicalHookEvent,
  getCommonHookEvents,
  getProvidersByHookEvent,
  supportsHook,
  toCanonical,
  toNative,
} from '@cleocode/caamp';
import { type HookEvent, isProviderHookEvent } from './types.js';

/**
 * Get all providers that support a specific hook event
 *
 * @param event - The hook event to query (canonical or internal)
 * @returns Array of provider IDs that support this event
 */
export function getHookCapableProviders(event: HookEvent): string[] {
  if (!isProviderHookEvent(event)) {
    return [];
  }
  const providers = getProvidersByHookEvent(event as CanonicalHookEvent);
  return providers.map((p) => p.id);
}

/**
 * Get hook events supported by all specified providers
 *
 * @param providerIds - Optional array of provider IDs (uses all active providers if omitted)
 * @returns Array of canonical hook events supported by all specified providers
 */
export function getSharedHookEvents(providerIds?: string[]): CanonicalHookEvent[] {
  return getCommonHookEvents(providerIds) as CanonicalHookEvent[];
}

/**
 * Translate a canonical hook event to a provider-native event name.
 *
 * @param event - The canonical CAAMP event name
 * @param providerId - The provider to translate for
 * @returns The native event name, or null if the provider doesn't support it
 */
export function toNativeHookEvent(event: CanonicalHookEvent, providerId: string): string | null {
  return toNative(event, providerId);
}

/**
 * Translate a provider-native event name back to its canonical equivalent.
 *
 * @param nativeEvent - The provider-specific event name
 * @param providerId - The provider this event belongs to
 * @returns The canonical event name, or null if no mapping exists
 */
export function toCanonicalHookEvent(
  nativeEvent: string,
  providerId: string,
): CanonicalHookEvent | null {
  return toCanonical(nativeEvent, providerId);
}

/**
 * Check if a provider supports a specific canonical hook event.
 *
 * @param event - The canonical event name
 * @param providerId - The provider to check
 * @returns True if the provider supports this event
 */
export function providerSupportsHookEvent(event: CanonicalHookEvent, providerId: string): boolean {
  return supportsHook(event, providerId);
}

export type { CanonicalHookEvent as ProviderHookEvent, HookEvent };
export { getCommonHookEvents, getProvidersByHookEvent, supportsHook, toCanonical, toNative };
