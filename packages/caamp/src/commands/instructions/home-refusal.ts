/**
 * `caamp instructions inject` / `update` refuse a project-scope run at the
 * home directory (T13257): providers load instruction files from every
 * ancestor directory, so `~/AGENTS.md`, `~/CLAUDE.md` or `~/GEMINI.md` would
 * reach every session under `$HOME`.
 *
 * @task T13257
 */

import pc from 'picocolors';
import { ErrorCategories, ErrorCodes, emitJsonError, type MVILevel } from '../../core/lafs.js';

/** The refusal message for a project-scope run at `$HOME`. */
export const HOME_PROJECT_MESSAGE =
  'Refusing to write project instruction files in your home directory: providers load ' +
  'them from every ancestor directory, so they would apply to every project under it. ' +
  'Run this inside a project directory, or pass --global for the global instruction files.';

/**
 * Report the refusal (a LAFS error envelope, or a red line for humans) and
 * exit 1. Nothing has been written.
 *
 * @param operation - the LAFS operation name.
 * @param mvi - the MVI disclosure flag of the command.
 * @param format - the resolved output format.
 */
export function refuseHomeProject(
  operation: string,
  mvi: MVILevel,
  format: 'json' | 'human',
): never {
  if (format === 'json') {
    emitJsonError(
      operation,
      mvi,
      ErrorCodes.HOME_INSTRUCTION_FILE,
      HOME_PROJECT_MESSAGE,
      ErrorCategories.VALIDATION,
    );
  } else {
    console.error(pc.red(HOME_PROJECT_MESSAGE));
  }
  process.exit(1);
}
