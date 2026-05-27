/**
 * T310-readiness gate: detect conduit.db vs legacy signaldock.db at project tier.
 *
 * T311 backup/restore code paths reference `.cleo/conduit.db` (project tier) and
 * `$XDG_DATA_HOME/cleo/signaldock.db` (global tier) per ADR-037. A project that
 * has not yet been migrated (still has `.cleo/signaldock.db` without a
 * `.cleo/conduit.db`) will confuse T311 export/import commands. This gate runs
 * as a precondition on every T311 CLI verb.
 *
 * @task T342
 * @epic T311
 * @why T311 export/import references .cleo/conduit.db (project tier) and
 *      $XDG_DATA_HOME/cleo/signaldock.db (global tier) per ADR-037.
 *      If the current project is still on the pre-T310 topology, T311
 *      commands must surface a clear error telling the user to run a
 *      cleo command first to trigger migration.
 * @what Throws T310MigrationRequiredError with instructions if legacy
 *       signaldock.db exists AND conduit.db does not.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectRoot } from '../paths.js';

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Thrown by `assertT310Ready` when the current project is still on the
 * pre-T310 topology: `.cleo/signaldock.db` is present but `.cleo/conduit.db`
 * is absent. T311 commands cannot proceed until migration has run.
 *
 * @task T342
 * @epic T311
 */
export class T310MigrationRequiredError extends Error {
  /**
   * @param projectRoot - Absolute path to the project root that needs migration.
   */
  constructor(public readonly projectRoot: string) {
    super(
      `T310 migration required: .cleo/signaldock.db still exists at ${projectRoot} ` +
        `without a .cleo/conduit.db. Run any cleo command from within the project ` +
        `(e.g. \`cleo version\`) to trigger the automatic T310 migration, then retry.`,
    );
    this.name = 'T310MigrationRequiredError';
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Asserts the current project is on the post-T310 topology. Does nothing
 * if conduit.db exists (migration already ran) OR if no legacy signaldock.db
 * exists (fresh install — no migration needed).
 *
 * Throws when legacy signaldock.db is present AND conduit.db is absent,
 * which indicates the project has not yet been migrated to the T310 topology
 * expected by T311 backup/restore commands.
 *
 * @param projectRoot - Absolute path to the project root. Defaults to
 *   `getProjectRoot()` (walks ancestors for `.cleo/` sentinel).
 * @throws {T310MigrationRequiredError} if legacy signaldock.db exists
 *   without conduit.db at the project tier.
 *
 * @task T342
 * @epic T311
 *
 * @example
 * ```typescript
 * // Precondition guard at the top of every T311 CLI verb handler:
 * assertT310Ready();
 * ```
 */
export function assertT310Ready(projectRoot?: string): void {
  const root = projectRoot ?? getProjectRoot();
  const legacyPath = join(root, '.cleo', 'signaldock.db');
  const conduitPath = join(root, '.cleo', 'conduit.db');

  if (existsSync(legacyPath) && !existsSync(conduitPath)) {
    throw new T310MigrationRequiredError(root);
  }
}

/**
 * Returns true if T311 commands can safely run on the current project.
 *
 * This is the non-throwing companion to `assertT310Ready`. Returns false
 * only when the pre-T310 topology is detected (legacy signaldock.db exists
 * without conduit.db). All other states — fresh installs, fully-migrated
 * projects — return true.
 *
 * @param projectRoot - Absolute path to the project root. Defaults to
 *   `getProjectRoot()` (walks ancestors for `.cleo/` sentinel).
 * @returns `true` if the project is on the post-T310 topology or is a fresh
 *   install; `false` if migration is required.
 *
 * @task T342
 * @epic T311
 *
 * @example
 * ```typescript
 * if (!isT310Ready()) {
 *   console.error('Run `cleo version` to trigger T310 migration first.');
 * }
 * ```
 */
export function isT310Ready(projectRoot?: string): boolean {
  try {
    assertT310Ready(projectRoot);
    return true;
  } catch (err) {
    if (err instanceof T310MigrationRequiredError) return false;
    throw err;
  }
}
