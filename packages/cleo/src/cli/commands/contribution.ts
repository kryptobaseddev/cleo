/**
 * CLI command group: cleo contribution — contribution protocol validation.
 *
 * Alias for `cleo check protocol contribution`. Routes through the dispatch
 * layer to the `check.protocol` operation with `protocolType:'contribution'`.
 *
 * Subcommands:
 *   cleo contribution validate <taskId>    — validate task protocol compliance
 *   cleo contribution check <manifestFile> — validate a manifest entry directly
 *
 * @task T4537
 * @epic T4454
 */

import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/** cleo contribution validate — validate contribution protocol compliance for a task */
const validateCommand = defineCommand({
  meta: {
    name: 'validate',
    description: 'Validate contribution protocol compliance for task',
  },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID to validate',
      required: true,
    },
    strict: {
      type: 'boolean',
      description: 'Exit with error code on violations',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'check',
      'protocol',
      {
        protocolType: 'contribution',
        mode: 'task',
        taskId: args.taskId,
        strict: args.strict,
      },
      { command: 'contribution' },
    );
  },
});

/** cleo contribution check — validate a manifest entry directly */
const checkCommand = defineCommand({
  meta: {
    name: 'check',
    description: 'Validate manifest entry directly',
  },
  args: {
    manifestFile: {
      type: 'positional',
      description: 'Path to manifest file',
      required: true,
    },
    strict: {
      type: 'boolean',
      description: 'Exit with error code on violations',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'check',
      'protocol',
      {
        protocolType: 'contribution',
        mode: 'manifest',
        manifestFile: args.manifestFile,
        strict: args.strict,
      },
      { command: 'contribution' },
    );
  },
});

/**
 * Root contribution command group.
 *
 * Alias for `cleo check protocol contribution`. Validates contribution
 * protocol compliance for tasks or manifest entries.
 */
export const contributionCommand = defineCommand({
  meta: {
    name: 'contribution',
    description:
      'Validate contribution protocol compliance (alias for `cleo check protocol contribution`)',
  },
  subCommands: {
    validate: validateCommand,
    check: checkCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
