/**
 * Process-scoped session context for the CLEO dispatch layer.
 *
 * Each Claude Code conversation spawns its own process, so 5 concurrent
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
  /**
   * Active CANT agent peer ID for Wave 2 memory isolation (T1086).
   *
   * Resolved at session-bind time from the CLEO_AGENT_PEER_ID environment
   * variable (set by the orchestrator spawn shim) or from the currently-loaded
   * CANT agent discovered via native-loader.ts.
   *
   * Defaults to `"global"` when no CANT agent is active, which means all
   * memory writes are shared across all peers — the pre-Wave-2 behavior.
   *
   * Domain handlers read this via {@link getActivePeerId} and pass it through
   * to brain-retrieval / brain-search as the `peerId` filter parameter.
   */
  activePeerId: string;
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let _context: SessionContext | null = null;

// ---------------------------------------------------------------------------
// Peer ID resolution (T1086)
// ---------------------------------------------------------------------------

/**
 * The fallback peer ID used when no CANT agent is active.
 *
 * All legacy (pre-Wave-2) memory entries carry this value, and any agent
 * that does not declare an explicit peer ID writes to the global pool.
 */
export const GLOBAL_PEER_ID = 'global';

/**
 * Resolve the active CANT peer ID for the current process.
 *
 * Resolution order (first match wins):
 * 1. `CLEO_AGENT_PEER_ID` environment variable — set by the orchestrator
 *    spawn shim when launching a sub-agent.
 * 2. `CLEO_AGENT_ID` environment variable — legacy / manual override.
 * 3. Falls back to `"global"` (backward-compatible, no isolation).
 *
 * This function is intentionally synchronous and pure — it never reads
 * the filesystem or native-loader at call time so the dispatch hot path
 * is not blocked by I/O. A future Wave 8 enhancement may wire the
 * native-loader registry here for richer CANT-DSL-level resolution.
 *
 * @returns Resolved peer ID string (never empty, never undefined).
 */
export function resolveActivePeerId(): string {
  const envPeerId = process.env['CLEO_AGENT_PEER_ID'] ?? process.env['CLEO_AGENT_ID'] ?? null;
  if (envPeerId && envPeerId.trim().length > 0) {
    return envPeerId.trim();
  }
  return GLOBAL_PEER_ID;
}

/**
 * Get the active peer ID from the bound session context, or resolve it
 * directly when no session is bound (e.g. one-shot CLI invocations).
 *
 * Callers in domain handlers SHOULD prefer this over reading the context
 * directly — it handles the no-session edge case gracefully.
 *
 * @returns Active peer ID string (never empty).
 */
export function getActivePeerId(): string {
  return _context?.activePeerId ?? resolveActivePeerId();
}

/**
 * Bind a session to the current process.
 * Called by session.start mutation handler after successful session creation.
 *
 * Resolves {@link SessionContext.activePeerId} from the environment at bind
 * time so all subsequent domain handler calls in this process use a stable
 * peer ID for the entire session lifetime.
 *
 * @throws if a session is already bound (call unbindSession first).
 */
export function bindSession(
  ctx: Omit<SessionContext, 'agentPid' | 'boundAt' | 'activePeerId'> & {
    activePeerId?: string;
  },
): SessionContext {
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
    activePeerId: ctx.activePeerId ?? resolveActivePeerId(),
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
