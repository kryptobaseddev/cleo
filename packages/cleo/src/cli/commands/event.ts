/**
 * CLI command group: `cleo event` — CLEO Observability event bus (ADR-071 / T1651).
 *
 * Subcommands:
 *   cleo event append   — emit a structured lifecycle event from a worker
 *   cleo event tail     — stream events from the agent event log
 *
 * @see packages/core/src/events/event-bus.ts
 * @see .cleo/adrs/ADR-071-cleo-observability-event-bus.md
 * @task T1651
 * @task T1652
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { cwd as processCwd } from 'node:process';
import { appendEvent, type CleoAgentEventKind } from '@cleocode/core/events/event-bus.js';
import { defineCommand } from 'citty';
import { isSubCommandDispatch } from '../lib/subcommand-guard.js';
import { cliError, cliOutput } from '../renderers/index.js';

const VALID_KINDS: readonly CleoAgentEventKind[] = [
  'spawn',
  'heartbeat',
  'tool-start',
  'tool-end',
  'commit',
  'blocked',
  'complete',
];

const projectArgs = {
  project: {
    type: 'string' as const,
    description: 'Project root (defaults to process cwd)',
  },
  json: {
    type: 'boolean' as const,
    description: 'Emit LAFS JSON envelope',
  },
};

function resolveProjectRoot(arg: string | undefined): string {
  return arg && arg.length > 0 ? arg : processCwd();
}

// ---------------------------------------------------------------------------
// append subcommand
// ---------------------------------------------------------------------------

/**
 * `cleo event append` — emit a structured lifecycle event from an agent.
 *
 * Accepts `--kind`, `--task`, `--agent`, and optional `--payload` (JSON string).
 * Transport is determined by `CLEO_EVENTS_TRANSPORT` env var (default: conduit).
 *
 * @task T1651
 */
const appendSub = defineCommand({
  meta: {
    name: 'append',
    description: 'Emit a structured lifecycle event from an agent worker',
  },
  args: {
    ...projectArgs,
    kind: {
      type: 'string' as const,
      description: `Event kind: ${VALID_KINDS.join(' | ')}`,
      required: true,
    },
    task: {
      type: 'string' as const,
      description: 'Task ID the worker is executing (e.g. T1234)',
      required: true,
    },
    agent: {
      type: 'string' as const,
      description: 'Agent identity string (e.g. cleo-worker-T1234)',
      required: true,
    },
    payload: {
      type: 'string' as const,
      description: 'Optional JSON payload string (e.g. \'{"tool":"Bash"}\')',
    },
  },
  async run({ args }) {
    const projectRoot = resolveProjectRoot(args.project as string | undefined);
    const kind = args.kind as string;
    const taskId = args.task as string;
    const agentId = args.agent as string;

    if (!VALID_KINDS.includes(kind as CleoAgentEventKind)) {
      cliError(
        `Invalid event kind '${kind}'. Valid kinds: ${VALID_KINDS.join(', ')}`,
        'E_EVENT_INVALID_KIND',
      );
      process.exit(1);
    }

    let payload: Record<string, unknown> | undefined;
    if (args.payload) {
      try {
        payload = JSON.parse(args.payload as string) as Record<string, unknown>;
      } catch {
        cliError('--payload must be valid JSON', 'E_EVENT_INVALID_PAYLOAD');
        process.exit(1);
      }
    }

    try {
      await appendEvent(kind as CleoAgentEventKind, taskId, agentId, projectRoot, payload);
      cliOutput(
        { kind, taskId, agentId, appended: true },
        {
          command: 'event append',
          message: `Event appended: ${kind} for ${taskId} by ${agentId}`,
          operation: 'event.append',
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(message, 'E_EVENT_APPEND');
      process.exit(1);
    }
  },
});

// ---------------------------------------------------------------------------
// tail subcommand
// ---------------------------------------------------------------------------

/**
 * `cleo event tail` — stream structured events from an agent's event log.
 *
 * For the file transport this reads the NDJSON log and prints formatted lines.
 * Pass `--agent <id>` to tail a specific agent; `--all` for all agents.
 *
 * @task T1652
 */
const tailSub = defineCommand({
  meta: {
    name: 'tail',
    description: 'Stream structured events from agent event logs',
  },
  args: {
    ...projectArgs,
    agent: {
      type: 'string' as const,
      description: 'Agent ID to tail (omit to list all agents)',
    },
    all: {
      type: 'boolean' as const,
      description: 'Tail all agent log files',
    },
    lines: {
      type: 'string' as const,
      description: 'Number of tail lines to show (default: 20)',
    },
  },
  async run({ args }) {
    const projectRoot = resolveProjectRoot(args.project as string | undefined);
    const jsonMode = args.json === true;
    const agentIdFilter = args.agent as string | undefined;
    const showAll = args.all === true;
    const lines = parseInt((args.lines as string | undefined) ?? '20', 10);

    const eventsDir = join(projectRoot, '.cleo', 'agent-events');

    try {
      let files: string[] = [];
      try {
        const entries = await readdir(eventsDir);
        files = entries.filter((f) => f.endsWith('.jsonl'));
      } catch {
        // Dir doesn't exist — no events yet.
      }

      if (files.length === 0) {
        cliOutput(
          {
            agents: [],
            message: 'No event logs found. Events are written when workers call appendEvent.',
          },
          { command: 'event tail', message: 'No agent event logs found.', operation: 'event.tail' },
        );
        return;
      }

      if (!agentIdFilter && !showAll) {
        // List available agents.
        const agentIds = files.map((f) => f.replace('.jsonl', ''));
        cliOutput(
          { agents: agentIds },
          {
            command: 'event tail',
            message: `${agentIds.length} agent log(s): ${agentIds.join(', ')}`,
            operation: 'event.tail',
          },
        );
        return;
      }

      const filesToTail = agentIdFilter
        ? files.filter((f) => f === `${agentIdFilter}.jsonl`)
        : files;

      if (filesToTail.length === 0) {
        cliError(`No event log for agent '${agentIdFilter}'`, 'E_EVENT_TAIL_NOT_FOUND');
        process.exit(1);
      }

      for (const file of filesToTail) {
        const agentId = file.replace('.jsonl', '');
        const { readFileSync } = await import('node:fs');
        const content = readFileSync(join(eventsDir, file), 'utf-8');
        const eventLines = content.trim().split('\n').filter(Boolean);
        const tail = eventLines.slice(-lines);

        if (jsonMode) {
          const events = tail
            .map((l) => {
              try {
                return JSON.parse(l);
              } catch {
                return null;
              }
            })
            .filter(Boolean);
          cliOutput(
            { agentId, events },
            {
              command: 'event tail',
              message: `${events.length} event(s) for ${agentId}`,
              operation: 'event.tail',
            },
          );
        } else {
          process.stdout.write(`\n=== ${agentId} (${tail.length} events) ===\n`);
          for (const line of tail) {
            try {
              const evt = JSON.parse(line) as {
                kind: string;
                taskId: string;
                timestamp: string;
                payload?: unknown;
              };
              const ts = new Date(evt.timestamp).toLocaleTimeString();
              const payloadStr = evt.payload ? ` ${JSON.stringify(evt.payload)}` : '';
              process.stdout.write(`  [${ts}] ${evt.kind.padEnd(12)} ${evt.taskId}${payloadStr}\n`);
            } catch {
              process.stdout.write(`  ${line}\n`);
            }
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(message, 'E_EVENT_TAIL');
      process.exit(1);
    }
  },
});

// ---------------------------------------------------------------------------
// orchestrator command (cleo orchestrator tail)
// ---------------------------------------------------------------------------

/**
 * `cleo orchestrator tail --epic <id>` — stream worker events for an epic.
 *
 * Subscribes to `agent.events.*` event logs under `.cleo/agent-events/` and
 * prints a formatted stream. Filters to agents whose log filename contains
 * the epic ID prefix or shows all when `--epic` is omitted.
 *
 * Ctrl-C exits cleanly.
 *
 * @task T1652
 */
const orchestratorTailSub = defineCommand({
  meta: {
    name: 'tail',
    description: 'Stream worker lifecycle events for an epic (agent.events.*)',
  },
  args: {
    ...projectArgs,
    epic: {
      type: 'string' as const,
      description: 'Epic task ID to filter agent events (e.g. T1135)',
    },
    follow: {
      type: 'boolean' as const,
      description: 'Poll for new events until Ctrl-C (default: show last 50 and exit)',
    },
    lines: {
      type: 'string' as const,
      description: 'Number of tail lines per agent (default: 50)',
    },
  },
  async run({ args }) {
    const projectRoot = resolveProjectRoot(args.project as string | undefined);
    const jsonMode = args.json === true;
    const epicFilter = args.epic as string | undefined;
    const follow = args.follow === true;
    const lines = parseInt((args.lines as string | undefined) ?? '50', 10);

    const eventsDir = join(projectRoot, '.cleo', 'agent-events');

    let files: string[] = [];
    try {
      const entries = await readdir(eventsDir);
      files = entries.filter((f) => f.endsWith('.jsonl'));
      if (epicFilter) {
        // Filter by agents associated with this epic (agent IDs often contain task IDs).
        files = files.filter((f) => f.includes(epicFilter));
        // If no direct match, show all (orchestrator may not know exact agent IDs).
        if (files.length === 0) files = entries.filter((f) => f.endsWith('.jsonl'));
      }
    } catch {
      // No events directory yet.
    }

    if (files.length === 0) {
      cliOutput(
        { agents: [], epicFilter },
        {
          command: 'orchestrator tail',
          message: epicFilter
            ? `No event logs for epic ${epicFilter}. Workers emit events via appendEvent.`
            : 'No agent event logs found.',
          operation: 'orchestrator.tail',
        },
      );
      return;
    }

    const printAgentLog = async (file: string) => {
      const agentId = file.replace('.jsonl', '');
      try {
        const { readFileSync } = await import('node:fs');
        const content = readFileSync(join(eventsDir, file), 'utf-8');
        const eventLines = content.trim().split('\n').filter(Boolean);
        const tail = eventLines.slice(-lines);

        if (jsonMode) {
          const events = tail
            .map((l) => {
              try {
                return JSON.parse(l);
              } catch {
                return null;
              }
            })
            .filter(Boolean);
          process.stdout.write(JSON.stringify({ agentId, events }) + '\n');
        } else {
          process.stdout.write(`\n=== ${agentId} ===\n`);
          for (const line of tail) {
            try {
              const evt = JSON.parse(line) as {
                kind: string;
                taskId: string;
                timestamp: string;
                payload?: unknown;
              };
              const ts = new Date(evt.timestamp).toLocaleTimeString();
              const payloadStr = evt.payload ? ` ${JSON.stringify(evt.payload)}` : '';
              process.stdout.write(`  [${ts}] ${evt.kind.padEnd(12)} ${evt.taskId}${payloadStr}\n`);
            } catch {
              process.stdout.write(`  ${line}\n`);
            }
          }
        }
      } catch {
        // Skip unreadable files.
      }
    };

    // Initial print.
    for (const file of files) {
      await printAgentLog(file);
    }

    if (!follow) return;

    // Follow mode — poll every 2 seconds until Ctrl-C.
    process.stdout.write('\n[following — Ctrl-C to stop]\n');
    const interval = setInterval(async () => {
      // Re-read each file to pick up new events.
      for (const file of files) {
        await printAgentLog(file);
      }
    }, 2000);

    process.on('SIGINT', () => {
      clearInterval(interval);
      process.stdout.write('\n[disconnected]\n');
      process.exit(0);
    });
  },
});

/** Root `cleo orchestrator` command — orchestration observability tools. */
export const orchestratorCommand = defineCommand({
  meta: {
    name: 'orchestrator',
    description: 'Orchestration observability: stream worker event logs',
  },
  args: projectArgs,
  subCommands: {
    tail: orchestratorTailSub,
  },
  async run({ cmd, rawArgs }) {
    if (isSubCommandDispatch(rawArgs, cmd.subCommands)) return;
    cliOutput(
      { subCommands: ['tail'] },
      {
        command: 'orchestrator',
        message: 'Usage: cleo orchestrator tail [--epic <id>] [--follow]',
        operation: 'orchestrator',
      },
    );
  },
});

// ---------------------------------------------------------------------------
// Root command
// ---------------------------------------------------------------------------

/**
 * Root `cleo event` command. Running without a subcommand prints usage.
 *
 * @task T1651
 */
export const eventCommand = defineCommand({
  meta: {
    name: 'event',
    description: 'CLEO Observability event bus: append lifecycle events and tail agent logs',
  },
  args: projectArgs,
  subCommands: {
    append: appendSub,
    tail: tailSub,
  },
  async run({ cmd, rawArgs }) {
    if (isSubCommandDispatch(rawArgs, cmd.subCommands)) return;
    cliOutput(
      { subCommands: ['append', 'tail'] },
      { command: 'event', message: 'Usage: cleo event append|tail', operation: 'event' },
    );
  },
});
