/**
 * Centralized constants for CLEO core modules.
 */

/**
 * Configuration files relative to .cleo/ that MUST remain tracked by project git.
 * These are JSON/text config files only — NOT databases.
 * SQLite databases (tasks.db) are excluded: they must be gitignored to
 * prevent data-loss from merge conflicts (see ADR-013).
 *
 * If any of these files are gitignored, cleo doctor reports a critical finding.
 */
export const CORE_PROTECTED_FILES = [
  'config.json',
  '.gitignore',
  'project-info.json',
  'project-context.json',
] as const;
