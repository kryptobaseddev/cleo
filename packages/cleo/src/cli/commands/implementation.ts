/**
 * CLI command group for implementation protocol validation.
 *
 * Dispatches to `check.protocol` with `protocolType: 'implementation'`.
 *
 * @deprecated This command is deprecated. Use `cleo check protocol implementation` directly.
 * @task T4537
 * @epic T4454
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/** cleo implementation validate <taskId> — validate implementation protocol for a task */
const validateCommand = defineCommand({
  meta: {
    name: 'validate',
    description: 'Validate implementation protocol compliance for task',
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
        protocolType: 'implementation',
        mode: 'task',
        taskId: args.taskId,
        strict: args.strict,
      },
      { command: 'implementation' },
    );
  },
});

/** cleo implementation check <manifestFile> — validate a manifest entry directly */
const checkCommand = defineCommand({
  meta: {
    name: 'check',
    description: 'Validate manifest entry directly',
  },
  args: {
    manifestFile: {
      type: 'positional',
      description: 'Path to manifest file to validate',
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
        protocolType: 'implementation',
        mode: 'manifest',
        manifestFile: args.manifestFile,
        strict: args.strict,
      },
      { command: 'implementation' },
    );
  },
});

/**
 * Root implementation command group — validates implementation protocol compliance.
 *
 * DEPRECATED: prefer `cleo check protocol implementation` directly.
 */
export const implementationCommand = defineCommand({
  meta: {
    name: 'implementation',
    description:
      '[DEPRECATED] Validate implementation protocol compliance (use `cleo check protocol implementation`)',
  },
  subCommands: {
    validate: validateCommand,
    check: checkCommand,
  },
});
