/**
 * CLI command group: cleo consensus — consensus protocol validation.
 *
 * Alias for `cleo check protocol consensus`. Routes through the dispatch
 * layer to the `check.protocol` operation with `protocolType:'consensus'`.
 *
 * Subcommands:
 *   cleo consensus validate <taskId>    — validate task protocol compliance
 *   cleo consensus check <manifestFile> — validate a manifest entry directly
 *
 * @task T4537
 * @epic T4454
 */

import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/** cleo consensus validate — validate consensus protocol compliance for a task */
const validateCommand = defineCommand({
  meta: {
    name: 'validate',
    description: 'Validate consensus protocol compliance for task',
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
    'voting-matrix': {
      type: 'string',
      description: 'Path to voting matrix JSON file',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'check',
      'protocol',
      {
        protocolType: 'consensus',
        mode: 'task',
        taskId: args.taskId,
        strict: args.strict,
        votingMatrixFile: args['voting-matrix'] as string | undefined,
      },
      { command: 'consensus' },
    );
  },
});

/** cleo consensus check — validate a manifest entry directly */
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
    'voting-matrix': {
      type: 'string',
      description: 'Path to voting matrix JSON file',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'check',
      'protocol',
      {
        protocolType: 'consensus',
        mode: 'manifest',
        manifestFile: args.manifestFile,
        strict: args.strict,
        votingMatrixFile: args['voting-matrix'] as string | undefined,
      },
      { command: 'consensus' },
    );
  },
});

/**
 * Root consensus command group.
 *
 * Alias for `cleo check protocol consensus`. Validates consensus protocol
 * compliance for tasks or manifest entries.
 */
export const consensusCommand = defineCommand({
  meta: {
    name: 'consensus',
    description:
      'Validate consensus protocol compliance (alias for `cleo check protocol consensus`)',
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
