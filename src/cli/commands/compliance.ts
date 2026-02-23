/**
 * CLI compliance command group.
 * @task T4535
 * @epic T4454
 */

import { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

export function registerComplianceCommand(program: Command): void {
  const compliance = program
    .command('compliance')
    .description('Monitor and report compliance metrics for orchestrator and agent outputs');

  compliance
    .command('summary')
    .description('Aggregate compliance stats (default)')
    .option('--since <date>', 'Filter metrics from this date (ISO 8601)')
    .option('--agent <id>', 'Filter by agent/skill ID')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli('query', 'check', 'compliance.summary', {
        since: opts['since'], agent: opts['agent'],
      }, { command: 'compliance' });
    });

  compliance
    .command('violations')
    .description('List compliance violations')
    .option('--severity <level>', 'Filter by severity (low|medium|high|critical)')
    .option('--since <date>', 'Filter from date')
    .option('--agent <id>', 'Filter by agent ID')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli('query', 'check', 'compliance.violations', {
        severity: opts['severity'], since: opts['since'], agent: opts['agent'],
      }, { command: 'compliance' });
    });

  compliance
    .command('trend [days]')
    .description('Show compliance trend over N days')
    .action(async (days: string | undefined) => {
      await dispatchFromCli('query', 'check', 'compliance.summary', {
        type: 'trend', days: days ? Number(days) : 7,
      }, { command: 'compliance' });
    });

  compliance
    .command('audit <epicId>')
    .description('Check compliance for specific epic tasks')
    .option('--since <date>', 'Filter from date')
    .action(async (epicId: string, opts: Record<string, unknown>) => {
      await dispatchFromCli('query', 'check', 'compliance.summary', {
        type: 'audit', epicId, since: opts['since'],
      }, { command: 'compliance' });
    });

  compliance
    .command('sync')
    .description('Sync project metrics to global aggregation')
    .option('--force', 'Force full sync')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli('mutate', 'admin', 'sync', {
        type: 'compliance', force: opts['force'],
      }, { command: 'compliance' });
    });

  compliance
    .command('skills')
    .description('Per-skill/agent reliability stats')
    .option('--global', 'Use global metrics file')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli('query', 'check', 'compliance.summary', {
        type: 'skills', global: opts['global'],
      }, { command: 'compliance' });
    });

  compliance
    .command('value [days]')
    .description('VALUE PROOF: Token savings & validation impact')
    .action(async (days: string | undefined) => {
      await dispatchFromCli('query', 'check', 'compliance.summary', {
        type: 'value', days: days ? Number(days) : 7,
      }, { command: 'compliance' });
    });
}
