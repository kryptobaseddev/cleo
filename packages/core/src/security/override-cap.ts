/**
 * Per-session CLEO_OWNER_OVERRIDE cap with waiver-doc requirement (T1501 / P0-5).
 *
 * Enforces a hard cap (default: 3) on how many times `CLEO_OWNER_OVERRIDE` may
 * be used within a single session.  Above the cap the call is rejected with
 * `E_OVERRIDE_CAP_EXCEEDED` unless the operator sets:
 *
 *   `CLEO_OWNER_OVERRIDE_WAIVER=<absolute path to waiver doc>`
 *
 * The waiver file must exist and contain `cap-waiver: true` (YAML front-matter
 * or a plain line in the file).
 *
 * The running count is persisted in
 * `.cleo/audit/session-override-count.<sessionId>.json` so it survives across
 * multiple CLI invocations within the same session (each invocation is its own
 * process).
 *
 * @adr ADR-059
 * @task T1501
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { BRANCH_LOCK_ERROR_CODES } from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default maximum CLEO_OWNER_OVERRIDE uses per session (T1501 / P0-5). */
export const DEFAULT_OVERRIDE_CAP_PER_SESSION = 3;

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the path of the per-session override count file.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param sessionId - Active session ID (use "global" when no session).
 * @returns Absolute path to `.cleo/audit/session-override-count.<sessionId>.json`.
 *
 * @task T1501
 */
export function getSessionOverrideCountPath(projectRoot: string, sessionId: string): string {
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(projectRoot, '.cleo', 'audit', `session-override-count.${safeId}.json`);
}

/**
 * Read the persisted override count for a session.
 *
 * Returns 0 when the file does not exist (new session or first override).
 *
 * @param projectRoot - Absolute path to the project root.
 * @param sessionId - Active session ID.
 * @returns Current override count for the session.
 *
 * @task T1501
 */
export function readSessionOverrideCount(projectRoot: string, sessionId: string): number {
  const path = getSessionOverrideCountPath(projectRoot, sessionId);
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'count' in parsed &&
      typeof (parsed as Record<string, unknown>)['count'] === 'number'
    ) {
      return (parsed as { count: number }).count;
    }
  } catch {
    // File absent or malformed — treat as 0.
  }
  return 0;
}

/**
 * Persist the override count for a session.
 *
 * Errors are swallowed — persistence failures must not block the override
 * write.  The count file is advisory; the real audit trail is force-bypass.jsonl.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param sessionId - Active session ID.
 * @param count - Updated count to persist.
 *
 * @task T1501
 */
export function writeSessionOverrideCount(
  projectRoot: string,
  sessionId: string,
  count: number,
): void {
  try {
    const path = getSessionOverrideCountPath(projectRoot, sessionId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ sessionId, count, updatedAt: new Date().toISOString() }), {
      encoding: 'utf-8',
    });
  } catch {
    // Non-fatal — audit count should not block operations.
  }
}

// ---------------------------------------------------------------------------
// Waiver validation
// ---------------------------------------------------------------------------

/**
 * Validate that a waiver document exists and contains the required marker.
 *
 * The waiver file must:
 *   1. Exist at the absolute path specified by `CLEO_OWNER_OVERRIDE_WAIVER`.
 *   2. Contain the string `cap-waiver: true` (any position in the file).
 *
 * @param waiverPath - Absolute path to the waiver document.
 * @returns `{ valid: true }` when the waiver is accepted, or
 *          `{ valid: false, reason: string }` when it is rejected.
 *
 * @task T1501
 */
export function validateWaiverDoc(waiverPath: string): { valid: boolean; reason?: string } {
  if (!waiverPath) {
    return { valid: false, reason: 'CLEO_OWNER_OVERRIDE_WAIVER is empty' };
  }

  if (!existsSync(waiverPath)) {
    return {
      valid: false,
      reason: `Waiver document not found at: ${waiverPath}`,
    };
  }

  let content: string;
  try {
    content = readFileSync(waiverPath, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { valid: false, reason: `Cannot read waiver document: ${msg}` };
  }

  if (!content.includes('cap-waiver: true')) {
    return {
      valid: false,
      reason:
        "Waiver document must contain 'cap-waiver: true' (YAML front-matter or plain line). " +
        `File: ${waiverPath}`,
    };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Cap enforcement gate
// ---------------------------------------------------------------------------

/** Result of the override cap check. */
export interface OverrideCapResult {
  /** Whether the override is permitted. */
  allowed: boolean;
  /** Error code when not allowed (E_OVERRIDE_CAP_EXCEEDED). */
  errorCode?: string;
  /** Human-readable message. */
  errorMessage?: string;
  /** 1-based ordinal of this override within the session (populated on success). */
  sessionOverrideOrdinal?: number;
}

/**
 * Check and enforce the per-session CLEO_OWNER_OVERRIDE cap.
 *
 * Reads the persisted count, checks it against the cap, validates the waiver
 * doc when required, increments the count on success, and returns the ordinal.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param sessionId - Active session ID ("global" when no session is active).
 * @param cap - Maximum overrides allowed per session (default: 3).
 * @returns `OverrideCapResult` indicating whether the override is permitted.
 *
 * @task T1501
 * @adr ADR-059
 */
export function checkAndIncrementOverrideCap(
  projectRoot: string,
  sessionId: string,
  cap: number = DEFAULT_OVERRIDE_CAP_PER_SESSION,
): OverrideCapResult {
  const current = readSessionOverrideCount(projectRoot, sessionId);

  if (current < cap) {
    // Within cap — permit and increment.
    const ordinal = current + 1;
    writeSessionOverrideCount(projectRoot, sessionId, ordinal);
    return { allowed: true, sessionOverrideOrdinal: ordinal };
  }

  // Above cap — check for waiver.
  const waiverPath = (process.env['CLEO_OWNER_OVERRIDE_WAIVER'] ?? '').trim();
  const waiver = validateWaiverDoc(waiverPath);

  if (!waiver.valid) {
    return {
      allowed: false,
      errorCode: BRANCH_LOCK_ERROR_CODES.E_OVERRIDE_CAP_EXCEEDED,
      errorMessage:
        `Per-session CLEO_OWNER_OVERRIDE cap exceeded: ${current} of ${cap} overrides used. ` +
        `To proceed above the cap, set CLEO_OWNER_OVERRIDE_WAIVER=<path> to a file containing ` +
        `'cap-waiver: true'. ` +
        (waiver.reason ? `Waiver rejected: ${waiver.reason}` : ''),
    };
  }

  // Waiver accepted — permit and increment beyond cap.
  const ordinal = current + 1;
  writeSessionOverrideCount(projectRoot, sessionId, ordinal);
  return { allowed: true, sessionOverrideOrdinal: ordinal };
}
