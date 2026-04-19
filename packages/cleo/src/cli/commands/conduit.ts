/**
 * CLI command group for Conduit inter-agent messaging operations.
 *
 * Exposes the 5 conduit operations registered under the canonical `conduit`
 * domain (T964 — supersedes ADR-042) as a native citty subcommand group:
 *
 *   cleo conduit status  — check agent connection + queue depth
 *   cleo conduit peek    — one-shot poll without consuming messages
 *   cleo conduit start   — start continuous polling daemon
 *   cleo conduit stop    — stop the active polling loop
 *   cleo conduit send    — send a message to an agent or conversation
 *
 * All subcommands dispatch to the canonical `conduit.*` registry entries
 * via dispatchFromCli.
 *
 * @task T469, T964
 */

import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/** cleo conduit status — show conduit daemon health and queue depth */
const statusCommand = defineCommand({
  meta: { name: 'status', description: 'Show Conduit daemon health and message queue depth' },
  args: {
    'agent-id': {
      type: 'string',
      description: 'Agent ID to check (defaults to active agent)',
      alias: 'a',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'conduit',
      'status',
      {
        agentId: args['agent-id'] as string | undefined,
      },
      { command: 'conduit status' },
    );
  },
});

/** cleo conduit peek — preview queued messages without consuming them */
const peekCommand = defineCommand({
  meta: {
    name: 'peek',
    description: 'Preview queued Conduit messages without consuming',
  },
  args: {
    'agent-id': {
      type: 'string',
      description: 'Agent ID to poll as (defaults to active agent)',
      alias: 'a',
    },
    limit: {
      type: 'string',
      description: 'Max messages to show (default: 20)',
      default: '20',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'conduit',
      'peek',
      {
        agentId: args['agent-id'] as string | undefined,
        limit: Number.parseInt(args.limit, 10),
      },
      { command: 'conduit peek' },
    );
  },
});

/** cleo conduit start — start or resume the Conduit polling daemon */
const startCommand = defineCommand({
  meta: { name: 'start', description: 'Start or resume the Conduit polling daemon' },
  args: {
    'agent-id': {
      type: 'string',
      description: 'Agent ID to poll as (defaults to active agent)',
      alias: 'a',
    },
    interval: {
      type: 'string',
      description: 'Poll interval in milliseconds (default: 5000)',
      default: '5000',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'conduit',
      'start',
      {
        agentId: args['agent-id'] as string | undefined,
        pollIntervalMs: Number.parseInt(args.interval, 10),
      },
      { command: 'conduit start' },
    );
  },
});

/** cleo conduit stop — stop the active Conduit polling loop */
const stopCommand = defineCommand({
  meta: { name: 'stop', description: 'Stop the active Conduit polling daemon' },
  async run() {
    await dispatchFromCli(
      'mutate',
      'conduit',
      'stop',
      {},
      {
        command: 'conduit stop',
      },
    );
  },
});

/** cleo conduit send — send a message via Conduit */
const sendCommand = defineCommand({
  meta: { name: 'send', description: 'Send a message via Conduit to an agent or conversation' },
  args: {
    to: {
      type: 'string',
      description: 'Target agent ID (required if --conversation-id not given)',
    },
    content: {
      type: 'string',
      description: 'Message content to send',
      required: true,
    },
    'conversation-id': {
      type: 'string',
      description: 'Target conversation ID (required if --to not given)',
    },
    'agent-id': {
      type: 'string',
      description: 'Sending agent ID (defaults to active agent)',
      alias: 'a',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'conduit',
      'send',
      {
        to: args.to as string | undefined,
        content: args.content,
        conversationId: args['conversation-id'] as string | undefined,
        agentId: args['agent-id'] as string | undefined,
      },
      { command: 'conduit send' },
    );
  },
});

/**
 * Root conduit command group — registers all 5 conduit subcommands.
 *
 * Dispatches to canonical `conduit.*` registry operations (T964 supersedes ADR-042).
 */
export const conduitCommand = defineCommand({
  meta: { name: 'conduit', description: 'Manage Conduit inter-agent messaging' },
  subCommands: {
    status: statusCommand,
    peek: peekCommand,
    start: startCommand,
    stop: stopCommand,
    send: sendCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
