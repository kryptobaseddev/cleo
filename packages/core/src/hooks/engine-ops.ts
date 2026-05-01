/**
 * Hooks Engine Operations — business logic layer.
 *
 * Contains all hook domain EngineResult wrappers migrated from
 * `packages/cleo/src/dispatch/engines/hooks-engine.ts` (ENG-MIG-12 / T1579).
 *
 * Queries providers by hook event support and analyzes hook capabilities
 * across the CAAMP provider ecosystem.
 *
 * Importable from `@cleocode/core/internal` so the CLI dispatch layer can
 * call them without any intermediate engine file.
 *
 * @module hooks/engine-ops
 * @task T1579 — ENG-MIG-12
 * @epic T1566
 */

import {
  buildHookMatrix,
  detectAllProviders,
  getCommonHookEvents,
  getHookMappingsVersion,
  getProviderSummary,
  getProvidersByHookEvent,
} from '@cleocode/caamp';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { type HookEvent, isProviderHookEvent } from './types.js';

// ---------------------------------------------------------------------------
// Internal types
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

/** Provider hook capability information (internal). */
interface ProviderHookInfo {
  id: string;
  name?: string;
  supportedHooks: string[];
}

// ---------------------------------------------------------------------------
// Query operations
// ---------------------------------------------------------------------------

/**
 * Query providers that support a specific hook event.
 *
 * Returns detailed provider information including which hooks each provider
 * supports, enabling intelligent routing and filtering of hook handlers.
 *
 * @param event - The hook event to query providers for
 * @returns Engine result with provider hook capability data
 * @task T1579 — ENG-MIG-12
 */
export async function queryHookProviders(
  event: HookEvent,
): Promise<EngineResult<{ event: HookEvent; providers: ProviderHookInfo[] }>> {
  if (!isProviderHookEvent(event)) {
    return engineSuccess({ event, providers: [] });
  }

  const providers = getProvidersByHookEvent(event);

  return engineSuccess({
    event,
    providers: (providers as unknown[]).map((p: unknown) => ({
      id: (p as { id: string }).id,
      name: (p as { name?: string }).name,
      supportedHooks:
        (
          p as { capabilities?: { hooks?: { supported?: string[] } } }
        ).capabilities?.hooks?.supported ?? [],
    })),
  });
}

/**
 * Get hook events common to specified providers.
 *
 * Analyzes which hook events are supported by all providers in the given list,
 * useful for determining the intersection of hook capabilities.
 *
 * @param providerIds - Optional array of provider IDs to analyze (uses all active if omitted)
 * @returns Engine result with common hook events
 * @task T1579 — ENG-MIG-12
 */
export async function queryCommonHooks(
  providerIds?: string[],
): Promise<EngineResult<{ providerIds?: string[]; commonEvents: string[] }>> {
  const commonEvents = getCommonHookEvents(providerIds) as string[];
  return engineSuccess({ providerIds, commonEvents });
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
 * @task T1579 — ENG-MIG-12
 */
export async function systemHooksMatrix(params?: {
  providerIds?: string[];
  detectProvider?: boolean;
}): Promise<EngineResult<HookMatrixResult>> {
  try {
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
    const summary: ProviderMatrixEntry[] = (raw.providers as string[]).map(
      (providerId: string) => {
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
        const supported = (raw.events as string[]).filter(
          (ev: string) => boolMatrix[ev]?.[providerId] === true,
        );
        const unsupported = (raw.events as string[]).filter(
          (ev: string) => boolMatrix[ev]?.[providerId] !== true,
        );
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
      },
    );

    // Detect current provider if requested (default: true)
    let detectedProvider: string | null = null;
    if (params?.detectProvider !== false) {
      try {
        const detectionResults = detectAllProviders() as Array<{
          installed: boolean;
          projectDetected: boolean;
          provider: { id: string };
        }>;
        const detected = detectionResults.find((r) => r.installed && r.projectDetected);
        if (detected) {
          detectedProvider = detected.provider.id;
        } else {
          const anyInstalled = detectionResults.find((r) => r.installed);
          if (anyInstalled) {
            detectedProvider = anyInstalled.provider.id;
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
