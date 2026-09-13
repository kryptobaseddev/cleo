/**
 * `cleo doctor malformed-ids` — find and remove task rows the CLI cannot address.
 *
 * A task id was written that no read path accepts (`id='/mnt/projects/cleocode'`
 * in a live store). `cleo list` enumerates such a row, while `show`, `update`
 * and `delete` all reject the id as malformed before reaching the store — so
 * the ordinary way to remove a bad row cannot be used on exactly the rows that
 * need removing. T12128 closed the write path; this addresses rows already
 * written.
 *
 * Read-only unless `--fix` is given.
 *
 * @task T12128
 */

import { getProjectRoot } from '@cleocode/core';
import { scanMalformedTaskIds } from '@cleocode/core/doctor/malformed-task-ids.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliOutput } from '../renderers/index.js';

/**
 * `cleo doctor malformed-ids` subcommand.
 *
 * Exits non-zero when unaddressable rows remain, so it can gate a cleanup step.
 * After a successful `--fix` the rows are gone and the exit code is 0.
 *
 * @task T12128
 */
export const doctorMalformedIdsCommand = defineCommand({
  meta: {
    name: 'malformed-ids',
    description:
      'Report task rows whose id is not a valid task identifier — rows that `cleo list` returns ' +
      'but `show`/`update`/`delete` cannot address. Read-only unless --fix is given; --fix ' +
      'refuses any row other tables still reference, and reports them instead.',
  },
  args: {
    fix: {
      type: 'boolean',
      description:
        'Delete unaddressable rows in one transaction. Refuses any row still referenced by ' +
        'another table — deleting those would manufacture the orphans `doctor fk-check` detects.',
    },
    json: { type: 'boolean', description: 'Output as JSON' },
    human: { type: 'boolean', description: 'Force human-readable output' },
    quiet: { type: 'boolean', description: 'Suppress non-essential output' },
  },
  async run({ args }) {
    const report = await scanMalformedTaskIds(getProjectRoot(), { fix: args.fix === true });

    cliOutput(report, {
      command: 'doctor',
      operation: 'doctor.malformed-ids.run',
    });

    // Refused rows are unresolved by definition — `--fix` ran and declined.
    const unresolved = report.rows.length > 0 && !report.deleted;
    if (unresolved && (process.exitCode === undefined || process.exitCode === 0)) {
      process.exitCode = 1;
    }
  },
});
