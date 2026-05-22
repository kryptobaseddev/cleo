/**
 * Get the current active session ID from the session manager.
 *
 * Best-effort: returns undefined when no session is active or the session
 * manager is unavailable. Used by logRetrieval to group retrievals by session.
 *
 * @param projectRoot - Project root directory
 * @returns Current session ID or undefined if unavailable
 */
export async function getCurrentSessionId(projectRoot: string): Promise<string | undefined> {
  try {
    const { sessionStatus } = await import('../../sessions/index.js');
    const session = await sessionStatus(projectRoot, {});
    return session?.id;
  } catch {
    return undefined;
  }
}
