/**
 * Process-scoped session context for the MCP server.
 *
 * Each Claude Code conversation spawns its own MCP process, so 5 concurrent
 * agents = 5 isolated SessionContext instances with zero shared state.
 * This replaces the fragile process.env.CLEO_SESSION_ID mechanism.
 *
 * @epic T4959
 */

/**
 * Immutable snapshot of the bound session context.
 */
export interface SessionContext {
  /** Active session ID. */
  sessionId: string;
  /** Session scope. */
  scope: { type: string; epicId?: string };
  /** Whether full audit logging is enabled for behavioral grading. */
  gradeMode: boolean;
  /** PID of the process that bound this context. */
  agentPid: number;
  /** ISO timestamp when this context was bound. */
  boundAt: string;
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let _context: SessionContext | null = null;

/**
 * Bind a session to the current process.
 * Called by session.start mutation handler after successful session creation.
 *
 * @throws if a session is already bound (call unbindSession first).
 */
export function bindSession(ctx: Omit<SessionContext, 'agentPid' | 'boundAt'>): SessionContext {
  if (_context) {
    throw new Error(
      `Session already bound: ${_context.sessionId}. ` +
      `Call unbindSession() before binding a new session.`,
    );
  }
  _context = {
    ...ctx,
    agentPid: process.pid,
    boundAt: new Date().toISOString(),
  };
  return _context;
}

/**
 * Get the currently bound session context, or null if none is bound.
 */
export function getBoundSession(): SessionContext | null {
  return _context;
}

/**
 * Check whether a session is currently bound.
 */
export function hasSession(): boolean {
  return _context !== null;
}

/**
 * Unbind the current session context.
 * Called by session.end mutation handler.
 *
 * @returns The unbound context, or null if nothing was bound.
 */
export function unbindSession(): SessionContext | null {
  const prev = _context;
  _context = null;
  return prev;
}

/**
 * Reset the session context (for testing only).
 */
export function resetSessionContext(): void {
  _context = null;
}
