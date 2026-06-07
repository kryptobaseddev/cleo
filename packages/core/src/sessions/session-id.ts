/**
 * Canonical session ID generation and validation.
 *
 * Canonical format: ses_{YYYYMMDDHHmmss}_{6hex}
 *   - Human-readable, sortable by timestamp
 *   - 6 hex bytes of randomness avoids collisions
 *
 * Legacy formats remain valid for backward compat:
 *   - session-{epoch}-{hex}         (v1: from core/sessions/index.ts)
 *   - session_{YYYYMMDD}_{HHmmss}_{hex} (v2: from dispatch/engines/session-engine.ts)
 *
 * @epic T4959
 */

import { randomBytes } from 'node:crypto';

/**
 * Generate a canonical session ID.
 *
 * Format: ses_{YYYYMMDDHHmmss}_{6hex}
 * Example: ses_20260227171900_a1b2c3
 */
export function generateSessionId(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:T]/g, '').substring(0, 14); // YYYYMMDDHHmmss
  const hex = randomBytes(3).toString('hex');
  return `ses_${ts}_${hex}`;
}

/** Pattern for canonical format: ses_{14digits}_{6hex} */
const CANONICAL_RE = /^ses_\d{14}_[0-9a-f]{6}$/;

/** Pattern for v2 format: session_{8digits}_{6digits}_{6hex} */
const V2_RE = /^session_\d{8}_\d{6}_[0-9a-f]{6}$/;

/** Pattern for v1 format: session-{epoch}-{6hex} */
const V1_RE = /^session-\d+-[0-9a-f]{6}$/;

/**
 * Check if a string is a valid session ID (any format).
 */
export function isValidSessionId(id: string): boolean {
  return CANONICAL_RE.test(id) || V2_RE.test(id) || V1_RE.test(id);
}

/**
 * Check if a session ID uses the canonical format.
 */
export function isCanonicalSessionId(id: string): boolean {
  return CANONICAL_RE.test(id);
}

/**
 * Extract an approximate timestamp from any valid session ID format.
 * Returns null if the ID format is not recognized.
 */
export function extractSessionTimestamp(id: string): Date | null {
  // Canonical: ses_YYYYMMDDHHmmss_hex
  if (CANONICAL_RE.test(id)) {
    const ts = id.substring(4, 18); // YYYYMMDDHHmmss
    return parseCompactTimestamp(ts);
  }

  // V2: session_YYYYMMDD_HHmmss_hex
  if (V2_RE.test(id)) {
    const parts = id.split('_');
    const ts = (parts[1] ?? '') + (parts[2] ?? '');
    return parseCompactTimestamp(ts);
  }

  // V1: session-{epoch}-hex
  if (V1_RE.test(id)) {
    const parts = id.split('-');
    const epoch = parseInt(parts[1] ?? '0', 10);
    return epoch > 0 ? new Date(epoch) : null;
  }

  return null;
}

/**
 * Canonical environment variable key carrying the active CLEO session id.
 *
 * Unified in T11347 (Epic T11284): `CLEO_SESSION_ID` is THE canonical key.
 * The legacy bare `CLEO_SESSION` key (read in a single legacy callsite) is a
 * documented alias resolved by {@link resolveSessionIdFromEnv} for backward
 * compatibility — new code MUST write `CLEO_SESSION_ID`.
 *
 * @task T11347
 */
export const CANONICAL_SESSION_ENV_KEY = 'CLEO_SESSION_ID' as const;

/**
 * Ordered list of session-id environment variables consulted by the canonical
 * env-first resolver. First non-empty value wins.
 *
 * Order (T11347-unified):
 * 1. `CLEO_SESSION_ID`   — canonical; set by spawn isolation (T11343),
 *    `cleo session start`, and `cleo session adopt`.
 * 2. `CLEO_SESSION`      — legacy alias (single legacy reader); kept for one
 *    deprecation cycle so older shells keep resolving.
 * 3. `CLAUDE_SESSION_ID` — injected by the Claude Code harness.
 * 4. `AIDER_SESSION_ID`  — injected by the Aider harness.
 *
 * @task T9975
 * @task T11347
 */
export const SESSION_ENV_KEY_PRECEDENCE = [
  'CLEO_SESSION_ID',
  'CLEO_SESSION',
  'CLAUDE_SESSION_ID',
  'AIDER_SESSION_ID',
] as const;

/**
 * Resolve the active session ID via environment-variable precedence (T9975).
 *
 * THE single canonical env-first resolver (T11344, Epic T11284). Every
 * session-resolution hot path — `lookupCliSession`, the session-resolver
 * middleware, the audit middleware — consults THIS function so the precedence
 * logic is never duplicated. It returns the per-agent session id injected into
 * the isolation shell by spawn (T11343), making `getActiveSession()` a fallback
 * rather than the default identity. This is what dissolves multi-agent
 * session-bleed: a short-lived `cleo` call inside a worktree resolves the
 * agent's OWN session, not "whoever touched the DB last".
 *
 * Precedence is defined by {@link SESSION_ENV_KEY_PRECEDENCE}. Empty-string
 * values are treated as absent (spawn sets `''` when no per-agent session was
 * allocated), so an empty env var transparently falls through to the next key
 * and ultimately to the caller's `getActiveSession()` fallback.
 *
 * This function NEVER reads the database — it is synchronous and safe to call
 * in hot paths. Database fallback is the caller's responsibility.
 *
 * @returns The session ID string when an env var is set, otherwise `null`.
 *
 * @task T9975
 * @task T11344
 */
export function resolveSessionIdFromEnv(): string | null {
  for (const key of SESSION_ENV_KEY_PRECEDENCE) {
    const value = process.env[key];
    if (value !== undefined && value !== '') {
      return value;
    }
  }
  return null;
}

/**
 * Resolve the active agent identity handle from the environment (T11343).
 *
 * Returns the `CLEO_AGENT_ID` injected by spawn into the isolation shell, or
 * `null` when unset/empty. Used to attribute audit rows, conduit messages, and
 * memory observations to the spawned agent rather than the orchestrator.
 *
 * @returns The agent id string when set, otherwise `null`.
 * @task T11343
 */
export function resolveAgentIdFromEnv(): string | null {
  const value = process.env['CLEO_AGENT_ID'];
  return value !== undefined && value !== '' ? value : null;
}

/**
 * Canonical environment key carrying the fork-tree PARENT session id (T11629).
 *
 * The native supervisor (`crates/cleo-supervisor`) stamps this key onto every
 * worker it spawns, set to the supervisor's OWN root session id (the value of
 * {@link CANONICAL_SESSION_ENV_KEY} in the supervisor's environment). It is the
 * fork-tree edge: a worker's own session ({@link CANONICAL_SESSION_ENV_KEY})
 * resolved by {@link resolveSessionIdFromEnv} is the CHILD; the value of this
 * key is its PARENT. Reading both lets the session subsystem reconstruct the
 * orchestrator→worker fork tree without a DB scan.
 *
 * The Rust constant of the same name lives in
 * `crates/cleo-supervisor/src/supervisor.rs` (`PARENT_SESSION_ID_ENV_KEY`).
 *
 * @task T11629
 */
export const PARENT_SESSION_ENV_KEY = 'CLEO_PARENT_SESSION_ID' as const;

/**
 * Resolve the fork-tree PARENT session id from the environment (T11629).
 *
 * Returns the {@link PARENT_SESSION_ENV_KEY} (`CLEO_PARENT_SESSION_ID`) value
 * stamped by the supervisor when it spawned this process, or `null` when
 * unset/empty (e.g. a top-level/root process with no supervisor parent). The
 * companion of {@link resolveSessionIdFromEnv}: that resolves THIS process's own
 * session (the fork-tree child); this resolves the session that spawned it (the
 * fork-tree parent).
 *
 * Like the other env resolvers this NEVER reads the database — it is synchronous
 * and safe in hot paths. Empty-string values are treated as absent.
 *
 * @returns The parent session id string when set, otherwise `null`.
 * @task T11629
 */
export function resolveParentSessionIdFromEnv(): string | null {
  const value = process.env[PARENT_SESSION_ENV_KEY];
  return value !== undefined && value !== '' ? value : null;
}

function parseCompactTimestamp(ts: string): Date | null {
  if (ts.length !== 14) return null;
  const year = ts.substring(0, 4);
  const month = ts.substring(4, 6);
  const day = ts.substring(6, 8);
  const hour = ts.substring(8, 10);
  const min = ts.substring(10, 12);
  const sec = ts.substring(12, 14);
  const d = new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
