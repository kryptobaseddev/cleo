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
 * commands calls {@link renewClaimsOfHookProcess} (T14546), so a claim stays
 * live while its worker is. That beat trusts only what the hook PROCESS is:
 * its own environment, or the task worktree it runs in. It never reads an
 * identity out of the command line, which any agent can write.
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

/** A stamp key that is safe as a file name: a session id, or `<projectHash>-<taskId>`. */
const STAMP_KEY_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** What {@link renewClaimsOfHookProcess} needs to know about the hook process. */
export interface HookClaimHeartbeatOptions {
  /**
   * The hook process's own directory: the project directory its harness was
   * launched in, else its working directory. Never a directory a command names.
   */
  readonly cwd: string;
  /** The hook process's own environment. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The project, when the caller already resolved it; otherwise resolved from `cwd`. */
  readonly projectRoot?: string;
  /** Clock override for tests. */
  readonly nowMs?: number;
  /** Throttle stamp directory; defaults to `<cleo state dir>/claim-heartbeat`. */
  readonly stampDir?: string;
}

/** The canonical task worktree a directory lies in (`<cleoHome>/worktrees/<hash>/<taskId>/…`). */
interface TaskWorktree {
  readonly projectHash: string;
  readonly taskId: string;
}

/** Resolve the task worktree `cwd` lies in, or `null` when it is in none. */
async function taskWorktreeOf(cwd: string): Promise<TaskWorktree | null> {
  const { realpathSync } = await import('node:fs');
  const { isAbsolute, relative, sep } = await import('node:path');
  const { getCleoWorktreesRoot } = await import('@cleocode/paths');
  let inside: string;
  try {
    inside = relative(realpathSync(getCleoWorktreesRoot()), realpathSync(cwd));
  } catch {
    return null; // no worktrees root, or a directory that is gone
  }
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return null;
  const [projectHash, taskId] = inside.split(sep);
  return projectHash && taskId ? { projectHash, taskId } : null;
}

/**
 * The session a task worktree is allocated to, when it holds that task's
 * claim: the session and agent of the worktree lock spawn wrote, provided the
 * worktree belongs to `root` and the task's claim names the same session and
 * agent. Anything else (no lock, another project, a claim another session
 * took) is `null`: a worktree never renews a claim its holder does not own.
 */
async function worktreeClaimHolder(root: string, worktree: TaskWorktree): Promise<string | null> {
  const { computeProjectHash } = await import('@cleocode/paths');
  if (computeProjectHash(root) !== worktree.projectHash) return null;
  const { readWorktreeTaskLock } = await import('@cleocode/worktree');
  const lock = readWorktreeTaskLock(worktree.projectHash, worktree.taskId);
  if (!lock?.sessionId) return null;
  const { getTaskAccessor } = await import('../store/data-accessor.js');
  const { sameClaimAgent } = await import('../store/task-claim.js');
  const claim = (await (await getTaskAccessor(root)).loadSingleTask(worktree.taskId))?.claim;
  if (claim?.sessionId !== lock.sessionId || !sameClaimAgent(claim.agentId, lock.agentId)) {
    return null;
  }
  return lock.sessionId;
}

/**
 * Hook heartbeat (T14546): renew the claim leases of the session the hook
 * PROCESS is bound to. The harness `PreToolUse` hook calls it before every
 * shell command a worker runs.
 *
 * Identity comes only from the process, never from the command line (a
 * command can print or comment any session id):
 *
 * 1. a session id in the process's own environment (`CLEO_SESSION_ID` & co.,
 *    as `resolveSessionIdFromEnv` reads them), when its session row exists;
 * 2. else the task worktree the process runs in, through the worktree lock
 *    spawn wrote for it, and only while that lock's session and agent hold the
 *    task's claim.
 *
 * Only an ACTIVE session is renewed, and only leases it holds whose time is
 * half gone (`renewStaleSessionClaims`): a process bound to another session
 * cannot extend this one's lease, so an idle holder's claim still lapses and
 * can be taken over.
 *
 * A stamp file throttles the beat to one store open per identity every
 * {@link CLAIM_KEEPALIVE_MS}; a throttled beat reads one small file. A process
 * with neither binding opens nothing. Best-effort: it never throws.
 *
 * @param options - The hook process's directory and environment, and test seams.
 * @returns Leases renewed.
 * @example
 * ```ts
 * await renewClaimsOfHookProcess({ cwd: process.cwd(), env: process.env });
 * ```
 * @task T14546
 */
export async function renewClaimsOfHookProcess(
  options: HookClaimHeartbeatOptions,
): Promise<number> {
  try {
    const { resolveSessionIdFromEnv } = await import('../sessions/session-id.js');
    const envSession = resolveSessionIdFromEnv(options.env);
    const worktree = await taskWorktreeOf(options.cwd);
    const stampKey = worktree ? `${worktree.projectHash}-${worktree.taskId}` : envSession;
    if (stampKey === null || !STAMP_KEY_SHAPE.test(stampKey)) return 0;

    const nowMs = options.nowMs ?? Date.now();
    const { mkdirSync, readFileSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const stampDir =
      options.stampDir ??
      join((await import('@cleocode/paths')).getCleoStateDir(), 'claim-heartbeat');
    const stamp = join(stampDir, stampKey);
    let last = Number.NaN;
    try {
      last = Number(readFileSync(stamp, 'utf-8'));
    } catch {
      // No stamp yet: this is the identity's first beat.
    }
    if (nowMs - last >= 0 && nowMs - last < CLAIM_KEEPALIVE_MS) return 0;

    const { getProjectRoot } = await import('../paths.js');
    const { getSession } = await import('../store/session-store.js');
    const { renewStaleSessionClaims } = await import('../task-work/claims.js');
    const root = options.projectRoot ?? getProjectRoot(options.cwd);
    // An env id with no session row (a harness's own id) falls through to the worktree.
    let session = envSession === null ? null : await getSession(envSession, root);
    if (session === null && worktree !== null) {
      const holder = await worktreeClaimHolder(root, worktree);
      session = holder === null ? null : await getSession(holder, root);
    }
    const renewed =
      session?.status === 'active' ? await renewStaleSessionClaims(root, session.id, nowMs) : 0;
    mkdirSync(stampDir, { recursive: true });
    writeFileSync(stamp, String(nowMs));
    return renewed;
  } catch {
    return 0;
  }
}
