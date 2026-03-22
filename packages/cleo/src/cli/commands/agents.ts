/**
 * CLI agents command group — agent health monitoring and management.
 *
 * Provides:
 *   cleo agents health              — full health report (status counts + stale agents)
 *   cleo agents health --id <id>    — health status for a specific agent instance
 *   cleo agents health --detect-crashed — detect and mark crashed agents
 *
 * @task T039
 * @epic T038
 */

import {
  checkAgentHealth,
  detectCrashedAgents,
  detectStaleAgents,
  getHealthReport,
  STALE_THRESHOLD_MS,
} from '@cleocode/core/internal';
import type { ShimCommand as Command } from '../commander-shim.js';
import { cliOutput } from '../renderers/index.js';

/**
 * Register the `cleo agents` command group.
 *
 * @remarks
 * Adds the `agents` parent command and the `health` subcommand to the CLI.
 * Delegates to health-monitor functions from `@cleocode/core`.
 *
 * @param program - The root ShimCommand to attach to
 *
 * @example
 * ```bash
 * cleo agents health
 * cleo agents health --id agt_20260322120000_a1b2c3
 * cleo agents health --detect-crashed
 * cleo agents health --threshold 60000
 * ```
 */
export function registerAgentsCommand(program: Command): void {
  const agents = program.command('agents').description('Agent management and health monitoring');

  agents
    .command('health')
    .description('Check agent health and detect stale or crashed agents')
    .option('--id <agentId>', 'Check health for a specific agent ID')
    .option(
      '--threshold <ms>',
      'Staleness threshold in milliseconds (default: 180000 = 3 minutes)',
      String(STALE_THRESHOLD_MS),
    )
    .option('--detect-crashed', 'Detect and mark crashed agents (write operation — updates DB)')
    .action(async (opts: Record<string, unknown>) => {
      const thresholdMs =
        typeof opts['threshold'] === 'string' ? Number(opts['threshold']) : STALE_THRESHOLD_MS;
      const agentId = opts['id'] as string | undefined;
      const detectCrashed = Boolean(opts['detectCrashed']);

      if (agentId) {
        // Single-agent health check
        const health = await checkAgentHealth(agentId, thresholdMs);
        if (!health) {
          cliOutput(
            {
              success: false,
              error: { code: 'E_NOT_FOUND', message: `Agent not found: ${agentId}` },
            },
            { command: 'agents health' },
          );
          process.exitCode = 4;
          return;
        }
        cliOutput({ success: true, data: health }, { command: 'agents health' });
        return;
      }

      if (detectCrashed) {
        // Detect and mark crashed agents (mutating operation)
        const crashed = await detectCrashedAgents(thresholdMs);
        cliOutput(
          {
            success: true,
            data: {
              detectedCrashed: crashed.length,
              agents: crashed.map((a) => ({
                id: a.id,
                agentType: a.agentType,
                lastHeartbeat: a.lastHeartbeat,
                status: a.status,
              })),
            },
          },
          { command: 'agents health' },
        );
        return;
      }

      // Default: full health report + stale agent list
      const [report, stale] = await Promise.all([
        getHealthReport(thresholdMs),
        detectStaleAgents(thresholdMs),
      ]);

      cliOutput(
        {
          success: true,
          data: {
            summary: {
              total: report.total,
              active: report.active,
              idle: report.idle,
              starting: report.starting,
              error: report.error,
              crashed: report.crashed,
              stopped: report.stopped,
              totalErrors: report.totalErrors,
            },
            staleAgents: stale.map((s) => ({
              id: s.agentId,
              status: s.status,
              heartbeatAgeMs: s.heartbeatAgeMs,
              lastHeartbeat: s.lastHeartbeat,
              thresholdMs: s.thresholdMs,
            })),
            thresholdMs,
          },
        },
        { command: 'agents health' },
      );
    });
}
