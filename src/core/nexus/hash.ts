import { createHash } from 'node:crypto';

/**
 * Canonical project identity hash.
 * SHA-256 of absolute path, first 12 hex chars.
 * Single source of truth — do not duplicate this function elsewhere.
 */
export function generateProjectHash(projectPath: string): string {
  return createHash('sha256').update(projectPath).digest('hex').substring(0, 12);
}
