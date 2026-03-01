/**
 * Lightweight session discovery — returns minimal session records.
 *
 * Unlike listSessions() which returns full Session objects, findSessions()
 * returns only the fields agents need for discovery: id, name, status,
 * startedAt, and scope.
 *
 * @task T5119
 */

import type { Session, SessionScope } from '../../types/session.js';
import type { DataAccessor } from '../../store/data-accessor.js';

/** Minimal session record returned by findSessions(). */
export interface MinimalSessionRecord {
  id: string;
  name: string;
  status: string;
  startedAt: string;
  scope: SessionScope;
}

/** Parameters for findSessions(). */
export interface FindSessionsParams {
  status?: string;
  scope?: string;
  query?: string;
  limit?: number;
}

/**
 * Find sessions with minimal field projection.
 *
 * Loads all sessions, applies filters, then projects to minimal fields.
 * This is cheaper for agents that only need discovery-level data.
 *
 * @param accessor - DataAccessor for loading sessions
 * @param params - Optional filters (status, scope, query, limit)
 * @returns Array of minimal session records
 */
export async function findSessions(
  accessor: DataAccessor,
  params?: FindSessionsParams,
): Promise<MinimalSessionRecord[]> {
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
      (s) =>
        s.id.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q),
    );
  }

  // Sort by start time, most recent first
  sessions.sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );

  // Apply limit
  if (params?.limit && params.limit > 0) {
    sessions = sessions.slice(0, params.limit);
  }

  // Project to minimal fields
  return sessions.map(toMinimal);
}

/** Project a full Session to a MinimalSessionRecord. */
function toMinimal(s: Session): MinimalSessionRecord {
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    startedAt: s.startedAt,
    scope: s.scope,
  };
}
