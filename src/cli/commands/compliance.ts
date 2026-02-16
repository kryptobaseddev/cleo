/**
 * CLI compliance command group.
 * @task T4535
 * @epic T4454
 */

import { Command } from 'commander';
import {
  getComplianceSummary,
  listComplianceViolations,
  getComplianceTrend,
  auditEpicCompliance,
  syncComplianceMetrics,
  getSkillReliability,
  getValueMetrics,
} from '../../core/compliance/index.js';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';

/**
 * Register the compliance command group.
 * @task T4535
 */
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
      try {
        const result = await getComplianceSummary({
          since: opts['since'] as string | undefined,
          agent: opts['agent'] as string | undefined,
        });
        console.log(formatSuccess(result));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  compliance
    .command('violations')
    .description('List compliance violations')
    .option('--severity <level>', 'Filter by severity (low|medium|high|critical)')
    .option('--since <date>', 'Filter from date')
    .option('--agent <id>', 'Filter by agent ID')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const result = await listComplianceViolations({
          severity: opts['severity'] as string | undefined,
          since: opts['since'] as string | undefined,
          agent: opts['agent'] as string | undefined,
        });
        console.log(formatSuccess(result));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  compliance
    .command('trend [days]')
    .description('Show compliance trend over N days')
    .action(async (days: string | undefined) => {
      try {
        const result = await getComplianceTrend(days ? Number(days) : 7);
        console.log(formatSuccess(result));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  compliance
    .command('audit <epicId>')
    .description('Check compliance for specific epic tasks')
    .option('--since <date>', 'Filter from date')
    .action(async (epicId: string, opts: Record<string, unknown>) => {
      try {
        const result = await auditEpicCompliance(epicId, {
          since: opts['since'] as string | undefined,
        });
        console.log(formatSuccess(result));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  compliance
    .command('sync')
    .description('Sync project metrics to global aggregation')
    .option('--force', 'Force full sync')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const result = await syncComplianceMetrics({
          force: opts['force'] as boolean | undefined,
        });
        console.log(formatSuccess(result));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  compliance
    .command('skills')
    .description('Per-skill/agent reliability stats')
    .option('--global', 'Use global metrics file')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const result = await getSkillReliability({
          global: opts['global'] as boolean | undefined,
        });
        console.log(formatSuccess(result));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  compliance
    .command('value [days]')
    .description('VALUE PROOF: Token savings & validation impact')
    .action(async (days: string | undefined) => {
      try {
        const result = await getValueMetrics(days ? Number(days) : 7);
        console.log(formatSuccess(result));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
