/**
 * CLI doctor command - system diagnostics.
 * Delegates via dispatch to admin.health handler.
 * @task T4454
 * @task T4795
 * @task T4903
 * @task T5243
 */

import type { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import { createDoctorProgress } from '../progress.js';

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Run system diagnostics and health checks')
    .option('--detailed', 'Show detailed health check results')
    .option('--comprehensive', 'Run comprehensive doctor report')
    .option('--fix', 'Auto-fix failed checks')
    .option('--coherence', 'Run coherence check across task data')
    .action(async (_opts: Record<string, unknown>, command: Command) => {
      const opts = command.optsWithGlobals ? command.optsWithGlobals() : command.opts();
      const isHuman = opts['human'] === true || (!!process.stdout.isTTY && opts['json'] !== true);
      const progress = createDoctorProgress(isHuman);

      progress.start();

      try {
        if (opts['coherence']) {
          progress.step(0, 'Running coherence check');
          await dispatchFromCli(
            'query',
            'check',
            'coherence',
            {},
            { command: 'doctor', operation: 'check.coherence' },
          );
          progress.complete('Coherence check complete');
        } else if (opts['fix']) {
          progress.step(4, 'Applying fixes');
          await dispatchFromCli(
            'mutate',
            'admin',
            'health',
            { mode: 'repair' },
            { command: 'doctor', operation: 'admin.health' },
          );
          progress.complete('Fixes applied');
        } else if (opts['comprehensive']) {
          progress.step(0, 'Checking CLEO directory');
          await dispatchFromCli(
            'query',
            'admin',
            'health',
            { mode: 'diagnose' },
            { command: 'doctor', operation: 'admin.health' },
          );
          progress.complete('Comprehensive diagnostics complete');
        } else {
          progress.step(0, 'Checking CLEO directory');
          await dispatchFromCli(
            'query',
            'admin',
            'health',
            {
              detailed: opts['detailed'] as boolean | undefined,
            },
            { command: 'doctor', operation: 'admin.health' },
          );
          progress.complete('Health check complete');
        }
      } catch (err) {
        progress.error('Health check failed');
        throw err;
      }
    });
}
