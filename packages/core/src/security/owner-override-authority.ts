/**
 * Who may use `CLEO_OWNER_OVERRIDE=1` (T13790, owner decision 2026-10-16).
 *
 * The override stays an env var with no password prompt of its own, but it is
 * honoured only for the owner:
 *  1. **Role fence** (T1118 L4b): a process whose `CLEO_AGENT_ROLE` was
 *     `worker`, `lead` or `subagent` at bootstrap, or changed since, is refused.
 *  2. **Owner-marked session**: the bound session was started interactively
 *     with `cleo session start --scope global --name <n> --owner` — no
 *     password (owner decision: lighter), but refused unless stdin and stderr
 *     are a terminal and no `CLEO_AGENT_ROLE` is set ({@link ownerMarkRefusal}).
 *     No env var marks a session as the owner's, so a parent cannot hand the
 *     mark down. An agent session with no `CLEO_AGENT_ROLE` is therefore
 *     fenced like a worker: it has no mark. (`--owner-auth` and its password
 *     are only for the T13787 cap enrollment; they do not mark a session.)
 *  3. **The owner's own terminal**: the override call itself runs on a TTY
 *     (stdin and stderr). An agent spawned from the owner's session binds to
 *     that same session (it inherits the harness session id or
 *     `CLEO_SESSION_ID`), but its tool shell has no TTY, so it is not the owner
 *     by default.
 * Every refusal is appended to `.cleo/audit/force-bypass.jsonl`.
 *
 * Limits: these are same-OS-user checks. They fence default and accidental
 * agent use; a process that emulates a terminal (`script`, `expect`) can mark a
 * session and pass the TTY check, and a process that writes the session row
 * directly is not stopped. The owner accepted that trade-off for a
 * password-free switch.
 *
 * @task T13790
 */

import { BRANCH_LOCK_ERROR_CODES } from '@cleocode/contracts/branch-lock.js';
import {
  appendOwnerOverrideAudit,
  isAgentRoleForbidden,
  isOwnerSessionMark,
  isTtyPresent,
} from './owner-override-auth.js';

/** How the owner marks a session, named in every refusal. */
export const OWNER_SESSION_COMMAND = 'cleo session start --scope global --name owner --owner';

export { ownerMarkRefusal } from './owner-override-auth.js';

/** Whether `CLEO_OWNER_OVERRIDE` asks for an override. */
export function isOwnerOverrideRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['CLEO_OWNER_OVERRIDE'];
  return raw === '1' || raw === 'true';
}

/** What {@link resolveOwnerOverride} decided. */
export type OwnerOverrideAuthority =
  | { requested: false }
  | {
      requested: true;
      allowed: true;
      /** `CLEO_OWNER_OVERRIDE_REASON`, or `unspecified`. */
      reason: string;
      /** The owner-marked session. */
      sessionId: string;
    }
  | { requested: true; allowed: false; code: string; message: string };

/**
 * Decide whether this process may use `CLEO_OWNER_OVERRIDE=1` (see the module
 * doc), auditing a refusal.
 *
 * @param projectRoot - Project root (session store and audit log).
 * @param opts - The surface asking (named in the audit line), and the session
 *   the caller already resolved; otherwise the bound session is resolved.
 * @returns Not requested, allowed with the reason, or refused with why.
 * @task T13790
 */
export async function resolveOwnerOverride(
  projectRoot: string,
  opts: { surface: string; taskId?: string; sessionId?: string | null },
): Promise<OwnerOverrideAuthority> {
  if (!isOwnerOverrideRequested()) return { requested: false };
  const reason = (process.env['CLEO_OWNER_OVERRIDE_REASON'] ?? '').trim() || 'unspecified';
  const sessions = await import('../store/session-store.js');
  let sessionId = opts.sessionId ?? null;
  if (sessionId === null) {
    try {
      sessionId = await sessions.resolveBoundSessionId(projectRoot);
    } catch {
      sessionId = null;
    }
  }
  const tty = isTtyPresent();
  const refuse = (code: string, why: string): OwnerOverrideAuthority => {
    appendOwnerOverrideAudit(projectRoot, {
      timestamp: new Date().toISOString(),
      taskId: opts.taskId ?? '*',
      gate: opts.surface,
      action: 'override-refused',
      agent_id: process.env['CLEO_AGENT_ID'] ?? 'unknown',
      session_id: sessionId,
      token_validated: false,
      tty_present: tty,
      override_count: 0,
      reason: `${why} (requested reason: ${reason})`,
      pid: process.pid,
    });
    return {
      requested: true,
      allowed: false,
      code,
      message:
        `CLEO_OWNER_OVERRIDE is refused: ${why} Only the owner may override, from their own ` +
        `terminal, in a session they started with \`${OWNER_SESSION_COMMAND}\` (T13790). ` +
        // T14094: the routes that replace the most common overrides.
        'Work shipped under another task: record its pr:<n> with satisfies:<id>#AC<n> for the ' +
        'criteria it delivers. A task another task fully covers: cleo cancel <id> --reason ' +
        '"covered by T<n>" and cleo relates add <id> T<n> duplicates "<reason>".',
    };
  };
  // @sync-invariant none:local-only override authority is judged before any write; refusals only append to the local audit log
  if (isAgentRoleForbidden())
    return refuse(
      BRANCH_LOCK_ERROR_CODES.E_OVERRIDE_FORBIDDEN_AGENT_ROLE,
      'this process runs as a restricted agent role (worker, lead or subagent).',
    );
  const auth = sessionId ? await sessions.getSessionOwnerAuth(sessionId, projectRoot) : null;
  if (!sessionId || !isOwnerSessionMark(auth?.token))
    return refuse(
      BRANCH_LOCK_ERROR_CODES.E_OVERRIDE_NOT_OWNER,
      sessionId
        ? `session ${sessionId} is not owner-marked (it was not started with --owner).`
        : 'no session is bound, so no owner-marked session can vouch for this call.',
    );
  if (!tty)
    return refuse(
      BRANCH_LOCK_ERROR_CODES.E_OVERRIDE_NOT_OWNER,
      `this call has no terminal: it runs inside owner-marked session ${sessionId} but not from the owner's own TTY (an agent spawned from the owner's session is not the owner).`,
    );
  return { requested: true, allowed: true, reason, sessionId };
}
