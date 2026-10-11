/**
 * Keep the invoking session's task claims alive while a governed heavy run
 * waits for the machine budget (T13492, axiom T1796).
 *
 * A claim lease (30 min) is renewed by its holder's mutations. A `cleo run
 * --wait` or `cleo verify` queued behind other heavy runs makes none, so on a
 * busy machine the waiter's own lease expired mid-wait and another agent could
 * take its task. The admission wait loop calls {@link renewInvokingSessionClaims}
 * on entering the queue and every {@link CLAIM_KEEPALIVE_MS} after.
 *
 * Only the caller's OWN bound session is renewed (connection, `CLEO_SESSION_ID`
 * or terminal binding; never the newest-active fallback), and a renewal only
 * extends leases that session already holds, so a foreign holder's claim is
 * never touched.
 *
 * @task T13492
 */

/** How often a waiting run renews its session's leases: well inside the 30-minute lease. */
export const CLAIM_KEEPALIVE_MS = 5 * 60 * 1000;

/**
 * Renew every claim lease the invoking session holds in its project.
 * Best-effort: an unbound caller, a missing store or a contended write renews
 * nothing and never fails the run.
 *
 * @param projectRoot - The project; defaults to the one the run was started in.
 * @returns Leases renewed.
 * @example
 * ```ts
 * await admit(req, { wait: true, keepAlive: () => renewInvokingSessionClaims() });
 * ```
 * @task T13492
 */
export async function renewInvokingSessionClaims(projectRoot?: string): Promise<number> {
  try {
    // Loaded on demand: the store stays off the static graph of every heavy-run entry (gate 39).
    const { getProjectRoot } = await import('../paths.js');
    const { resolveBoundSession } = await import('../store/session-store.js');
    const { renewProjectSessionClaims } = await import('../task-work/claims.js');
    const root = projectRoot ?? getProjectRoot();
    const bound = await resolveBoundSession(root);
    if (!bound || bound.session.status !== 'active') return 0;
    return await renewProjectSessionClaims(root, bound.session.id);
  } catch {
    return 0;
  }
}
