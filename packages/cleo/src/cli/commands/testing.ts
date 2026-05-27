/**
 * CLI testing command group — validate testing protocol compliance.
 *
 * Ported from scripts/testing.sh
 *
 * Commands:
 *   cleo testing validate <taskId>         — validate testing protocol for a task
 *   cleo testing check <manifestFile>      — validate from a manifest file
 *   cleo testing status                    — show test suite status
 *   cleo testing coverage                  — show test coverage
 *   cleo testing run                       — run test suite
 *
 * @task T4551
 * @epic T4545
 */

import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/** cleo testing validate — validate testing protocol compliance for a task */
const validateCommand = defineCommand({
  meta: { name: 'validate', description: 'Validate testing protocol compliance for a task' },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID to validate testing protocol for',
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
        protocolType: 'testing',
        mode: 'task',
        taskId: args.taskId,
        strict: !!args.strict,
      },
      { command: 'testing', operation: 'check.protocol' },
    );
  },
});

/** cleo testing check — validate testing protocol from a manifest file */
const checkCommand = defineCommand({
  meta: { name: 'check', description: 'Validate testing protocol from a manifest file' },
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
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'check',
      'manifest',
      {
        file: args.manifestFile,
        strict: !!args.strict,
        type: 'testing',
      },
      { command: 'testing', operation: 'check.manifest' },
    );
  },
});

/** cleo testing status — show test suite status */
const statusCommand = defineCommand({
  meta: { name: 'status', description: 'Show test suite status' },
  async run() {
    await dispatchFromCli(
      'query',
      'check',
      'test',
      { format: 'status' },
      { command: 'testing', operation: 'check.test' },
    );
  },
});

/** cleo testing coverage — show test coverage */
const coverageCommand = defineCommand({
  meta: { name: 'coverage', description: 'Show test coverage' },
  async run() {
    await dispatchFromCli(
      'query',
      'check',
      'test',
      { format: 'coverage' },
      { command: 'testing', operation: 'check.test' },
    );
  },
});

/** cleo testing run — run the test suite */
const runCommand = defineCommand({
  meta: { name: 'run', description: 'Run test suite' },
  args: {
    filter: {
      type: 'string',
      description: 'Filter tests by pattern',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'check',
      'test.run',
      { filter: args.filter as string | undefined },
      { command: 'testing', operation: 'check.test.run' },
    );
  },
});

/**
 * Root testing command group — registers all testing subcommands.
 *
 * Dispatches to `check.*` registry operations.
 */
export const testingCommand = defineCommand({
  meta: { name: 'testing', description: 'Validate testing protocol compliance' },
  subCommands: {
    validate: validateCommand,
    check: checkCommand,
    status: statusCommand,
    coverage: coverageCommand,
    run: runCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
