/**
 * CLI check command group — dispatches to the check domain.
 *
 * Provides CLI access to check.schema, check.coherence, check.task,
 * and check.compliance.summary via `cleo check <subcommand>`.
 *
 * @task T132
 */

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

/** Register the check command group. */
export function registerCheckCommand(program: Command): void {
  const check = program.command('check').description('Validation and compliance checks');

  check
    .command('schema <type>')
    .description('Validate schema (type: todo, config, archive, log, sessions)')
    .action(async (type: string) => {
      await dispatchFromCli('query', 'check', 'schema', { type }, { command: 'check' });
    });

  check
    .command('coherence')
    .description('Run coherence check across task data')
    .action(async () => {
      await dispatchFromCli('query', 'check', 'coherence', {}, { command: 'check' });
    });

  check
    .command('task <taskId>')
    .description('Validate a specific task')
    .action(async (taskId: string) => {
      await dispatchFromCli('query', 'check', 'task', { taskId }, { command: 'check' });
    });
}
