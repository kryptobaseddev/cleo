/**
 * Injection target registry - single source of truth for injectable documentation files.
 * Ported from lib/ui/injection-registry.sh
 *
 * Defines all supported injection targets and marker formats.
 * Add new targets here; all commands auto-discover them.
 *
 * @task T4552
 * @epic T4545
 */

/**
 * Supported injection target filenames.
 * Only 3 real instruction files:
 * - CLAUDE.md (Claude Code)
 * - AGENTS.md (all others including Codex and Kimi)
 * - GEMINI.md (Gemini CLI)
 */
export const INJECTION_TARGETS = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'] as const;
export type InjectionTarget = (typeof INJECTION_TARGETS)[number];

/** Injection block marker start. */
export const INJECTION_MARKER_START = '<!-- CLEO:START';

/** Injection block marker end. */
export const INJECTION_MARKER_END = '<!-- CLEO:END -->';

/**
 * Version pattern for injection markers.
 * Matches: "CLEO:START -->" (current) or "CLEO:START v0.58.6 -->" (legacy)
 */
export const INJECTION_VERSION_PATTERN = /CLEO:START( v(\d+\.\d+\.\d+))? -->/;

/** Template path for injection content (relative to CLEO_HOME). */
export const INJECTION_TEMPLATE_MAIN = 'templates/AGENT-INJECTION.md';

/** Template directory for agent-specific overrides (relative to CLEO_HOME). */
export const INJECTION_TEMPLATE_DIR = 'templates/agents';

/**
 * Validation key names for JSON output.
 * Maps target filenames to JSON-safe key names used in validation results.
 * @task T4552
 */
export const INJECTION_VALIDATION_KEYS: Readonly<Record<InjectionTarget, string>> = {
  'CLAUDE.md': 'claude_md',
  'AGENTS.md': 'agents_md',
  'GEMINI.md': 'gemini_md',
} as const;

/**
 * Check if a filename is a valid injection target.
 * @task T4552
 */
export function isInjectionTarget(filename: string): filename is InjectionTarget {
  return (INJECTION_TARGETS as readonly string[]).includes(filename);
}

/**
 * Get the validation key for a target filename.
 * @task T4552
 */
export function getValidationKey(target: InjectionTarget): string {
  return INJECTION_VALIDATION_KEYS[target];
}

/**
 * Extract the CLEO version from an injection marker string.
 * Returns null if no version is present (current format).
 * Returns the version string for legacy format.
 * @task T4552
 */
export function extractMarkerVersion(markerLine: string): string | null {
  const match = markerLine.match(INJECTION_VERSION_PATTERN);
  if (!match) return null;
  return match[2] ?? null;
}
