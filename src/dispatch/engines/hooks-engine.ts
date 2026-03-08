/**
 * Hooks Engine - Phase 2C of T5237
 *
 * Dispatch engine for hook-related operations. Queries providers by hook
 * event support and analyzes hook capabilities across the CAAMP provider ecosystem.
 *
 * @module src/dispatch/engines/hooks-engine
 * @epic T5237
 */

import type { HookEvent, ProviderHookEvent } from '../../core/hooks/types.js';
import { isProviderHookEvent } from '../../core/hooks/types.js';
import { type EngineResult, engineSuccess } from './_error.js';

/**
 * Provider hook capability information
 */
interface ProviderHookInfo {
  id: string;
  name?: string;
  supportedHooks: ProviderHookEvent[];
}

/**
 * Query providers that support a specific hook event
 *
 * Returns detailed provider information including which hooks each provider
 * supports, enabling intelligent routing and filtering of hook handlers.
 *
 * @param event - The hook event to query providers for
 * @returns Engine result with provider hook capability data
 */
export async function queryHookProviders(
  event: HookEvent,
): Promise<EngineResult<{ event: HookEvent; providers: ProviderHookInfo[] }>> {
  if (!isProviderHookEvent(event)) {
    return engineSuccess({
      event,
      providers: [],
    });
  }

  const { getProvidersByHookEvent } = await import('@cleocode/caamp');
  const providers = getProvidersByHookEvent(event);

  return engineSuccess({
    event,
    providers: providers.map((p) => ({
      id: (p as { id: string }).id,
      name: (p as { name?: string }).name,
      supportedHooks:
        (p as { capabilities?: { hooks?: { supported?: ProviderHookEvent[] } } }).capabilities
          ?.hooks?.supported ?? [],
    })),
  });
}

/**
 * Get hook events common to specified providers
 *
 * Analyzes which hook events are supported by all providers in the given list,
 * useful for determining the intersection of hook capabilities.
 *
 * @param providerIds - Optional array of provider IDs to analyze (uses all active if omitted)
 * @returns Engine result with common hook events
 */
export async function queryCommonHooks(
  providerIds?: string[],
): Promise<EngineResult<{ providerIds?: string[]; commonEvents: ProviderHookEvent[] }>> {
  const { getCommonHookEvents } = await import('@cleocode/caamp');
  const commonEvents = getCommonHookEvents(providerIds);

  return engineSuccess({
    providerIds,
    commonEvents,
  });
}
