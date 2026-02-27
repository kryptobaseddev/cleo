/**
 * Session Resolver Middleware for CQRS Dispatch Layer.
 *
 * Runs FIRST in both MCP and CLI middleware pipelines.
 * Populates request.sessionId from the best available source:
 *
 *   1. request.sessionId already set (explicit)  -> use it
 *   2. getBoundSession() has context (MCP path)   -> stamp it
 *   3. process.env.CLEO_SESSION_ID (legacy/transitional) -> use it
 *   4. No session found -> leave undefined (OK for many operations)
 *
 * All downstream middleware (audit, enforcement) reads request.sessionId
 * directly instead of doing their own multi-tier fallback.
 *
 * @epic T4959
 */

import type { Middleware, DispatchRequest, DispatchNext, DispatchResponse } from '../types.js';
import { getBoundSession } from '../context/session-context.js';

/**
 * Creates the session resolver middleware.
 *
 * @param cliSessionLookup Optional async function that resolves the active
 *   session ID from SQLite for CLI commands. If not provided, the resolver
 *   falls through to env var / null.
 */
export function createSessionResolver(
  cliSessionLookup?: () => Promise<string | null>,
): Middleware {
  return async (req: DispatchRequest, next: DispatchNext): Promise<DispatchResponse> => {
    // Tier 1: Explicit — already populated by adapter
    if (req.sessionId) {
      return next();
    }

    // Tier 2: Process-scoped session context (MCP path)
    const bound = getBoundSession();
    if (bound) {
      req.sessionId = bound.sessionId;
      return next();
    }

    // Tier 3: CLI active session lookup (best-effort SQLite query)
    if (cliSessionLookup && req.source === 'cli') {
      try {
        const activeId = await cliSessionLookup();
        if (activeId) {
          req.sessionId = activeId;
          return next();
        }
      } catch {
        // Silent failure — many CLI commands don't need a session
      }
    }

    // Tier 4: Legacy env var (transitional — will be removed)
    const envGradeId = process.env.CLEO_SESSION_GRADE_ID;
    if (envGradeId && process.env.CLEO_SESSION_GRADE === 'true') {
      req.sessionId = envGradeId;
      return next();
    }
    const envId = process.env.CLEO_SESSION_ID;
    if (envId) {
      req.sessionId = envId;
      return next();
    }

    // Tier 5: No session — leave undefined
    return next();
  };
}
