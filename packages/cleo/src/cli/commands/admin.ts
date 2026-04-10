/**
 * CLI admin command group — dispatches to the admin domain.
 *
 * Provides CLI access to admin.version, admin.health, admin.stats,
 * admin.runtime, admin.smoke, admin.paths, admin.scaffold-hub,
 * admin.cleanup, admin.job, admin.job.cancel, admin.install.global,
 * and admin.context.inject via `cleo admin <subcommand>`.
 *
 * @task T132
 * @task T480 — add cleanup, job, job.cancel, install.global, context.inject subcommands.
 */

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

/** Register the admin command group. */
export function registerAdminCommand(program: Command): void {
  const admin = program.command('admin').description('System administration and diagnostics');

  admin
    .command('version')
    .description('Show CLEO version')
    .action(async () => {
      await dispatchFromCli('query', 'admin', 'version', {}, { command: 'admin' });
    });

  admin
    .command('health')
    .description('Run system health check')
    .option('--detailed', 'Show detailed results')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'admin',
        'health',
        { detailed: opts['detailed'] },
        { command: 'admin' },
      );
    });

  admin
    .command('stats')
    .description('Show project statistics')
    .option('--period <days>', 'Time period in days')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'admin',
        'stats',
        { period: opts['period'] ? Number(opts['period']) : undefined },
        { command: 'admin' },
      );
    });

  admin
    .command('runtime')
    .description('Show runtime diagnostics')
    .option('--detailed', 'Show detailed runtime info')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'admin',
        'runtime',
        { detailed: opts['detailed'] },
        { command: 'admin' },
      );
    });

  admin
    .command('smoke')
    .description('Run operational smoke tests across all domains')
    .action(async () => {
      await dispatchFromCli('query', 'admin', 'smoke', {}, { command: 'admin' });
    });

  admin
    .command('paths')
    .description('Report all CleoOS paths (project + global hub) and scaffolding status')
    .action(async () => {
      await dispatchFromCli('query', 'admin', 'paths', {}, { command: 'admin' });
    });

  admin
    .command('scaffold-hub')
    .description(
      'Create CleoOS Hub dirs (global-recipes, pi-extensions, cant-workflows, agents) and seed starter justfile',
    )
    .action(async () => {
      await dispatchFromCli('mutate', 'admin', 'scaffold-hub', {}, { command: 'admin' });
    });

  // ---------------------------------------------------------------------------
  // cleanup — wraps mutate admin cleanup (T480)
  // ---------------------------------------------------------------------------

  admin
    .command('cleanup')
    .description('Purge stale CLEO data (backups, logs, archive entries)')
    .requiredOption('--target <target>', 'What to clean: backups | logs | archive | sessions')
    .option('--older-than <age>', 'Remove entries older than this duration (e.g. 30d, 6m, 1y)')
    .option('--dry-run', 'Preview what would be removed without making changes')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'admin',
        'cleanup',
        {
          target: opts['target'] as string,
          olderThan: opts['olderThan'] as string | undefined,
          dryRun: opts['dryRun'] === true,
        },
        { command: 'admin cleanup', operation: 'admin.cleanup' },
      );
    });

  // ---------------------------------------------------------------------------
  // job — wraps query admin job (list / status) (T480)
  // ---------------------------------------------------------------------------

  const job = admin
    .command('job')
    .description('Inspect background jobs managed by the job manager');

  job
    .command('list', { isDefault: true })
    .description('List all background jobs (default)')
    .option('--status <status>', 'Filter by job status (pending, running, done, failed, cancelled)')
    .option('--limit <n>', 'Maximum jobs to return', '20')
    .option('--offset <n>', 'Skip N jobs', '0')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'admin',
        'job',
        {
          action: 'list',
          status: opts['status'] as string | undefined,
          limit: opts['limit'] ? Number(opts['limit']) : 20,
          offset: opts['offset'] ? Number(opts['offset']) : 0,
        },
        { command: 'admin job list', operation: 'admin.job' },
      );
    });

  job
    .command('status <jobId>')
    .description('Show status of a specific background job')
    .action(async (jobId: string) => {
      await dispatchFromCli(
        'query',
        'admin',
        'job',
        { action: 'status', jobId },
        { command: 'admin job status', operation: 'admin.job' },
      );
    });

  // ---------------------------------------------------------------------------
  // job cancel — wraps mutate admin job.cancel (T480)
  // ---------------------------------------------------------------------------

  job
    .command('cancel <jobId>')
    .description('Cancel a running background job')
    .action(async (jobId: string) => {
      await dispatchFromCli(
        'mutate',
        'admin',
        'job.cancel',
        { jobId },
        { command: 'admin job cancel', operation: 'admin.job.cancel' },
      );
    });

  // ---------------------------------------------------------------------------
  // install-global — wraps mutate admin install.global (T480)
  // ---------------------------------------------------------------------------

  admin
    .command('install-global')
    .description('Refresh global CLEO setup (provider files, configs, ~/.agents/AGENTS.md)')
    .action(async () => {
      await dispatchFromCli(
        'mutate',
        'admin',
        'install.global',
        {},
        { command: 'admin install-global', operation: 'admin.install.global' },
      );
    });

  // ---------------------------------------------------------------------------
  // context-inject — wraps mutate admin context.inject (T480)
  // Agent-facing but exposed via CLI for testing and manual use.
  // ---------------------------------------------------------------------------

  admin
    .command('context-inject <protocolType>')
    .description(
      'Inject protocol content into session context (e.g. cleo-base, ct-orchestrator, ct-cleo)',
    )
    .option('--task <id>', 'Scope injection to a specific task ID')
    .option('--variant <variant>', 'Select a named protocol variant')
    .action(async (protocolType: string, opts: Record<string, unknown>) => {
      if (!protocolType || typeof protocolType !== 'string' || protocolType.trim() === '') {
        console.error('Error: missing required argument <protocolType>');
        console.error(
          'Usage: cleo admin context-inject <protocolType> [--task <id>] [--variant <variant>]',
        );
        process.exit(1);
      }
      await dispatchFromCli(
        'mutate',
        'admin',
        'context.inject',
        {
          protocolType,
          taskId: opts['task'] as string | undefined,
          variant: opts['variant'] as string | undefined,
        },
        { command: 'admin context-inject', operation: 'admin.context.inject' },
      );
    });
}
