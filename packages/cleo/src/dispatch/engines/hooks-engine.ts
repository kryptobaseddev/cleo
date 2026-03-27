/**
 * Hooks Engine - Phase 2C of T5237
 *
 * Dispatch engine for hook-related operations. Queries providers by hook
 * event support and analyzes hook capabilities across the CAAMP provider ecosystem.
 *
 * @module src/dispatch/engines/hooks-engine
 * @epic T5237
 * @task T167
 */

import {
  type HookEvent,
  isProviderHookEvent,
  type ProviderHookEvent,
} from '@cleocode/core/internal';
import { type EngineResult, engineError, engineSuccess } from './_error.js';

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
  const commonEvents = getCommonHookEvents(providerIds) as ProviderHookEvent[];

  return engineSuccess({
    providerIds,
    commonEvents,
  });
}

// ---------------------------------------------------------------------------
// Hook matrix result types (T167)
// ---------------------------------------------------------------------------

/** Coverage summary for a single provider in the hook matrix. */
export interface ProviderMatrixEntry {
  /** CAAMP provider identifier (e.g. "claude-code"). */
  providerId: string;
  /** Number of canonical events this provider supports. */
  supportedCount: number;
  /** Total canonical events in the taxonomy. */
  totalCanonical: number;
  /** Coverage percentage (0-100, integer). */
  coverage: number;
  /** Canonical events supported by this provider. */
  supported: string[];
  /** Canonical events not supported by this provider. */
  unsupported: string[];
}

/** Full hook matrix result. */
export interface HookMatrixResult {
  /** CAAMP hook mappings version. */
  caampVersion: string;
  /** All canonical event names (rows). */
  events: string[];
  /** Provider IDs included in the matrix (columns). */
  providers: string[];
  /**
   * Two-dimensional matrix: event name → provider ID → support flag.
   * `true` means the provider natively supports the canonical event.
   */
  matrix: Record<string, Record<string, boolean>>;
  /** Per-provider summary with coverage stats. */
  summary: ProviderMatrixEntry[];
  /** Provider ID detected as the current runtime, or null. */
  detectedProvider: string | null;
}

/**
 * Build a cross-provider hook support matrix using CAAMP APIs.
 *
 * Calls `buildHookMatrix()` to assemble the two-dimensional grid, then
 * augments each provider row with `getProviderSummary()` coverage stats.
 * Optionally runs `detectAllProviders()` to surface the active runtime.
 *
 * @param params - Optional filter/detection options
 * @returns Engine result with the full hook matrix
 * @task T167
 */
export async function systemHooksMatrix(params?: {
  providerIds?: string[];
  detectProvider?: boolean;
}): Promise<EngineResult<HookMatrixResult>> {
  try {
    const { buildHookMatrix, getProviderSummary, getHookMappingsVersion, detectAllProviders } =
      await import('@cleocode/caamp');

    const caampVersion = getHookMappingsVersion();
    const raw = buildHookMatrix(params?.providerIds);

    // Flatten the matrix to boolean supported flags
    const boolMatrix: Record<string, Record<string, boolean>> = {};
    for (const event of raw.events) {
      boolMatrix[event] = {};
      for (const providerId of raw.providers) {
        const mapping = raw.matrix[event]?.[providerId];
        boolMatrix[event]![providerId] = mapping?.supported ?? false;
      }
    }

    // Build per-provider summary
    const summary: ProviderMatrixEntry[] = raw.providers.map((providerId) => {
      const provSummary = getProviderSummary(providerId);
      if (provSummary) {
        return {
          providerId,
          supportedCount: provSummary.supportedCount,
          totalCanonical: provSummary.totalCanonical,
          coverage: provSummary.coverage,
          supported: provSummary.supported as string[],
          unsupported: provSummary.unsupported as string[],
        };
      }
      // Derive from matrix if no summary profile available
      const supported = raw.events.filter((ev) => boolMatrix[ev]?.[providerId] === true);
      const unsupported = raw.events.filter((ev) => boolMatrix[ev]?.[providerId] !== true);
      const totalCanonical = raw.events.length;
      const coverage =
        totalCanonical > 0 ? Math.round((supported.length / totalCanonical) * 100) : 0;
      return {
        providerId,
        supportedCount: supported.length,
        totalCanonical,
        coverage,
        supported,
        unsupported,
      };
    });

    // Detect current provider if requested (default: true)
    let detectedProvider: string | null = null;
    const shouldDetect = params?.detectProvider !== false;
    if (shouldDetect) {
      try {
        const detectionResults = detectAllProviders();
        const detected = detectionResults.find((r) => r.installed && r.projectDetected);
        if (detected) {
          detectedProvider = (detected.provider as { id: string }).id;
        } else {
          const anyInstalled = detectionResults.find((r) => r.installed);
          if (anyInstalled) {
            detectedProvider = (anyInstalled.provider as { id: string }).id;
          }
        }
      } catch {
        // Detection is best-effort; leave detectedProvider null
      }
    }

    return engineSuccess({
      caampVersion,
      events: raw.events as string[],
      providers: raw.providers,
      matrix: boolMatrix,
      summary,
      detectedProvider,
    });
  } catch (err: unknown) {
    return engineError<HookMatrixResult>('E_GENERAL', (err as Error).message);
  }
}
