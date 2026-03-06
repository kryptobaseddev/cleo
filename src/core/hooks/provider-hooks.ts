/**
 * Provider Hook Capabilities - Phase 2C of T5237
 *
 * Helper functions for querying which providers support which hook events.
 * Wraps CAAMP's provider discovery functions with CLEO-specific helpers.
 *
 * @module @cleocode/cleo/hooks/provider-hooks
 */

import {
  getProvidersByHookEvent,
  getCommonHookEvents,
  type HookEvent as CAAMPHookEvent,
} from '@cleocode/caamp';
import { type HookEvent, isProviderHookEvent } from './types.js';

/**
 * Get all providers that support a specific hook event
 *
 * @param event - The hook event to query
 * @returns Array of provider IDs that support this event
 */
export function getHookCapableProviders(event: HookEvent): string[] {
  if (!isProviderHookEvent(event)) {
    return [];
  }
  const providers = getProvidersByHookEvent(event);
  return providers.map((p) => p.id);
}

/**
 * Get hook events supported by all specified providers
 *
 * @param providerIds - Optional array of provider IDs (uses all active providers if omitted)
 * @returns Array of hook events supported by all specified providers
 */
export function getSharedHookEvents(providerIds?: string[]): CAAMPHookEvent[] {
  return getCommonHookEvents(providerIds);
}

export { getProvidersByHookEvent, getCommonHookEvents };
export type { CAAMPHookEvent as ProviderHookEvent, HookEvent };
