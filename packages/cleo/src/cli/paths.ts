/**
 * CLI-level path constants for the CLEO CLI package.
 *
 * Centralizes all magic strings for:
 *   - Database filenames (tasks.db, brain.db, conduit.db, nexus.db, signaldock.db)
 *   - JSON config filenames (config.json, project-info.json, project-context.json)
 *   - Project-local file lists used by backup / restore / doctor commands
 *   - Internal subdirectory names under .cleo/
 *   - CLI-level temporary/report filenames
 *
 * All path construction delegates to `@cleocode/core/internal` path helpers so
 * that `CLEO_DIR`, `CLEO_ROOT`, and worktree-scope overrides are honoured. This
 * file MUST NOT import from other files inside `packages/cleo/src/` to avoid
 * circular-import risk (it is a pure constants/helpers leaf module).
 *
 * @task T090
 */

// ============================================================================
// Directory names
// ============================================================================

/** Name of the project-local CLEO data directory. */
export const CLEO_DIR_NAME = '.cleo' as const;

/** Subdirectory under .cleo/ that stores internal-state files for context tracking. */
export const CONTEXT_STATES_SUBDIR = 'context-states' as const;

/** Subdirectory under .cleo/ that stores CANT agent definition files. */
export const AGENTS_SUBDIR = 'agents' as const;

/** Subdirectory under .cleo/ that stores CANT workflow files (legacy path). */
export const CANT_AGENTS_SUBDIR = 'cant/agents' as const;

/** Subdirectory under .cleo/ that stores CANT workflow definitions. */
export const WORKFLOWS_SUBDIR = 'workflows' as const;

/** Subdirectory under .cleo/ for metrics data (e.g. COMPLIANCE.jsonl). */
export const METRICS_SUBDIR = 'metrics' as const;

/** Subdirectory under .cleo/ for locally-installed template overrides. */
export const TEMPLATES_SUBDIR = 'templates' as const;

/** Subdirectory under .cleo/ for operational backups (legacy simple backups). */
export const BACKUPS_OPERATIONAL_SUBDIR = 'backups/operational' as const;

/** Subdirectory used during a backup import to stage restored JSON files. */
export const RESTORE_IMPORTED_SUBDIR = 'restore-imported' as const;

// ============================================================================
// Database filenames
// ============================================================================

/** Project-local SQLite database for task data. */
export const TASKS_DB_FILENAME = 'tasks.db' as const;

/** Project-local SQLite database for cognitive memory (BRAIN). */
export const BRAIN_DB_FILENAME = 'brain.db' as const;

/** Project-local SQLite database for inter-agent messaging (CONDUIT). */
export const CONDUIT_DB_FILENAME = 'conduit.db' as const;

/** Global-tier SQLite database for code intelligence (NEXUS). */
export const NEXUS_DB_FILENAME = 'nexus.db' as const;

/** Global-tier SQLite database for agent identity (SIGNALDOCK). */
export const SIGNALDOCK_DB_FILENAME = 'signaldock.db' as const;

// ============================================================================
// JSON / Markdown config filenames
// ============================================================================

/** Project configuration file. */
export const CONFIG_JSON = 'config.json' as const;

/** Project identity metadata file. */
export const PROJECT_INFO_JSON = 'project-info.json' as const;

/** LLM-hint project context file (auto-detected). */
export const PROJECT_CONTEXT_JSON = 'project-context.json' as const;

/** Conflict report produced by `cleo backup import` for manual resolution. */
export const RESTORE_CONFLICTS_MD = 'restore-conflicts.md' as const;

/** State hash file written by the MEMORY.md migration process. */
export const MIGRATE_MEMORY_HASHES_JSON = 'migrate-memory-hashes.json' as const;

/** Compliance metrics append-only log. */
export const COMPLIANCE_JSONL = 'COMPLIANCE.jsonl' as const;

/** CLEO-INJECTION.md canonical template filename. */
export const CLEO_INJECTION_MD = 'CLEO-INJECTION.md' as const;

// ============================================================================
// Backup / restore file lists
// ============================================================================

/**
 * Project-relative paths for all files included in a project backup.
 *
 * These are the paths passed to `checkForExistingData` and `packBundle` when
 * building or verifying a project-scoped backup bundle. Each entry is relative
 * to the project root so that callers can join them with `path.join(root, f)`.
 */
export const CLI_PROJECT_BACKUP_FILES = [
  `${CLEO_DIR_NAME}/${TASKS_DB_FILENAME}`,
  `${CLEO_DIR_NAME}/${BRAIN_DB_FILENAME}`,
  `${CLEO_DIR_NAME}/${CONDUIT_DB_FILENAME}`,
  `${CLEO_DIR_NAME}/${CONFIG_JSON}`,
  `${CLEO_DIR_NAME}/${PROJECT_INFO_JSON}`,
  `${CLEO_DIR_NAME}/${PROJECT_CONTEXT_JSON}`,
] as const;

/**
 * Filenames for global-tier databases included in a global backup.
 *
 * These are plain filenames resolved against `cleoHome` (not project root).
 */
export const CLI_GLOBAL_BACKUP_FILES = [NEXUS_DB_FILENAME, SIGNALDOCK_DB_FILENAME] as const;

/**
 * Set of JSON config filenames that are valid targets for `cleo restore backup`.
 *
 * Used by both the conflict-report parser and the restore command to validate
 * caller-supplied filenames.
 */
export const RESTORE_VALID_JSON_FILENAMES: Set<string> = new Set([
  CONFIG_JSON,
  PROJECT_INFO_JSON,
  PROJECT_CONTEXT_JSON,
]);

/**
 * Default filename used when `cleo restore backup` is called without `--file`.
 */
export const RESTORE_DEFAULT_FILE = TASKS_DB_FILENAME;
