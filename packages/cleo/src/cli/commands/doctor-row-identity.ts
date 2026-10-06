/**
 * `cleo doctor row-identity` — the explicit from-scratch identity refill of a
 * store whose identity predates the current recipe (T13231).
 *
 * A dry run by default: the share verdict, its evidence (the local link,
 * vault and journal state, and what Cleo Nexus answered, read-only, with this
 * machine's device credential) and the rows the refill would clear. `--refill
 * --apply` refills only when the verdict is `unshared`: it takes a pre-refill
 * `VACUUM INTO` snapshot first and prints how to undo it.
 *
 * @task T13231
 */

import { getProjectRoot } from '@cleocode/core/paths.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliOutput } from '../renderers/index.js';

/**
 * `cleo doctor row-identity` subcommand. Exits 1 when a due refill is refused,
 * or when `--apply` did not refill.
 *
 * @task T13231
 */
export const doctorRowIdentityCommand = defineCommand({
  meta: {
    name: 'row-identity',
    description:
      'Plan the from-scratch row-identity refill of a store whose identity predates the current ' +
      'recipe: the share verdict, its evidence (link, vault state, journal state, and whether Cleo ' +
      'Nexus holds any checkpoint of the project, asked read-only) and the rows it clears. ' +
      '--refill --apply runs it when the store is provably unshared, after a snapshot.',
  },
  args: {
    refill: { type: 'boolean', description: 'Plan the full refill (a dry run without --apply)' },
    apply: {
      type: 'boolean',
      description:
        'With --refill: snapshot the store, then re-derive every identity value from scratch. ' +
        'Refused unless the verdict is unshared and CLEO_ROW_UID_FILL=1',
    },
    json: { type: 'boolean', description: 'Output as JSON' },
    human: { type: 'boolean', description: 'Force human-readable output' },
    quiet: { type: 'boolean', description: 'Suppress non-essential output' },
  },
  async run({ args }) {
    const { rowIdentityRefill } = await import('@cleocode/core/doctor/row-identity-refill.js');
    const apply = args.refill === true && args.apply === true;
    const report = await rowIdentityRefill(getProjectRoot(), { apply });
    cliOutput(report, {
      command: 'doctor',
      operation: apply ? 'doctor.row-identity.refill' : 'doctor.row-identity.plan',
    });
    const failed =
      report.action === 'refuse' || (apply && !report.applied && report.action !== 'none');
    if (failed && (process.exitCode ?? 0) === 0) process.exitCode = 1;
  },
});
