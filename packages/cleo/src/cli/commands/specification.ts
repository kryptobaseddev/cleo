/**
 * CLI specification command group — specification protocol validation.
 *
 * Routes through the dispatch layer to check.protocol.specification.
 *
 * DEPRECATED: This command is a thin alias for `cleo check protocol specification`.
 * Prefer using `cleo check protocol specification` directly.
 *
 * @task T4537
 * @epic T4454
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/** cleo specification validate <taskId> — validate specification protocol compliance for a task */
const validateCommand = defineCommand({
  meta: {
    name: 'validate',
    description: 'Validate specification protocol compliance for task',
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
    'spec-file': {
      type: 'string',
      description: 'Path to specification file',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'check',
      'protocol',
      {
        protocolType: 'specification',
        mode: 'task',
        taskId: args.taskId,
        strict: args.strict,
        specFile: args['spec-file'] as string | undefined,
      },
      { command: 'specification' },
    );
  },
});

/** cleo specification check <manifestFile> — validate manifest entry directly */
const checkCommand = defineCommand({
  meta: {
    name: 'check',
    description: 'Validate manifest entry directly',
  },
  args: {
    manifestFile: {
      type: 'positional',
      description: 'Path to the manifest file to validate',
      required: true,
    },
    strict: {
      type: 'boolean',
      description: 'Exit with error code on violations',
    },
    'spec-file': {
      type: 'string',
      description: 'Path to specification file',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'check',
      'protocol',
      {
        protocolType: 'specification',
        mode: 'manifest',
        manifestFile: args.manifestFile,
        strict: args.strict,
        specFile: args['spec-file'] as string | undefined,
      },
      { command: 'specification' },
    );
  },
});

/**
 * Root specification command group — validate specification protocol compliance.
 *
 * DEPRECATED: Alias for `cleo check protocol specification`. Prefer the canonical form.
 */
export const specificationCommand = defineCommand({
  meta: {
    name: 'specification',
    description:
      'Validate specification protocol compliance (alias for `cleo check protocol specification`) [DEPRECATED]',
  },
  subCommands: {
    validate: validateCommand,
    check: checkCommand,
  },
});
