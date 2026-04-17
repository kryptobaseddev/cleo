/**
 * CLI decomposition command - decomposition protocol validation.
 * Routes through dispatch layer to check.protocol.decomposition.
 * @task T4537
 * @epic T4454
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/** cleo decomposition validate <taskId> — validate decomposition protocol for a task */
const validateCommand = defineCommand({
  meta: {
    name: 'validate',
    description: 'Validate decomposition protocol compliance for task',
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
    epic: {
      type: 'string',
      description: 'Specify parent epic ID',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'check',
      'protocol',
      {
        protocolType: 'decomposition',
        mode: 'task',
        taskId: args.taskId,
        strict: args.strict,
        epicId: args.epic,
      },
      { command: 'decomposition' },
    );
  },
});

/** cleo decomposition check <manifestFile> — validate manifest entry directly */
const checkCommand = defineCommand({
  meta: {
    name: 'check',
    description: 'Validate manifest entry directly',
  },
  args: {
    manifestFile: {
      type: 'positional',
      description: 'Manifest file to validate',
      required: true,
    },
    strict: {
      type: 'boolean',
      description: 'Exit with error code on violations',
    },
    epic: {
      type: 'string',
      description: 'Specify parent epic ID',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'check',
      'protocol',
      {
        protocolType: 'decomposition',
        mode: 'manifest',
        manifestFile: args.manifestFile,
        strict: args.strict,
        epicId: args.epic,
      },
      { command: 'decomposition' },
    );
  },
});

/**
 * Root decomposition command group — validates decomposition protocol compliance.
 *
 * Alias for `cleo check protocol decomposition`.
 */
export const decompositionCommand = defineCommand({
  meta: {
    name: 'decomposition',
    description:
      'Validate decomposition protocol compliance (alias for `cleo check protocol decomposition`)',
  },
  subCommands: {
    validate: validateCommand,
    check: checkCommand,
  },
});
