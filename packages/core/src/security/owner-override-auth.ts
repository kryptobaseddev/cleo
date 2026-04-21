/**
 * Layer 4 owner-override authentication system (T1118).
 *
 * Implements the four sublayers:
 *
 * - L4a: Session HMAC token — override requires a valid HMAC-SHA256 token
 *         derived from session_id + password, stored in sessions.owner_auth_token.
 * - L4b: CLEO_AGENT_ROLE fence — override is forbidden for worker|lead|subagent roles.
 *         Environment hash is captured at bootstrap; mutations are detected.
 * - L4c: TTY requirement — override call requires stdin + stderr to be TTYs.
 * - L4d: Rate limit + webhook — max N overrides per session; every use appended to
 *         force-bypass.jsonl with correct agent_id + session_id; optional webhook POST.
 *
 * @task T1118
 * @task T1123
 * @adr ADR-055
 */

import { createHmac } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { OwnerOverrideAuditRecord } from '@cleocode/contracts';
import { BRANCH_LOCK_ERROR_CODES } from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// L4b — Bootstrap env snapshot
// ---------------------------------------------------------------------------

/**
 * Immutable snapshot of CLEO_AGENT_ROLE captured at process startup.
 *
 * We read this once so an agent cannot unset the variable later and
 * gain override access.
 *
 * @task T1118
 * @task T1123
 */
const BOOTSTRAP_AGENT_ROLE: string | undefined = process.env['CLEO_AGENT_ROLE'];

/** Roles that are forbidden from using CLEO_OWNER_OVERRIDE. */
const FORBIDDEN_OVERRIDE_ROLES = new Set(['worker', 'lead', 'subagent']);

/**
 * Check if the current process is running as a restricted agent role.
 *
 * Re-reads process.env to detect mutation attempts and compares against
 * the bootstrapped snapshot.
 *
 * @returns true when the process has a restricted role and override is forbidden.
 *
 * @task T1118
 * @task T1123
 */
export function isAgentRoleForbidden(): boolean {
  const currentRole = process.env['CLEO_AGENT_ROLE'];

  // If the role was restricted at bootstrap, it is permanently forbidden.
  if (BOOTSTRAP_AGENT_ROLE && FORBIDDEN_OVERRIDE_ROLES.has(BOOTSTRAP_AGENT_ROLE)) {
    return true;
  }

  // Detect mutation: if CLEO_AGENT_ROLE was set at bootstrap but has changed,
  // the agent tried to bypass by mutating env — reject.
  if (BOOTSTRAP_AGENT_ROLE !== currentRole) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// L4a — Session HMAC token
// ---------------------------------------------------------------------------

/**
 * Derive a session owner-auth HMAC token from session ID and password.
 *
 * Uses HMAC-SHA256(key=password, data=sessionId). The token is hex-encoded
 * and stored in sessions.owner_auth_token. Override callers must present
 * the same token via --auth-token.
 *
 * @param sessionId - Active session ID.
 * @param password - Plaintext password provided by the owner via TTY.
 * @returns Hex-encoded HMAC token.
 *
 * @task T1118
 * @task T1123
 */
export function deriveOwnerAuthToken(sessionId: string, password: string): string {
  return createHmac('sha256', password).update(sessionId).digest('hex');
}

/**
 * Verify a caller-supplied auth token against the stored token.
 *
 * Uses a constant-time comparison to prevent timing attacks.
 *
 * @param callerToken - Token supplied by the caller via --auth-token.
 * @param storedToken - Token stored in sessions.owner_auth_token.
 * @returns true when tokens match.
 *
 * @task T1118
 * @task T1123
 */
export function verifyOwnerAuthToken(callerToken: string, storedToken: string): boolean {
  if (callerToken.length !== storedToken.length) return false;

  // Constant-time comparison using Buffer.equals.
  const a = Buffer.from(callerToken, 'utf-8');
  const b = Buffer.from(storedToken, 'utf-8');
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// L4c — TTY requirement
// ---------------------------------------------------------------------------

/**
 * Check that stdin and stderr are both connected to a TTY.
 *
 * Override requires interactive use — piped or agent-driven invocations
 * are rejected at this gate.
 *
 * @returns true when both TTY checks pass.
 *
 * @task T1118
 * @task T1123
 */
export function isTtyPresent(): boolean {
  return Boolean(process.stdin.isTTY) && Boolean(process.stderr.isTTY);
}

// ---------------------------------------------------------------------------
// L4d — Rate limit + audit
// ---------------------------------------------------------------------------

/** In-process override counter keyed by sessionId. */
const overrideCountBySession = new Map<string, number>();

/**
 * Default maximum number of overrides allowed per session.
 * Can be overridden via config.owner.overrideMaxPerSession.
 */
export const DEFAULT_OVERRIDE_MAX_PER_SESSION = 3;

/**
 * Record an override use and check against the session rate limit.
 *
 * @param sessionId - Active session ID (use "global" when no session).
 * @param maxPerSession - Maximum overrides allowed per session.
 * @returns true when within the rate limit, false when exceeded.
 *
 * @task T1118
 * @task T1123
 */
export function recordAndCheckOverrideLimit(
  sessionId: string,
  maxPerSession: number = DEFAULT_OVERRIDE_MAX_PER_SESSION,
): boolean {
  const current = overrideCountBySession.get(sessionId) ?? 0;
  if (current >= maxPerSession) return false;
  overrideCountBySession.set(sessionId, current + 1);
  return true;
}

/**
 * Get the current override count for a session.
 *
 * @param sessionId - Session ID to query.
 * @returns Current override count.
 *
 * @task T1118
 * @task T1123
 */
export function getOverrideCount(sessionId: string): number {
  return overrideCountBySession.get(sessionId) ?? 0;
}

/**
 * Reset the override counter for a session (called on session end).
 *
 * @param sessionId - Session ID to reset.
 *
 * @task T1118
 * @task T1123
 */
export function resetOverrideCount(sessionId: string): void {
  overrideCountBySession.delete(sessionId);
}

// ---------------------------------------------------------------------------
// L4d — Audit log append
// ---------------------------------------------------------------------------

/**
 * Append an owner-override audit record to force-bypass.jsonl.
 *
 * Errors are swallowed — audit writes must never block the operation.
 * Matches the existing pattern in gate-audit.ts.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param record - Audit record to append.
 *
 * @task T1118
 * @task T1123
 */
export function appendOwnerOverrideAudit(
  projectRoot: string,
  record: OwnerOverrideAuditRecord,
): void {
  const bypassPath = `${projectRoot}/.cleo/audit/force-bypass.jsonl`;
  try {
    mkdirSync(dirname(bypassPath), { recursive: true });
    appendFileSync(bypassPath, `${JSON.stringify(record)}\n`, { encoding: 'utf-8' });
  } catch {
    // non-fatal — audit must not block the protected operation
  }
}

// ---------------------------------------------------------------------------
// L4d — Optional webhook delivery
// ---------------------------------------------------------------------------

/**
 * POST an owner-override event to the configured alert webhook.
 *
 * Best-effort: network failures are silently ignored to avoid blocking
 * the protected operation.
 *
 * @param webhookUrl - HTTP(S) URL to POST the event to.
 * @param record - Override audit record to include in the payload.
 *
 * @task T1118
 * @task T1123
 */
export async function deliverOverrideWebhook(
  webhookUrl: string,
  record: OwnerOverrideAuditRecord,
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'owner_override', ...record }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return resp.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// L4 — Unified validation gate
// ---------------------------------------------------------------------------

/** Result of the L4 override validation. */
export interface OverrideValidationResult {
  /** Whether the override is permitted. */
  allowed: boolean;
  /** Error code if not allowed. */
  errorCode?: string;
  /** Human-readable error message. */
  errorMessage?: string;
}

/**
 * Validate all four L4 sublayers before permitting an owner override.
 *
 * Steps:
 * 1. L4b — Check agent role fence.
 * 2. L4c — Check TTY presence.
 * 3. L4a — Verify HMAC token (if storedToken provided).
 * 4. L4d — Check rate limit.
 *
 * @param opts - Validation options.
 * @returns Validation result.
 *
 * @task T1118
 * @task T1123
 */
export function validateOwnerOverride(opts: {
  sessionId: string;
  callerToken?: string;
  storedToken?: string;
  maxPerSession?: number;
  skipTtyCheck?: boolean;
  skipTokenCheck?: boolean;
}): OverrideValidationResult {
  // L4b — Role fence.
  if (isAgentRoleForbidden()) {
    return {
      allowed: false,
      errorCode: BRANCH_LOCK_ERROR_CODES.E_OVERRIDE_FORBIDDEN_AGENT_ROLE,
      errorMessage:
        'Override is forbidden for agent roles (worker|lead|subagent). ' +
        'CLEO_AGENT_ROLE detected at process bootstrap and cannot be unset.',
    };
  }

  // L4c — TTY requirement.
  if (!opts.skipTtyCheck && !isTtyPresent()) {
    return {
      allowed: false,
      errorCode: BRANCH_LOCK_ERROR_CODES.E_OVERRIDE_NEEDS_TTY,
      errorMessage:
        'Override requires an interactive TTY. ' +
        'stdin.isTTY or stderr.isTTY is false — this invocation appears to be piped or automated.',
    };
  }

  // L4a — HMAC token verification.
  if (!opts.skipTokenCheck && opts.storedToken !== undefined) {
    const callerToken = opts.callerToken ?? '';
    if (!verifyOwnerAuthToken(callerToken, opts.storedToken)) {
      return {
        allowed: false,
        errorCode: BRANCH_LOCK_ERROR_CODES.E_OVERRIDE_TOKEN_INVALID,
        errorMessage:
          'Override token does not match the session owner-auth token. ' +
          'Generate a valid token with: cleo session start --owner-auth',
      };
    }
  }

  // L4d — Rate limit.
  const withinLimit = recordAndCheckOverrideLimit(
    opts.sessionId,
    opts.maxPerSession ?? DEFAULT_OVERRIDE_MAX_PER_SESSION,
  );
  if (!withinLimit) {
    const count = getOverrideCount(opts.sessionId);
    return {
      allowed: false,
      errorCode: BRANCH_LOCK_ERROR_CODES.E_OVERRIDE_RATE_LIMIT,
      errorMessage:
        `Override rate limit exceeded: ${count} of ${opts.maxPerSession ?? DEFAULT_OVERRIDE_MAX_PER_SESSION} ` +
        `overrides used in this session. Start a new session to reset.`,
    };
  }

  return { allowed: true };
}
