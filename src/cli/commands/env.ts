/**
 * CLI env command for environment/mode inspection.
 * @task T4581
 * @epic T4577
 */
// TODO T4894: operation not yet in registry — no admin.env or equivalent dispatch route

import { Command } from 'commander';
import { cliOutput } from '../renderers/index.js';
import { getRuntimeDiagnostics } from '../../core/system/runtime.js';

/**
 * Build the env status response.
 * @task T4581
 */
async function getEnvStatus(): Promise<unknown> {
  return getRuntimeDiagnostics({ detailed: false });
}

/**
 * Build the detailed env info response.
 * @task T4581
 */
async function getEnvInfo(): Promise<unknown> {
  return getRuntimeDiagnostics({ detailed: true });
}

/**
 * Register the env command group.
 * @task T4581
 */
export function registerEnvCommand(program: Command): void {
  const env = program
    .command('env')
    .description('Environment and mode inspection');

  env
    .command('status', { isDefault: true })
    .description('Show current environment mode and runtime info')
    .action(async () => {
      const result = await getEnvStatus();
      cliOutput(result, { command: 'env' });
    });

  env
    .command('info')
    .description('Show detailed environment info including binary paths and compilation status')
    .action(async () => {
      const result = await getEnvInfo();
      cliOutput(result, { command: 'env' });
    });
}
