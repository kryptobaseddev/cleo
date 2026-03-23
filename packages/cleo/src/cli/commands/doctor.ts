/**
 * CLI doctor command - system diagnostics.
 * Delegates via dispatch to admin.health handler.
 * --full flag runs operational smoke tests across all domains.
 * @task T4454
 * @task T4795
 * @task T4903
 * @task T5243
 * @task T130
 */

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';
import { createDoctorProgress } from '../progress.js';

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Run system diagnostics and health checks')
    .option('--detailed', 'Show detailed health check results')
    .option('--comprehensive', 'Run comprehensive doctor report')
    .option('--full', 'Run operational smoke tests across all domains')
    .option('--fix', 'Auto-fix failed checks')
    .option('--coherence', 'Run coherence check across task data')
    .action(async (opts: Record<string, unknown>, command: Command) => {
      // Merge citty-parsed opts with global flags (--json, --human, etc.)
      const globalOpts = command.optsWithGlobals ? command.optsWithGlobals() : command.opts();
      const mergedOpts = { ...globalOpts, ...opts };
      const isHuman =
        mergedOpts['human'] === true || (!!process.stdout.isTTY && mergedOpts['json'] !== true);
      const progress = createDoctorProgress(isHuman);

      progress.start();

      try {
        if (mergedOpts['full']) {
          progress.step(0, 'Running operational smoke tests');
          await dispatchFromCli(
            'query',
            'admin',
            'smoke',
            {},
            { command: 'doctor', operation: 'admin.smoke' },
          );
          progress.complete('Smoke tests complete');
        } else if (mergedOpts['coherence']) {
          progress.step(0, 'Running coherence check');
          await dispatchFromCli(
            'query',
            'check',
            'coherence',
            {},
            { command: 'doctor', operation: 'check.coherence' },
          );
          progress.complete('Coherence check complete');
        } else if (mergedOpts['fix']) {
          progress.step(4, 'Applying fixes');
          await dispatchFromCli(
            'mutate',
            'admin',
            'health',
            { mode: 'repair' },
            { command: 'doctor', operation: 'admin.health' },
          );
          progress.complete('Fixes applied');
        } else if (mergedOpts['comprehensive']) {
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
              detailed: mergedOpts['detailed'] as boolean | undefined,
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
