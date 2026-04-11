/**
 * CLI compliance command group.
 * @task T4535
 * @task T476 — compliance record subcommand
 * @epic T4454
 */

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

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
      await dispatchFromCli(
        'query',
        'check',
        'compliance.summary',
        {
          since: opts['since'],
          agent: opts['agent'],
        },
        { command: 'compliance' },
      );
    });

  compliance
    .command('violations')
    .description('List compliance violations')
    .option('--severity <level>', 'Filter by severity (low|medium|high|critical)')
    .option('--since <date>', 'Filter from date')
    .option('--agent <id>', 'Filter by agent ID')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'check',
        'compliance.summary',
        {
          detail: true,
          severity: opts['severity'],
          since: opts['since'],
          agent: opts['agent'],
        },
        { command: 'compliance' },
      );
    });

  compliance
    .command('trend [days]')
    .description('Show compliance trend over N days')
    .action(async (days: string | undefined) => {
      await dispatchFromCli(
        'query',
        'check',
        'compliance.summary',
        {
          type: 'trend',
          days: days ? Number(days) : 7,
        },
        { command: 'compliance' },
      );
    });

  compliance
    .command('audit <taskId>')
    .description('Check compliance for a specific task and its subtasks')
    .option('--since <date>', 'Filter from date')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'check',
        'compliance.summary',
        {
          type: 'audit',
          taskId,
          since: opts['since'],
        },
        { command: 'compliance' },
      );
    });

  compliance
    .command('sync')
    .description('Sync project metrics to global aggregation')
    .option('--force', 'Force full sync')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'check',
        'compliance.sync',
        {
          force: opts['force'],
        },
        { command: 'compliance' },
      );
    });

  compliance
    .command('skills')
    .description('Per-skill/agent reliability stats')
    .option('--global', 'Use global metrics file')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'check',
        'compliance.summary',
        {
          type: 'skills',
          global: opts['global'],
        },
        { command: 'compliance' },
      );
    });

  compliance
    .command('value [days]')
    .description('VALUE PROOF: Token savings & validation impact')
    .action(async (days: string | undefined) => {
      await dispatchFromCli(
        'query',
        'check',
        'compliance.summary',
        {
          type: 'value',
          days: days ? Number(days) : 7,
        },
        { command: 'compliance' },
      );
    });

  compliance
    .command('record <taskId> <result>')
    .description('Record a compliance check result for a task (pass|fail|warning)')
    .option('--protocol <name>', 'Protocol name the check applies to (e.g. implementation)')
    .option(
      '--violation <spec>',
      'Add a violation as "code:severity:message" (repeatable)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .action(async (taskId: string, result: string, opts: Record<string, unknown>) => {
      const rawViolations = (opts['violation'] ?? []) as string[];
      const violations = rawViolations
        .map((v) => {
          const [code, severity, ...rest] = v.split(':');
          return {
            code: code ?? '',
            severity: (severity === 'error' || severity === 'warning' ? severity : 'error') as
              | 'error'
              | 'warning',
            message: rest.join(':'),
          };
        })
        .filter((v) => v.code);
      await dispatchFromCli(
        'mutate',
        'check',
        'compliance.record',
        {
          taskId,
          result,
          protocol: opts['protocol'] as string | undefined,
          violations: violations.length > 0 ? violations : undefined,
        },
        { command: 'compliance', operation: 'check.compliance.record' },
      );
    });
}
