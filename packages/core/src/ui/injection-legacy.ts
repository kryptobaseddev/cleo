/**
 * Injection legacy utilities - validation keys and marker version extraction.
 *
 * Kept from the deleted injection-registry.ts for backward compatibility
 * with validation output and legacy marker migration. All active injection
 * logic is now delegated to @cleocode/caamp.
 *
 * @task T4677
 * @epic T4663
 */

/**
 * Validation key names for JSON output.
 * Maps target filenames to JSON-safe key names used in validation results.
 */
export const INJECTION_VALIDATION_KEYS: Readonly<Record<string, string>> = {
  'CLAUDE.md': 'claude_md',
  'AGENTS.md': 'agents_md',
  'GEMINI.md': 'gemini_md',
} as const;

/**
 * Get the validation key for a target filename.
 */
export function getValidationKey(target: string): string {
  return INJECTION_VALIDATION_KEYS[target] ?? target.toLowerCase().replace(/[^a-z0-9]/g, '_');
}

/**
 * Version pattern for injection markers.
 * Matches: "CLEO:START -->" (current) or "CLEO:START v0.58.6 -->" (legacy)
 */
const INJECTION_VERSION_PATTERN = /CLEO:START( v(\d+\.\d+\.\d+))? -->/;

/**
 * Extract the CLEO version from an injection marker string.
 * Returns null if no version is present (current format).
 * Returns the version string for legacy format.
 */
export function extractMarkerVersion(markerLine: string): string | null {
  const match = markerLine.match(INJECTION_VERSION_PATTERN);
  if (!match) return null;
  return match[2] ?? null;
}
