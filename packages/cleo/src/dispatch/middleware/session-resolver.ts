/**
 * Session Resolver Middleware for CQRS Dispatch Layer.
 *
 * Runs FIRST in the CLI middleware pipeline.
 * Populates request.sessionId and session-lineage fields from the best available source:
 *
 *   1. request.sessionId already set (explicit)  -> use it
 *   2. getBoundSession() has context              -> stamp it
 *   3. process.env.CLEO_SESSION_ID (legacy/transitional) -> use it
 *   4. No session found -> leave undefined (OK for many operations)
 *
 * All downstream middleware (audit, enforcement) reads request.sessionId
 * directly instead of doing their own multi-tier fallback.
 *
 * @epic T4959
 */

import { randomUUID } from 'node:crypto';
import { getBoundSession } from '../context/session-context.js';
import type { DispatchNext, DispatchRequest, DispatchResponse, Middleware } from '../types.js';

function resolveOriginSessionId(
  sessionId?: string,
  executionSessionId?: string,
): string | undefined {
  return (
    process.env.CLEO_ORIGIN_SESSION_ID ??
    process.env.CLEO_SESSION_ORIGIN_ID ??
    sessionId ??
    executionSessionId
  );
}

function resolveExecutionSessionId(): string {
  return (
    process.env.CLEO_EXECUTION_SESSION_ID ?? process.env.CLEO_SESSION_EXECUTION_ID ?? randomUUID()
  );
}

/**
 * Creates the session resolver middleware.
 *
 * @param cliSessionLookup Optional async function that resolves the active
 *   session ID from SQLite for CLI commands. If not provided, the resolver
 *   falls through to env var / null.
 */
export function createSessionResolver(cliSessionLookup?: () => Promise<string | null>): Middleware {
  return async (req: DispatchRequest, next: DispatchNext): Promise<DispatchResponse> => {
    if (!req.executionSessionId) {
      req.executionSessionId = resolveExecutionSessionId();
    }

    // Tier 1: Explicit — already populated by adapter
    if (req.sessionId) {
      req.originSessionId ??= resolveOriginSessionId(req.sessionId, req.executionSessionId);
      return next();
    }

    // Tier 2: Process-scoped session context
    const bound = getBoundSession();
    if (bound) {
      req.sessionId = bound.sessionId;
      req.originSessionId ??= resolveOriginSessionId(req.sessionId, req.executionSessionId);
      return next();
    }

    // Tier 3: CLI active session lookup (best-effort SQLite query)
    if (cliSessionLookup && req.source === 'cli') {
      try {
        const activeId = await cliSessionLookup();
        if (activeId) {
          req.sessionId = activeId;
          req.originSessionId ??= resolveOriginSessionId(req.sessionId, req.executionSessionId);
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
      req.originSessionId ??= resolveOriginSessionId(req.sessionId, req.executionSessionId);
      return next();
    }
    const envId = process.env.CLEO_SESSION_ID;
    if (envId) {
      req.sessionId = envId;
      req.originSessionId ??= resolveOriginSessionId(req.sessionId, req.executionSessionId);
      return next();
    }

    // Tier 5: No session — leave undefined
    req.originSessionId ??= resolveOriginSessionId(req.sessionId, req.executionSessionId);
    return next();
  };
}
