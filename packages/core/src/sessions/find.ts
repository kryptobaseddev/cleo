/**
 * Lightweight session discovery — returns minimal session records.
 *
 * Unlike listSessions() which returns full Session objects, findSessions()
 * returns only the fields agents need for discovery: id, name, status,
 * startedAt, and scope.
 *
 * @task T5119
 * @task T1450 — normalized (projectRoot, params) signature
 */

import type { Session, SessionFindParams, SessionScope } from '@cleocode/contracts';
import type { NextDirectives } from '../mvi-helpers.js';
import { sessionListItemNext } from '../mvi-helpers.js';
import { getAccessor } from '../store/data-accessor.js';

/** Minimal session record returned by findSessions(). */
export interface MinimalSessionRecord {
  id: string;
  name: string;
  status: string;
  startedAt: string;
  scope: SessionScope;
  /** Progressive disclosure directives for follow-up operations. */
  _next?: NextDirectives;
}

/**
 * @deprecated Use SessionFindParams from @cleocode/contracts instead.
 * Kept for backward compatibility with engine/cleo.ts callers.
 */
export type FindSessionsParams = SessionFindParams;

/**
 * Find sessions with minimal field projection.
 * Normalized Core signature: (projectRoot, params) → Result.
 *
 * @param projectRoot - Absolute path to the project root
 * @param params - Optional filters (status, scope, query, limit)
 * @returns Array of minimal session records
 * @task T1450
 */
export async function findSessions(
  projectRoot: string,
  params?: SessionFindParams,
): Promise<MinimalSessionRecord[]> {
  const accessor = await getAccessor(projectRoot);
  let sessions: Session[] = await accessor.loadSessions();

  // Filter by status
  if (params?.status) {
    sessions = sessions.filter((s) => s.status === params.status);
  }

  // Filter by scope string (e.g. "epic:T001" or "global")
  if (params?.scope) {
    const scopeParts = params.scope.split(':');
    const scopeType = scopeParts[0];
    const scopeId = scopeParts[1];

    sessions = sessions.filter((s) => {
      if (s.scope.type !== scopeType) return false;
      if (scopeId && s.scope.rootTaskId !== scopeId && s.scope.epicId !== scopeId) return false;
      return true;
    });
  }

  // Filter by query (fuzzy match on name or id)
  if (params?.query) {
    const q = params.query.toLowerCase();
    sessions = sessions.filter(
      (s) => s.id.toLowerCase().includes(q) || s.name.toLowerCase().includes(q),
    );
  }

  // Sort by start time, most recent first
  sessions.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

  // Apply limit
  if (params?.limit && params.limit > 0) {
    sessions = sessions.slice(0, params.limit);
  }

  // Project to minimal fields
  return sessions.map(toMinimal);
}

/** Project a full Session to a MinimalSessionRecord with _next directives. */
function toMinimal(s: Session): MinimalSessionRecord {
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    startedAt: s.startedAt,
    scope: s.scope,
    _next: sessionListItemNext(s.id),
  };
}
