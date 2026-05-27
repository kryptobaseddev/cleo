/**
 * MVI (Minimum Viable Information) projection configurations.
 * Maps disclosure tiers to operation access and field filtering rules.
 *
 * @epic T4820
 * @task T5096
 */

/**
 * Disclosure tier level for MVI (Minimum Viable Information) filtering.
 *
 * @remarks
 * Controls how much data is exposed in dispatch responses:
 * - `minimal`: Only tasks, session, and admin domains; shallow depth
 * - `standard`: Adds memory, check, pipeline, tools, sticky; medium depth
 * - `orchestrator`: Full access including orchestrate and nexus; deep nesting
 */
export type MviTier = 'minimal' | 'standard' | 'orchestrator';

/**
 * Configuration for a single MVI projection tier.
 *
 * @remarks
 * Defines which domains are accessible, which fields to strip, and how
 * deep nested objects may be traversed in responses at a given tier.
 */
export interface ProjectionConfig {
  /** Operations allowed at this tier */
  allowedDomains: string[];
  /** Fields to exclude from responses */
  excludeFields?: string[];
  /** Maximum depth for nested objects */
  maxDepth?: number;
}

export const PROJECTIONS: Record<MviTier, ProjectionConfig> = {
  minimal: {
    allowedDomains: ['tasks', 'session', 'admin'],
    excludeFields: ['notes', 'history', 'metadata._internal', 'auditLog'],
    maxDepth: 2,
  },
  standard: {
    allowedDomains: ['tasks', 'session', 'admin', 'memory', 'check', 'pipeline', 'tools', 'sticky'],
    excludeFields: ['metadata._internal', 'auditLog'],
    maxDepth: 4,
  },
  orchestrator: {
    allowedDomains: [
      'tasks',
      'session',
      'admin',
      'memory',
      'check',
      'pipeline',
      'orchestrate',
      'tools',
      'nexus',
      'sticky',
    ],
    maxDepth: 8,
  },
};

/** Valid MVI tier values for runtime checking. */
const VALID_TIERS = new Set<string>(['minimal', 'standard', 'orchestrator']);

/**
 * Resolve tier from request params, defaulting to 'standard'.
 *
 * @remarks
 * Priority: explicit `_mviTier` param wins, then epic scope auto-maps
 * to orchestrator, otherwise standard is returned.
 *
 * @param params - Request params that may contain a `_mviTier` field
 * @param sessionScope - Current session scope for auto-tier detection
 * @returns The resolved MVI tier
 *
 * @example
 * ```typescript
 * import { resolveTier } from './projections.js';
 *
 * const tier = resolveTier(req.params, currentSession?.scope);
 * ```
 */
export function resolveTier(
  params?: Record<string, unknown>,
  sessionScope?: { type: string; epicId?: string } | null,
): MviTier {
  // Explicit param always wins
  const mvi = params?._mviTier;
  if (typeof mvi === 'string' && VALID_TIERS.has(mvi)) return mvi as MviTier;
  // Auto-map epic scope to orchestrator tier
  if (sessionScope?.type === 'epic') return 'orchestrator';
  return 'standard';
}
