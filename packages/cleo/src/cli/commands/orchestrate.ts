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
 * T483 — 100% CLI coverage additions:
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

  // ── cleo orchestrate ivtr <taskId> [--start|--next|--status|--release|--loop-back] ──
  // T811 — multi-agent IVTR enforcement harness
  orch
    .command('ivtr <taskId>')
    .description('Drive an Implement→Validate→Test phased loop on a task with evidence-bound gates')
    .option('--start', 'Begin Implement phase')
    .option('--next', 'Advance to next phase (requires prior-phase evidence)')
    .option('--status', 'Show current IVTR state + history')
    .option('--release', 'Final gate — require I+V+T evidence, then release')
    .option('--loop-back', 'Rewind to specified phase on failure')
    .option('--phase <name>', 'Phase for --loop-back (implement|validate|test)')
    .option('--reason <text>', 'Reason for loop-back')
    .option('--evidence <sha256>', 'Attachment sha256 to attach (repeatable)')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      const action = opts['start']
        ? 'start'
        : opts['next']
          ? 'next'
          : opts['release']
            ? 'release'
            : opts['loopBack']
              ? 'loop-back'
              : 'status';
      const kind = action === 'status' ? 'query' : 'mutate';
      await dispatchFromCli(
        kind,
        'orchestrate',
        `ivtr.${action}`,
        {
          taskId,
          phase: opts['phase'],
          reason: opts['reason'],
          evidence: opts['evidence'],
        },
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
    .option('--var <pairs>', 'Comma-separated key=value variable overrides (e.g. foo=bar,baz=qux)')
    .action(async (templateId: string, epicId: string, opts: Record<string, unknown>) => {
      const variables: Record<string, string> = {};
      const raw = opts['var'];
      if (typeof raw === 'string') {
        for (const pair of raw.split(',')) {
          const eqIdx = pair.indexOf('=');
          if (eqIdx > 0) {
            variables[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
          }
        }
      } else if (Array.isArray(raw)) {
        for (const pair of raw as string[]) {
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

  // ---------------------------------------------------------------------------
  // T483: bootstrap — brain state load for agent bootstrapping
  // ---------------------------------------------------------------------------

  orch
    .command('bootstrap')
    .description('Load brain state for agent bootstrapping')
    .option('--epic <epicId>', 'Epic ID to scope bootstrap context to')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'orchestrate',
        'bootstrap',
        { epicId: opts['epic'] },
        { command: 'orchestrate' },
      );
    });

  // ---------------------------------------------------------------------------
  // T483: classify — CANT prompt-based team routing
  // ---------------------------------------------------------------------------

  orch
    .command('classify <request>')
    .description('Classify a request using CANT prompt-based team routing')
    .action(async (request: string) => {
      await dispatchFromCli(
        'query',
        'orchestrate',
        'classify',
        { request },
        { command: 'orchestrate' },
      );
    });

  // ---------------------------------------------------------------------------
  // T483: fanout-status — in-process fanout manifest lookup
  // ---------------------------------------------------------------------------

  orch
    .command('fanout-status')
    .description('Get fanout status by manifest entry ID')
    .requiredOption('--manifest-entry-id <id>', 'Manifest entry ID returned by orchestrate.fanout')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'orchestrate',
        'fanout.status',
        { manifestEntryId: opts['manifestEntryId'] },
        { command: 'orchestrate' },
      );
    });

  // ---------------------------------------------------------------------------
  // T483: handoff — composite session handoff + successor spawn
  // ---------------------------------------------------------------------------

  orch
    .command('handoff <taskId>')
    .description('Perform session handoff and spawn successor for a task')
    .requiredOption('--protocol <type>', 'Protocol type for handoff')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'orchestrate',
        'handoff',
        { taskId, protocolType: opts['protocol'] },
        { command: 'orchestrate' },
      );
    });

  // ---------------------------------------------------------------------------
  // T483: spawn-execute — adapter-registry spawn execution
  // ---------------------------------------------------------------------------

  orch
    .command('spawn-execute <taskId>')
    .description('Execute spawn for a task via the adapter registry')
    .action(async (taskId: string) => {
      await dispatchFromCli(
        'mutate',
        'orchestrate',
        'spawn.execute',
        { taskId },
        { command: 'orchestrate' },
      );
    });

  // ---------------------------------------------------------------------------
  // T483: fanout — Promise.allSettled spawn wrapper
  // ---------------------------------------------------------------------------

  orch
    .command('fanout <epicId>')
    .description('Fan out tasks for an epic using parallel spawn')
    .option('--tasks <ids>', 'Comma-separated task IDs to fan out')
    .action(async (epicId: string, opts: Record<string, unknown>) => {
      const taskIds =
        typeof opts['tasks'] === 'string'
          ? (opts['tasks'] as string).split(',').map((s) => s.trim())
          : undefined;
      const items = taskIds ? taskIds.map((taskId) => ({ taskId, team: 'default' })) : undefined;
      await dispatchFromCli(
        'mutate',
        'orchestrate',
        'fanout',
        { epicId, items },
        { command: 'orchestrate' },
      );
    });

  // ---------------------------------------------------------------------------
  // T483: conduit subcommands — agent-to-agent messaging (ADR-042)
  // ---------------------------------------------------------------------------

  orch
    .command('conduit-status')
    .description('Get conduit messaging status')
    .action(async () => {
      await dispatchFromCli(
        'query',
        'orchestrate',
        'conduit.status',
        {},
        { command: 'orchestrate' },
      );
    });

  orch
    .command('conduit-peek')
    .description('Peek at queued conduit messages')
    .option('--limit <n>', 'Maximum number of messages to return', parseInt)
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'orchestrate',
        'conduit.peek',
        { limit: opts['limit'] },
        { command: 'orchestrate' },
      );
    });

  orch
    .command('conduit-start')
    .description('Start the conduit message loop')
    .option('--poll-interval <ms>', 'Polling interval in milliseconds', parseInt)
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'orchestrate',
        'conduit.start',
        { pollIntervalMs: opts['pollInterval'] },
        { command: 'orchestrate' },
      );
    });

  orch
    .command('conduit-stop')
    .description('Stop the conduit message loop')
    .action(async () => {
      await dispatchFromCli(
        'mutate',
        'orchestrate',
        'conduit.stop',
        {},
        { command: 'orchestrate' },
      );
    });

  orch
    .command('conduit-send <content>')
    .description('Send a message via conduit to an agent or conversation')
    .option('--to <agentId>', 'Target agent ID')
    .option('--conversation <id>', 'Conversation ID to send into')
    .action(async (content: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'orchestrate',
        'conduit.send',
        {
          content,
          to: opts['to'],
          conversationId: opts['conversation'],
        },
        { command: 'orchestrate' },
      );
    });
}
