/**
 * `cleo merge train [--dry-run | --execute]` (T14371): merge every open PR
 * whose required checks are green on its exact head and whose per-AC review
 * passes, one at a time, then run the merge sweep. Dry run by default: prints
 * merge or skip, with the reason, for each open PR.
 *
 * Thin glue over `@cleocode/core/tasks/merge-train.js`.
 *
 * @task T14371
 */

import { getProjectRoot } from '@cleocode/core/paths.js';
import { runMergeTrain } from '@cleocode/core/tasks/merge-train.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliError, cliOutput } from '../renderers/index.js';

const trainCommand = defineCommand({
  meta: {
    name: 'train',
    description:
      'Merge each open PR green on its head, reviewed per AC, whose Closes: lines resolve; ' +
      'serially, then sweep it. Dry run by default; --execute merges',
  },
  args: {
    'dry-run': {
      type: 'boolean',
      description: 'Print merge/skip and why per open PR (the default)',
    },
    execute: {
      type: 'boolean',
      description: 'Merge, rerun infra-only reds and sweep merged PRs',
    },
  },
  async run({ args }) {
    if (args.execute === true && args['dry-run'] === true) {
      cliError('--dry-run and --execute are exclusive', 6, { name: 'E_VALIDATION' });
      process.exitCode = 6;
      return;
    }
    const result = await runMergeTrain(getProjectRoot(), { execute: args.execute === true });
    cliOutput(result, { command: 'merge', operation: 'merge.train' });
    if (result.stopped !== undefined) process.exitCode = 1;
  },
});

/** `cleo merge` root command. */
export const mergeCommand = defineCommand({
  meta: {
    name: 'merge',
    description: 'Merge open PRs that are green and reviewed on their exact head (train)',
  },
  subCommands: { train: trainCommand },
});
