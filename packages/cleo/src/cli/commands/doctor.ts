/**
 * CLI doctor command - system diagnostics.
 * Delegates via dispatch to admin.health handler.
 * --full flag runs operational smoke tests across all domains.
 * --hooks flag shows the cross-provider hook support matrix via CAAMP.
 * @task T4454
 * @task T4795
 * @task T4903
 * @task T5243
 * @task T130
 * @task T167
 */

import { dispatchFromCli, dispatchRaw } from '../../dispatch/adapters/cli.js';
import type { HookMatrixResult } from '../../dispatch/engines/hooks-engine.js';
import type { ShimCommand as Command } from '../commander-shim.js';
import { createDoctorProgress } from '../progress.js';

/**
 * Render the hook matrix as a human-readable provider x event grid.
 *
 * Prints a table with events as rows and provider IDs as columns,
 * then a coverage summary line at the bottom.
 *
 * @param data - Hook matrix result from CAAMP
 */
function renderHookMatrixHuman(data: HookMatrixResult): void {
  const { events, providers, matrix, summary, caampVersion, detectedProvider } = data;

  process.stdout.write(`\nProvider Hook Matrix (CAAMP ${caampVersion} canonical taxonomy)\n\n`);

  if (detectedProvider) {
    process.stdout.write(`Detected provider: ${detectedProvider}\n\n`);
  }

  if (providers.length === 0) {
    process.stdout.write('No providers found in CAAMP registry.\n');
    return;
  }

  // Column widths
  const EVENT_COL = Math.max(...events.map((e) => e.length), 'Event'.length);
  // Each provider column: max(providerId.length, 5) + padding
  const provCols = providers.map((p) => Math.max(p.length, 5));

  // Header row
  const headerParts = [
    'Event'.padEnd(EVENT_COL),
    ...providers.map((p, i) => p.padEnd(provCols[i]!)),
  ];
  process.stdout.write(`  ${headerParts.join('  ')}\n`);

  // Separator
  const sepParts = ['-'.repeat(EVENT_COL), ...provCols.map((w) => '-'.repeat(w))];
  process.stdout.write(`  ${sepParts.join('  ')}\n`);

  // Event rows
  for (const event of events) {
    const cells = providers.map((p, i) => {
      const supported = matrix[event]?.[p] === true;
      const symbol = supported ? '\u2713' : '-';
      return symbol.padEnd(provCols[i]!);
    });
    process.stdout.write(`  ${event.padEnd(EVENT_COL)}  ${cells.join('  ')}\n`);
  }

  // Coverage summary
  process.stdout.write('\n');
  const coverageParts = summary.map(
    (s) => `${s.providerId} ${s.supportedCount}/${s.totalCanonical} (${s.coverage}%)`,
  );
  process.stdout.write(`Coverage: ${coverageParts.join(', ')}\n\n`);
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Run system diagnostics and health checks')
    .option('--detailed', 'Show detailed health check results')
    .option('--comprehensive', 'Run comprehensive doctor report')
    .option('--full', 'Run operational smoke tests across all domains')
    .option('--fix', 'Auto-fix failed checks')
    .option('--coherence', 'Run coherence check across task data')
    .option('--hooks', 'Show cross-provider hook support matrix (CAAMP canonical taxonomy)')
    .action(async (opts: Record<string, unknown>, command: Command) => {
      // Merge citty-parsed opts with global flags (--json, --human, etc.)
      const globalOpts = command.optsWithGlobals ? command.optsWithGlobals() : command.opts();
      const mergedOpts = { ...globalOpts, ...opts };
      const isHuman =
        mergedOpts['human'] === true || (!!process.stdout.isTTY && mergedOpts['json'] !== true);
      const progress = createDoctorProgress(isHuman);

      progress.start();

      try {
        if (mergedOpts['hooks']) {
          progress.step(0, 'Building provider hook matrix');
          if (isHuman) {
            // Fetch raw result to render custom table output
            const response = await dispatchRaw('query', 'admin', 'hooks.matrix', {
              detectProvider: true,
            });
            progress.complete('Hook matrix complete');
            if (response.success && response.data) {
              renderHookMatrixHuman(response.data as HookMatrixResult);
            } else {
              process.stderr.write(
                `Error: ${response.error?.message ?? 'Failed to build hook matrix'}\n`,
              );
              process.exitCode = 1;
            }
          } else {
            await dispatchFromCli(
              'query',
              'admin',
              'hooks.matrix',
              { detectProvider: true },
              { command: 'doctor', operation: 'admin.hooks.matrix' },
            );
            progress.complete('Hook matrix complete');
          }
        } else if (mergedOpts['full']) {
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
