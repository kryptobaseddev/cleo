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
 * A worker that is busy outside CLEO (editing, git, watching CI) makes no
 * mutation either. The harness hook that runs before each of its shell
 * commands calls {@link renewSessionClaimsFromHook} (T14546), so a claim stays
 * live while its worker is.
 *
 * @task T13492
 * @task T14546
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

/** A session id that is safe as a file name; ids CLEO mints match it. */
const SESSION_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Options of {@link renewSessionClaimsFromHook}. */
export interface HookClaimHeartbeatOptions {
  /** Directory the shell command starts in; a worktree resolves to its main checkout. */
  readonly cwd?: string;
  /** The project, when the caller already resolved it; otherwise resolved from `cwd`. */
  readonly projectRoot?: string;
  /** Clock override for tests. */
  readonly nowMs?: number;
  /** Throttle stamp directory; defaults to `<cleo state dir>/claim-heartbeat`. */
  readonly stampDir?: string;
}

/**
 * Hook heartbeat (T14546): renew the claim leases of the session a worker's
 * shell command is bound to. The harness `PreToolUse` hook calls it before
 * every shell command, so it is throttled by a stamp file to one store open
 * per session every {@link CLAIM_KEEPALIVE_MS}; a throttled beat reads one
 * small file and never opens the store.
 *
 * Only an ACTIVE session is renewed, and only leases it still holds whose
 * time is half gone (see `renewStaleSessionClaims`): a task another session
 * took over is never touched. Best-effort: a malformed id, a directory outside
 * any project or a failing store renews nothing and never throws.
 *
 * @param sessionId - The session the command names (`CLEO_SESSION_ID`).
 * @param options - Working directory, and test seams.
 * @returns Leases renewed.
 * @example
 * ```ts
 * await renewSessionClaimsFromHook('ses_20261116024011_f800cb', { cwd: input.cwd });
 * ```
 * @task T14546
 */
export async function renewSessionClaimsFromHook(
  sessionId: string,
  options: HookClaimHeartbeatOptions = {},
): Promise<number> {
  if (!SESSION_ID_SHAPE.test(sessionId)) return 0;
  try {
    const nowMs = options.nowMs ?? Date.now();
    const { mkdirSync, readFileSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const stampDir =
      options.stampDir ??
      join((await import('@cleocode/paths')).getCleoStateDir(), 'claim-heartbeat');
    const stamp = join(stampDir, sessionId);
    let last = Number.NaN;
    try {
      last = Number(readFileSync(stamp, 'utf-8'));
    } catch {
      // No stamp yet: this is the session's first beat.
    }
    if (nowMs - last >= 0 && nowMs - last < CLAIM_KEEPALIVE_MS) return 0;
    const { getProjectRoot } = await import('../paths.js');
    const { getSession } = await import('../store/session-store.js');
    const { renewStaleSessionClaims } = await import('../task-work/claims.js');
    const root = options.projectRoot ?? getProjectRoot(options.cwd);
    const session = await getSession(sessionId, root);
    const renewed =
      session?.status === 'active' ? await renewStaleSessionClaims(root, sessionId, nowMs) : 0;
    mkdirSync(stampDir, { recursive: true });
    writeFileSync(stamp, String(nowMs));
    return renewed;
  } catch {
    return 0;
  }
}
