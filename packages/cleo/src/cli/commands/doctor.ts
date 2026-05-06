/**
 * CLI doctor command - system diagnostics.
 * Delegates via dispatch to admin.health handler.
 * --full flag runs operational smoke tests across all domains.
 * --hooks flag shows the cross-provider hook support matrix via CAAMP.
 * --scan-rogue-cleo-dirs scans for rogue .cleo/ dirs inside sub-packages.
 * --quarantine-rogue-cleo-dirs moves rogue .cleo/ dirs to quarantine.
 * @task T4454
 * @task T4795
 * @task T4903
 * @task T5243
 * @task T130
 * @task T167
 * @task T1868
 */

import type { HookMatrixResult, RogueDirReport } from '@cleocode/core/internal';
import { getProjectRoot, quarantineRogueCleoDir, scanRogueCleoDirs } from '@cleocode/core/internal';
import { defineCommand } from 'citty';
import { dispatchFromCli, dispatchRaw } from '../../dispatch/adapters/cli.js';
import { createDoctorProgress } from '../progress.js';
import { cliError, humanLine } from '../renderers/index.js';
import { runDoctorProjects } from './doctor-projects.js';
import { readMigrationConflicts } from './migrate-agents-v2.js';

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

  humanLine(`\nProvider Hook Matrix (CAAMP ${caampVersion} canonical taxonomy)\n`);

  if (detectedProvider) {
    humanLine(`Detected provider: ${detectedProvider}\n`);
  }

  if (providers.length === 0) {
    humanLine('No providers found in CAAMP registry.');
    return;
  }

  const EVENT_COL = Math.max(...events.map((e) => e.length), 'Event'.length);
  const provCols = providers.map((p) => Math.max(p.length, 5));

  const headerParts = [
    'Event'.padEnd(EVENT_COL),
    ...providers.map((p, i) => p.padEnd(provCols[i]!)),
  ];
  humanLine(`  ${headerParts.join('  ')}`);

  const sepParts = ['-'.repeat(EVENT_COL), ...provCols.map((w) => '-'.repeat(w))];
  humanLine(`  ${sepParts.join('  ')}`);

  for (const event of events) {
    const cells = providers.map((p, i) => {
      const supported = matrix[event]?.[p] === true;
      const symbol = supported ? '\u2713' : '-';
      return symbol.padEnd(provCols[i]!);
    });
    humanLine(`  ${event.padEnd(EVENT_COL)}  ${cells.join('  ')}`);
  }

  humanLine('');
  const coverageParts = summary.map(
    (s) => `${s.providerId} ${s.supportedCount}/${s.totalCanonical} (${s.coverage}%)`,
  );
  humanLine(`Coverage: ${coverageParts.join(', ')}\n`);
}

/**
 * Render a single {@link RogueDirReport} as a human-readable block.
 *
 * @param report - The forensic report to render.
 */
function renderRogueReportHuman(report: RogueDirReport): void {
  const totalKb = (report.totalSize / 1024).toFixed(1);
  humanLine(`\n  Package: ${report.packageName}`);
  humanLine(`  Path:    ${report.path}`);
  humanLine(`  Size:    ${totalKb} KB (${report.fileManifest.length} files)`);
  humanLine(
    `  Marker:  ${report.hasProjectInfoMarker ? 'has project-info.json (unexpected!)' : 'no project-info.json (rogue)'}`,
  );

  const { tasks, brain_observations, brain_decisions } = report.dbRowCounts;
  if (tasks !== undefined || brain_observations !== undefined) {
    const parts: string[] = [];
    if (tasks !== undefined) parts.push(`tasks=${tasks}`);
    if (brain_observations !== undefined) parts.push(`brain_observations=${brain_observations}`);
    if (brain_decisions !== undefined) parts.push(`brain_decisions=${brain_decisions}`);
    humanLine(`  DB rows: ${parts.join(', ')}`);
  }

  if (report.drizzleMigrations.length > 0) {
    humanLine(`  Migrations (${report.drizzleMigrations.length}):`);
    for (const m of report.drizzleMigrations) {
      humanLine(`    [${m.id}] ${m.name ?? m.hash.slice(0, 16)}`);
    }
  }
}

/**
 * Root doctor command — run system diagnostics and health checks.
 *
 * Global output flags (--json, --human, --quiet) are declared in args so
 * citty parses them directly. This replaces the Commander.js optsWithGlobals()
 * pattern that is unavailable in native citty commands.
 */
export const doctorCommand = defineCommand({
  meta: { name: 'doctor', description: 'Run system diagnostics and health checks' },
  args: {
    detailed: {
      type: 'boolean',
      description: 'Show detailed health check results',
    },
    comprehensive: {
      type: 'boolean',
      description: 'Run comprehensive doctor report',
    },
    full: {
      type: 'boolean',
      description: 'Run operational smoke tests across all domains',
    },
    fix: {
      type: 'boolean',
      description: 'Auto-fix failed checks',
    },
    coherence: {
      type: 'boolean',
      description: 'Run coherence check across task data',
    },
    hooks: {
      type: 'boolean',
      description: 'Show cross-provider hook support matrix (CAAMP canonical taxonomy)',
    },
    'all-projects': {
      type: 'boolean',
      description: 'Probe DB + config health for every registered project (nexus.db)',
    },
    'ignore-unreachable': {
      type: 'boolean',
      description: 'When used with --all-projects, exit 1 instead of 2 on unreachable projects',
    },
    'scan-rogue-cleo-dirs': {
      type: 'boolean',
      description:
        'Scan for rogue .cleo/ directories inside sub-packages and print forensic report',
    },
    'quarantine-rogue-cleo-dirs': {
      type: 'boolean',
      description:
        'Move all rogue .cleo/ sub-package directories to .cleo/quarantine/ (never deletes)',
    },
    'dry-run': {
      type: 'boolean',
      description: 'With --quarantine-rogue-cleo-dirs: print what would be moved without moving',
    },
    // Global output format flags — read directly from args (no optsWithGlobals in citty)
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
    human: {
      type: 'boolean',
      description: 'Force human-readable output',
    },
    quiet: {
      type: 'boolean',
      description: 'Suppress non-essential output',
    },
  },
  async run({ args }) {
    const isHuman = args.human === true || (!!process.stdout.isTTY && args.json !== true);
    const progress = createDoctorProgress(isHuman);

    progress.start();

    try {
      if (args['all-projects']) {
        progress.step(0, 'Probing registered projects');
        await runDoctorProjects({
          json: args.json === true,
          quiet: args.quiet === true,
          ignoreUnreachable: args['ignore-unreachable'] === true,
        });
        progress.complete('Project health report complete');
      } else if (args.hooks) {
        progress.step(0, 'Building provider hook matrix');
        if (isHuman) {
          const response = await dispatchRaw('query', 'admin', 'hooks.matrix', {
            detectProvider: true,
          });
          progress.complete('Hook matrix complete');
          if (response.success && response.data) {
            renderHookMatrixHuman(response.data as HookMatrixResult);
          } else {
            cliError(response.error?.message ?? 'Failed to build hook matrix', 1, {
              name: 'E_INTERNAL',
            });
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
      } else if (args.full) {
        progress.step(0, 'Running operational smoke tests');
        await dispatchFromCli(
          'query',
          'admin',
          'smoke',
          {},
          { command: 'doctor', operation: 'admin.smoke' },
        );
        progress.complete('Smoke tests complete');
      } else if (args.coherence) {
        progress.step(0, 'Running coherence check');
        await dispatchFromCli(
          'query',
          'check',
          'coherence',
          {},
          { command: 'doctor', operation: 'check.coherence' },
        );
        progress.complete('Coherence check complete');
      } else if (args.fix) {
        progress.step(4, 'Applying fixes');
        await dispatchFromCli(
          'mutate',
          'admin',
          'health',
          { mode: 'repair' },
          { command: 'doctor', operation: 'admin.health' },
        );
        progress.complete('Fixes applied');
      } else if (args.comprehensive) {
        progress.step(0, 'Checking CLEO directory');
        await dispatchFromCli(
          'query',
          'admin',
          'health',
          { mode: 'diagnose' },
          { command: 'doctor', operation: 'admin.health' },
        );
        progress.complete('Comprehensive diagnostics complete');
      } else if (args['scan-rogue-cleo-dirs']) {
        progress.step(0, 'Scanning for rogue .cleo/ directories');
        const projectRoot = getProjectRoot();
        const reports = scanRogueCleoDirs(projectRoot);
        progress.complete(
          `Found ${reports.length} rogue .cleo/ director${reports.length === 1 ? 'y' : 'ies'}`,
        );

        if (args.json) {
          process.stdout.write(JSON.stringify({ success: true, data: reports }, null, 2) + '\n');
        } else {
          if (reports.length === 0) {
            humanLine('\nNo rogue .cleo/ directories found.');
          } else {
            humanLine(`\nRogue .cleo/ directories (${reports.length}):`);
            for (const report of reports) {
              renderRogueReportHuman(report);
            }
            humanLine('');
          }
        }
      } else if (args['quarantine-rogue-cleo-dirs']) {
        const isDryRun = args['dry-run'] === true;
        progress.step(0, `${isDryRun ? '[DRY RUN] ' : ''}Scanning for rogue .cleo/ directories`);
        const projectRoot = getProjectRoot();
        const reports = scanRogueCleoDirs(projectRoot);

        if (reports.length === 0) {
          progress.complete('No rogue .cleo/ directories found — nothing to quarantine');
          if (!args.json) {
            humanLine('\nNo rogue .cleo/ directories found.');
          } else {
            process.stdout.write(
              JSON.stringify({ success: true, data: { quarantined: [] } }, null, 2) + '\n',
            );
          }
          return;
        }

        const quarantined: Array<{ packageName: string; from: string; to: string }> = [];
        const errors: Array<{ packageName: string; path: string; error: string }> = [];

        for (const report of reports) {
          if (isDryRun) {
            // Compute the target path for display without moving
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const targetPath = `${projectRoot}/.cleo/quarantine/${report.packageName}-${timestamp}`;
            quarantined.push({
              packageName: report.packageName,
              from: report.path,
              to: targetPath,
            });
          } else {
            try {
              const { quarantinePath } = quarantineRogueCleoDir(report, projectRoot);
              quarantined.push({
                packageName: report.packageName,
                from: report.path,
                to: quarantinePath,
              });
            } catch (err) {
              errors.push({
                packageName: report.packageName,
                path: report.path,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }

        const verb = isDryRun ? 'Would quarantine' : 'Quarantined';
        progress.complete(
          `${verb} ${quarantined.length} director${quarantined.length === 1 ? 'y' : 'ies'}${errors.length > 0 ? `, ${errors.length} failed` : ''}`,
        );

        if (args.json) {
          process.stdout.write(
            JSON.stringify(
              { success: errors.length === 0, data: { dryRun: isDryRun, quarantined, errors } },
              null,
              2,
            ) + '\n',
          );
        } else {
          humanLine(`\n${verb}:`);
          for (const q of quarantined) {
            humanLine(`  ${q.packageName}: ${q.from}\n    -> ${q.to}`);
          }
          if (errors.length > 0) {
            humanLine(`\nErrors (${errors.length}):`);
            for (const e of errors) {
              humanLine(`  ${e.packageName}: ${e.error}`);
            }
            process.exitCode = 1;
          }
          humanLine('');
        }
      } else {
        progress.step(0, 'Checking CLEO directory');
        await dispatchFromCli(
          'query',
          'admin',
          'health',
          { detailed: args.detailed },
          { command: 'doctor', operation: 'admin.health' },
        );

        // MIGRATE-AGENTS-V2-CONFLICT diagnostic: surface any unresolved
        // agent migration conflicts logged by `cleo migrate agents-v2`.
        // @task T1938 @epic T1929
        try {
          const projectRoot = getProjectRoot();
          const conflicts = readMigrationConflicts(projectRoot);
          if (conflicts.length > 0) {
            progress.complete(
              `Health check complete — ${conflicts.length} agent migration conflict(s) detected`,
            );
            humanLine(
              `\n[MIGRATE-AGENTS-V2-CONFLICT] ${conflicts.length} agent(s) have conflicting .cant content between disk and signaldock.db:`,
            );
            for (const c of conflicts) {
              humanLine(
                `  - ${c.agentName} (${c.filePath})\n` +
                  `    disk sha256:     ${c.newSha256 ?? 'unknown'}\n` +
                  `    registry sha256: ${c.existingSha256 ?? 'unknown'}\n` +
                  `    Resolve: inspect the conflict and either update the registry via\n` +
                  `    'cleo agent install --force <path>' or remove the conflicting file.`,
              );
            }
            humanLine(`  Audit log: .cleo/audit/migration-agents-v2.jsonl\n`);
            if (process.exitCode === undefined || process.exitCode === 0) {
              process.exitCode = 2;
            }
          } else {
            progress.complete('Health check complete');
          }
        } catch {
          progress.complete('Health check complete');
        }
      }
    } catch (err) {
      progress.error('Health check failed');
      throw err;
    }
  },
});
