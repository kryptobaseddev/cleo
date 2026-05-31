/**
 * Gateway-level path constants shared by domain handlers.
 *
 * @remarks
 * The `orchestrate` and `admin` (smoke-provider) domain handlers join a handful
 * of well-known `.cleo/` path segments when locating workflow definitions and
 * the BRAIN database. Those constants were previously defined in
 * `packages/cleo/src/cli/paths.ts` (a CLI-internal leaf), which coupled the
 * handler subgraph to `@cleocode/cleo`.
 *
 * To let `@cleocode/runtime` assemble the handler map WITHOUT importing
 * `@cleocode/cleo` (R3-K1 · T11455 · SG-RUNTIME-UNIFICATION), the constants the
 * handlers actually consume are hosted here as the canonical source. The
 * CLI-side `cli/paths.ts` re-exports them so the rest of the CLI (backup /
 * restore / doctor) keeps importing from its established surface — there is a
 * single definition, no drift.
 *
 * @task T090
 * @task T11455
 */

/** Name of the project-local CLEO data directory (`.cleo`). */
export const CLEO_DIR_NAME = '.cleo' as const;

/** Subdirectory under `.cleo/` that stores CANT workflow definitions. */
export const WORKFLOWS_SUBDIR = 'workflows' as const;

/** Project-local SQLite database filename for cognitive memory (BRAIN). */
export const BRAIN_DB_FILENAME = 'brain.db' as const;
