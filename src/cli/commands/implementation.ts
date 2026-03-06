/**
 * CLI implementation command - implementation protocol validation.
 * Routes through dispatch layer to check.protocol.implementation.
 * @task T4537
 * @epic T4454
 */

import { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Register the implementation command group.
 * @task T4537
 */
export function registerImplementationCommand(program: Command): void {
  const implementation = program
    .command('implementation')
    .description('Validate implementation protocol compliance for code tasks');

  implementation
    .command('validate <taskId>')
    .description('Validate implementation protocol compliance for task')
    .option('--strict', 'Exit with error code on violations')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      await dispatchFromCli('query', 'check', 'protocol.implementation', {
        mode: 'task',
        taskId,
        strict: opts['strict'] as boolean | undefined,
      }, { command: 'implementation' });
    });

  implementation
    .command('check <manifestFile>')
    .description('Validate manifest entry directly')
    .option('--strict', 'Exit with error code on violations')
    .action(async (manifestFile: string, opts: Record<string, unknown>) => {
      await dispatchFromCli('query', 'check', 'protocol.implementation', {
        mode: 'manifest',
        manifestFile,
        strict: opts['strict'] as boolean | undefined,
      }, { command: 'implementation' });
    });
}
