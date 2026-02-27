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
  const ts = now.toISOString()
    .replace(/[-:T]/g, '')
    .substring(0, 14); // YYYYMMDDHHmmss
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

function parseCompactTimestamp(ts: string): Date | null {
  if (ts.length !== 14) return null;
  const year = ts.substring(0, 4);
  const month = ts.substring(4, 6);
  const day = ts.substring(6, 8);
  const hour = ts.substring(8, 10);
  const min = ts.substring(10, 12);
  const sec = ts.substring(12, 14);
  const d = new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}Z`);
  return isNaN(d.getTime()) ? null : d;
}
