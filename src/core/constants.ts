/**
 * Centralized constants for CLEO core modules.
 */

/**
 * Files relative to .cleo/ that MUST remain tracked by git.
 * These files are critical for CLEO data integrity. If any are
 * gitignored, the pre-commit hook blocks the commit and cleo doctor
 * reports a critical finding.
 *
 * Add new entries here when introducing new core files (e.g. brain.db).
 */
export const CORE_PROTECTED_FILES = [
  'tasks.db',
  'config.json',
  '.gitignore',
  'project-info.json',
  'project-context.json',
] as const;
