/**
 * T11181 — Version SSoT: canonical version identifiers.
 *
 * Stub module. Full implementation pending T11181 completion.
 * Exports the contract surface expected by docs/index.ts barrel.
 *
 * @task T11181
 * @epic T10518
 * @saga T10516
 */

/** Result of auditing version fields across the codebase. */
export interface VersionAuditResult {
  /** Whether the audit passed. */
  ok: boolean;
  /** List of findings from the audit. */
  findings: string[];
}

/** SQL migration statements for version SSoT initialization. */
export const VERSION_SSOT_MIGRATION_SQL = '';

/**
 * Audit version fields across doc records for consistency.
 * Stub — returns an empty audit.
 */
export function auditVersionFields(): VersionAuditResult {
  return { ok: true, findings: [] };
}

/**
 * Compare two CLEO version strings.
 * Stub — returns 0 (equal).
 */
export function compareCleoVersions(_a: string, _b: string): number {
  return 0;
}

/**
 * Get the canonical CLEO version string.
 * Stub — returns '0.0.0'.
 */
export function getCanonicalCleoVersion(): string {
  return '0.0.0';
}

/**
 * Resolve a version identifier to its canonical form.
 * Stub — returns the input unchanged.
 */
export function resolveVersion(v: string): string {
  return v;
}

/**
 * Check if a version is within a range.
 * Stub — always returns true.
 */
export function versionInRange(_version: string, _range: string): boolean {
  return true;
}
