/**
 * CLI `skill` (singular) command group — single-skill operations.
 *
 *   cleo skill restore <name>   — restore a previously-archived skill
 *
 * The `skill` (singular) group is intentionally narrow: it hosts verbs that
 * act on ONE named skill at a time. The plural `skills` command group hosts
 * the registry-level surface (list, search, doctor, …). Keeping these two
 * groups separate mirrors the Hermes naming convention (`hermes skill
 * restore <name>` vs `hermes skills list`) and avoids overloading `skills
 * restore` to look like a bulk operation.
 *
 * @task T9687, T9562
 * @epic T9562
 * @saga T9560
 */

import { defineCommand } from 'citty';
import { isSubCommandDispatch } from '../lib/subcommand-guard.js';
import { cliError, cliOutput } from '../renderers/index.js';

/**
 * `cleo skill restore <name>` — restore an archived skill from `.archive/`.
 *
 * @remarks
 * Wraps `restoreSkillFromArchive` from `@cleocode/core/sentient/curator.js`.
 * Picks the most recent archive entry when multiple exist for the same name
 * (largest `-<unix-ms>` suffix wins) and refuses to clobber an existing live
 * install path.
 *
 * Exit codes:
 *   - `0` on success
 *   - `1` on any error (no archive found, refuse-to-clobber, IO failure)
 *
 * Failure modes are surfaced with `E_RESTORE_FAILED` so JSON consumers can
 * branch on the LAFS error code without parsing the human message.
 */
const restoreCommand = defineCommand({
  meta: {
    name: 'restore',
    description: 'Restore a previously-archived skill from ~/.cleo/skills/.archive/',
  },
  args: {
    'skill-name': {
      type: 'positional',
      description: 'Name of the archived skill to restore',
      required: true,
    },
  },
  async run({ args }) {
    const name = args['skill-name'];
    try {
      const { restoreSkillFromArchive } = await import('@cleocode/core/sentient/curator.js');

      const result = await restoreSkillFromArchive(name);

      cliOutput(
        {
          name: result.name,
          restoredTo: result.restoredTo,
          restoredFrom: result.restoredFrom,
          restoredAt: result.restoredAt,
        },
        {
          command: 'skill restore',
          operation: 'skill.restore',
          message: `restored ${result.name} → ${result.restoredTo}`,
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      cliError(message, 'E_RESTORE_FAILED', undefined, { operation: 'skill.restore' });
      process.exit(1);
    }
  },
});

/**
 * Root singular `skill` command group.
 */
export const skillCommand = defineCommand({
  meta: {
    name: 'skill',
    description: 'Single-skill operations (restore, …)',
  },
  subCommands: {
    restore: restoreCommand,
  },
  async run({ cmd, rawArgs }) {
    if (isSubCommandDispatch(rawArgs, cmd.subCommands)) return;
    process.stdout.write(
      'usage: cleo skill restore <name>\n' +
        '       see `cleo skill --help` for the full list of single-skill verbs.\n',
    );
  },
});
