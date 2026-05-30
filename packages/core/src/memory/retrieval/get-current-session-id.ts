/**
 * Get the CALLER's current session ID, env-first (T11344 · Epic T11284).
 *
 * Best-effort: returns undefined when no session can be resolved or the store
 * is unavailable. Used by logRetrieval to group memory retrievals by session.
 *
 * T11344 — routes through the canonical `resolveCurrentSessionId` (env-first)
 * instead of `sessionStatus` (most-recent active row). This is the memory
 * scope-leakage fix: a spawned agent's memory retrievals are now grouped under
 * ITS `CLEO_SESSION_ID`, not under whichever session last touched the DB.
 *
 * @param projectRoot - Project root directory
 * @returns Current session ID or undefined if unavailable
 * @task T11344
 */
export async function getCurrentSessionId(projectRoot: string): Promise<string | undefined> {
  try {
    const { resolveCurrentSessionId } = await import('../../store/session-store.js');
    const id = await resolveCurrentSessionId(projectRoot);
    return id ?? undefined;
  } catch {
    return undefined;
  }
}
