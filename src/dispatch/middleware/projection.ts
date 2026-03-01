/**
 * MVI projection middleware.
 * Reads _mviTier from request params and filters response fields accordingly.
 * If the domain is not allowed at the resolved tier, short-circuits with an error.
 *
 * @epic T4820
 * @task T5096
 */

import type { Middleware, DispatchRequest, DispatchResponse } from '../types.js';
import { resolveTier, PROJECTIONS, type MviTier, type ProjectionConfig } from '../lib/projections.js';
import { getBoundSession } from '../context/session-context.js';

export interface ProjectionContext {
  tier: MviTier;
  config: ProjectionConfig;
}

/**
 * Check if a domain is allowed at the given tier.
 */
export function isOperationAllowed(domain: string, tier: MviTier): boolean {
  return PROJECTIONS[tier].allowedDomains.includes(domain);
}

/**
 * Recursively prune data beyond maxDepth.
 * At maxDepth, objects become '[Object]' and arrays become '[Array(N)]'.
 */
function pruneDepth(data: unknown, maxDepth: number, currentDepth: number = 0): unknown {
  // Primitives pass through at any depth
  if (data === null || data === undefined || typeof data !== 'object') {
    return data;
  }

  // At max depth, replace with placeholder
  if (currentDepth >= maxDepth) {
    if (Array.isArray(data)) {
      return `[Array(${data.length})]`;
    }
    return '[Object]';
  }

  // Recurse into arrays
  if (Array.isArray(data)) {
    return data.map(item => pruneDepth(item, maxDepth, currentDepth + 1));
  }

  // Recurse into objects
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    result[key] = pruneDepth(value, maxDepth, currentDepth + 1);
  }
  return result;
}

/**
 * Apply field projection to a result object.
 * Removes fields that are excluded at the given tier and prunes depth.
 */
export function applyProjection<T>(data: T, config: ProjectionConfig): T {
  if (!data || typeof data !== 'object') return data;

  let result: unknown = data;

  // Apply field exclusions
  if (config.excludeFields?.length) {
    const obj = { ...data } as Record<string, unknown>;
    for (const field of config.excludeFields) {
      const parts = field.split('.');
      if (parts.length === 1) {
        delete obj[parts[0]];
      } else {
        // Handle nested fields like 'metadata._internal'
        let current: Record<string, unknown> | undefined = obj;
        for (let i = 0; i < parts.length - 1; i++) {
          const val = current?.[parts[i]];
          if (val && typeof val === 'object') {
            current[parts[i]] = { ...val as Record<string, unknown> };
            current = current[parts[i]] as Record<string, unknown>;
          } else {
            current = undefined;
            break;
          }
        }
        if (current) {
          delete current[parts[parts.length - 1]];
        }
      }
    }
    result = obj;
  }

  // Apply depth pruning
  if (config.maxDepth !== undefined) {
    result = pruneDepth(result, config.maxDepth);
  }

  return result as T;
}

/**
 * Create projection context from request params.
 */
export function createProjectionContext(params?: Record<string, unknown>): ProjectionContext {
  const tier = resolveTier(params);
  return { tier, config: PROJECTIONS[tier] };
}

/**
 * Create the MVI projection middleware.
 *
 * Extracts _mviTier from params, checks domain access, and applies
 * field exclusions to the response.
 */
export function createProjectionMiddleware(): Middleware {
  return async (req: DispatchRequest, next: () => Promise<DispatchResponse>): Promise<DispatchResponse> => {
    const session = getBoundSession();
    const tier = resolveTier(req.params, session?.scope ?? null);
    const config = PROJECTIONS[tier];

    // Remove control param so domain handlers don't see it
    if (req.params) {
      delete req.params['_mviTier'];
    }

    // MCP smart defaults: tasks.list defaults to compact mode
    if (req.source === 'mcp' && req.domain === 'tasks' && req.operation === 'list') {
      if (req.params && req.params['compact'] === undefined) {
        req.params['compact'] = true;
      }
    }

    // Check domain access at this tier
    if (!config.allowedDomains.includes(req.domain)) {
      return {
        _meta: {
          gateway: req.gateway,
          domain: req.domain,
          operation: req.operation,
          version: '1.0.0',
          timestamp: new Date().toISOString(),
          duration_ms: 0,
          source: req.source,
          requestId: req.requestId,
        },
        success: false,
        error: {
          code: 'E_INVALID_OPERATION',
          exitCode: 2,
          message: `Operation not available at '${tier}' tier. Domain '${req.domain}' requires a higher tier.`,
        },
      };
    }

    const response = await next();

    // Apply field exclusions to successful responses
    if (response.success && response.data !== undefined) {
      response.data = applyProjection(response.data, config);
    }

    return response;
  };
}
