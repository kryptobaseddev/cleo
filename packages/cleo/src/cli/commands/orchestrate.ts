/**
 * CLI orchestrate command group.
 * @task T4466
 * @epic T4454
 *
 * Wave 3 additions (T478):
 * - orchestrate.status  — orchestration status for an epic or overall
 * - orchestrate.waves   — dependency wave computation for an epic
 * - orchestrate.parallel — parallel wave tracking (start/end)
 * - orchestrate.tessera list / instantiate — tessera template operations
 * - orchestrate.unblock — unblock opportunity analysis
 *
 * Agent-only ops (no CLI surface — programmatic multi-agent use only):
 * - orchestrate.bootstrap     — brain state load for agent bootstrapping
 * - orchestrate.classify      — CANT prompt-based team routing
 * - orchestrate.fanout        — Promise.allSettled spawn wrapper
 * - orchestrate.fanout.status — in-process fanout manifest lookup
 * - orchestrate.handoff       — composite session handoff + successor spawn
 * - orchestrate.spawn.execute — adapter-registry spawn execution
 * - orchestrate.conduit.*     — agent-to-agent messaging (ADR-042)
 */

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

export function registerOrchestrateCommand(program: Command): void {
  const orch = program.command('orchestrate').description('Multi-agent orchestration commands');

  orch
    .command('start <epicId>')
    .description('Start orchestrator session for an epic')
    .action(async (epicId: string) => {
      await dispatchFromCli(
        'mutate',
        'orchestrate',
        'start',
        { epicId },
        { command: 'orchestrate' },
      );
    });

  orch
    .command('status')
    .description('Get orchestration status for an epic or overall project')
    .option('--epic <epicId>', 'Epic ID to scope status to')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'orchestrate',
        'status',
        { epicId: opts['epic'] },
        { command: 'orchestrate' },
      );
    });

  orch
    .command('analyze <epicId>')
    .description('Analyze epic dependency structure')
    .option('--mode <mode>', 'Analysis mode: critical-path or parallel-safety')
    .option('--tasks <ids>', 'Comma-separated task IDs for parallel-safety mode')
    .action(async (epicId: string, opts: Record<string, unknown>) => {
      const mode = opts['mode'] as string | undefined;
      const taskIds =
        typeof opts['tasks'] === 'string'
          ? (opts['tasks'] as string).split(',').map((s) => s.trim())
          : undefined;
      await dispatchFromCli(
        'query',
        'orchestrate',
        'analyze',
        { epicId, mode, taskIds },
        { command: 'orchestrate' },
      );
    });

  orch
    .command('ready <epicId>')
    .description('Get parallel-safe ready tasks')
    .action(async (epicId: string) => {
      await dispatchFromCli(
        'query',
        'orchestrate',
        'ready',
        { epicId },
        { command: 'orchestrate' },
      );
    });

  orch
    .command('next <epicId>')
    .description('Get next task to spawn')
    .action(async (epicId: string) => {
      await dispatchFromCli('query', 'orchestrate', 'next', { epicId }, { command: 'orchestrate' });
    });

  orch
    .command('waves <epicId>')
    .description('Compute dependency waves for an epic')
    .action(async (epicId: string) => {
      await dispatchFromCli(
        'query',
        'orchestrate',
        'waves',
        { epicId },
        { command: 'orchestrate' },
      );
    });

  orch
    .command('spawn <taskId>')
    .description('Prepare spawn context for a subagent')
    .option('--protocol <type>', 'Protocol type override')
    .option('--tier <tier>', 'Protocol tier (0, 1, or 2)', parseInt)
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'orchestrate',
        'spawn',
        { taskId, protocolType: opts['protocol'], tier: opts['tier'] },
        { command: 'orchestrate' },
      );
    });

  orch
    .command('validate <taskId>')
    .description('Validate subagent output')
    .option('--file <path>', 'Output file path')
    .option('--manifest', 'Manifest entry was appended')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'orchestrate',
        'validate',
        {
          taskId,
          file: opts['file'],
          manifestEntry: opts['manifest'],
        },
        { command: 'orchestrate' },
      );
    });

  orch
    .command('context <epicId>')
    .description('Get orchestrator context summary')
    .action(async (epicId: string) => {
      await dispatchFromCli(
        'query',
        'orchestrate',
        'context',
        { epicId },
        { command: 'orchestrate' },
      );
    });

  orch
    .command('parallel <action> <epicId>')
    .description('Manage parallel wave execution (action: start | end)')
    .option('--wave <number>', 'Wave number', parseInt)
    .action(async (action: string, epicId: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'orchestrate',
        'parallel',
        { action, epicId, wave: opts['wave'] },
        { command: 'orchestrate' },
      );
    });

  // ---------------------------------------------------------------------------
  // tessera subcommand group
  // ---------------------------------------------------------------------------

  const tessera = orch
    .command('tessera')
    .description('Tessera template operations for multi-agent orchestration');

  tessera
    .command('list')
    .description('List available tessera templates')
    .option('--id <templateId>', 'Show details for a specific template')
    .option('--limit <n>', 'Max results to return', parseInt)
    .option('--offset <n>', 'Results offset for pagination', parseInt)
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'orchestrate',
        'tessera.list',
        { id: opts['id'], limit: opts['limit'], offset: opts['offset'] },
        { command: 'orchestrate' },
      );
    });

  tessera
    .command('instantiate <templateId> <epicId>')
    .description('Instantiate a tessera template for an epic')
    .option('--var <pairs...>', 'Key=value variable overrides')
    .action(async (templateId: string, epicId: string, opts: Record<string, unknown>) => {
      const variables: Record<string, string> = {};
      const pairs = opts['var'] as string[] | undefined;
      if (Array.isArray(pairs)) {
        for (const pair of pairs) {
          const eqIdx = pair.indexOf('=');
          if (eqIdx > 0) {
            variables[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
          }
        }
      }
      await dispatchFromCli(
        'mutate',
        'orchestrate',
        'tessera.instantiate',
        { templateId, epicId, variables },
        { command: 'orchestrate' },
      );
    });

  // ---------------------------------------------------------------------------
  // unblock subcommand
  // ---------------------------------------------------------------------------

  orch
    .command('unblock')
    .description('Analyze dependency graph for unblocking opportunities')
    .action(async () => {
      await dispatchFromCli(
        'query',
        'orchestrate',
        'unblock.opportunities',
        {},
        { command: 'orchestrate' },
      );
    });
}
