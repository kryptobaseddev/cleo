/**
 * MVI (Minimum Viable Information) projection configurations.
 * Maps disclosure tiers to operation access and field filtering rules.
 *
 * @epic T4820
 * @task T5096
 */

export type MviTier = 'minimal' | 'standard' | 'orchestrator';

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
    allowedDomains: ['tasks', 'session', 'admin', 'memory', 'check', 'pipeline', 'tools', 'validate'],
    excludeFields: ['metadata._internal', 'auditLog'],
    maxDepth: 4,
  },
  orchestrator: {
    allowedDomains: [
      'tasks', 'session', 'admin', 'memory', 'check', 'pipeline',
      'orchestrate', 'tools', 'sharing', 'nexus', 'validate',
      'lifecycle', 'release', 'system',
    ],
    maxDepth: 8,
  },
};

/** Valid MVI tier values for runtime checking. */
const VALID_TIERS = new Set<string>(['minimal', 'standard', 'orchestrator']);

/** Resolve tier from request params, defaulting to 'standard'. */
export function resolveTier(params?: Record<string, unknown>): MviTier {
  const mvi = params?._mviTier;
  if (typeof mvi === 'string' && VALID_TIERS.has(mvi)) return mvi as MviTier;
  return 'standard';
}
