/**
 * CLI command group for Conduit inter-agent messaging operations.
 *
 * Exposes the 8 conduit operations registered under the canonical `conduit`
 * domain (T964 — supersedes ADR-042) as a native citty subcommand group:
 *
 *   cleo conduit status     — check agent connection + queue depth
 *   cleo conduit peek       — one-shot poll without consuming messages
 *   cleo conduit start      — start continuous polling daemon
 *   cleo conduit stop       — stop the active polling loop
 *   cleo conduit send       — send a message to an agent or conversation
 *   cleo conduit publish    — publish a message to a topic (A2A, T1252)
 *   cleo conduit subscribe  — subscribe agent to a topic (A2A, T1252)
 *   cleo conduit listen     — one-shot poll for topic messages (A2A, T1252)
 *
 * All subcommands dispatch to the canonical `conduit.*` registry entries
 * via dispatchFromCli.
 *
 * @task T469, T964, T1254
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
 * cleo conduit publish — publish a message to a named topic (A2A, T1252/T1254)
 *
 * Routes to the `conduit.publish` mutate operation in the dispatch domain.
 */
const publishCommand = defineCommand({
  meta: {
    name: 'publish',
    description: 'Publish a message to a Conduit topic (A2A)',
  },
  args: {
    topic: {
      type: 'string',
      description: 'Topic name to publish to (e.g. "epic-T1149.wave-T1253")',
      required: true,
    },
    kind: {
      type: 'string',
      description: 'Message kind: message | request | notify | subscribe (default: message)',
      default: 'message',
    },
    payload: {
      type: 'string',
      description: 'Structured JSON payload to attach (optional)',
    },
    content: {
      type: 'string',
      description: 'Message content (defaults to the payload JSON when omitted)',
    },
    'agent-id': {
      type: 'string',
      description: 'Publishing agent ID (defaults to active agent)',
      alias: 'a',
    },
  },
  async run({ args }) {
    // When --content is omitted, fall back to --payload so the caller can
    // supply just a JSON payload without duplicating it in --content.
    const content = (args.content as string | undefined) ?? args.payload ?? '{}';
    let parsedPayload: Record<string, unknown> | undefined;
    if (args.payload) {
      try {
        parsedPayload = JSON.parse(args.payload as string) as Record<string, unknown>;
      } catch {
        // Treat unparseable --payload as a raw string in meta; content is still sent.
        parsedPayload = { raw: args.payload };
      }
    }
    await dispatchFromCli(
      'mutate',
      'conduit',
      'publish',
      {
        topicName: args.topic,
        kind: args.kind as 'message' | 'request' | 'notify' | 'subscribe',
        content,
        payload: parsedPayload,
        agentId: args['agent-id'] as string | undefined,
      },
      { command: 'conduit publish' },
    );
  },
});

/**
 * cleo conduit subscribe — subscribe the active agent to a named topic (A2A, T1252/T1254)
 *
 * Routes to the `conduit.subscribe` mutate operation in the dispatch domain.
 */
const subscribeCommand = defineCommand({
  meta: {
    name: 'subscribe',
    description: 'Subscribe agent to a Conduit topic (A2A)',
  },
  args: {
    topic: {
      type: 'string',
      description: 'Topic name to subscribe to (e.g. "epic-T1149.coordination")',
      required: true,
    },
    'agent-id': {
      type: 'string',
      description: 'Agent ID to subscribe (defaults to active agent)',
      alias: 'a',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'conduit',
      'subscribe',
      {
        topicName: args.topic,
        agentId: args['agent-id'] as string | undefined,
      },
      { command: 'conduit subscribe' },
    );
  },
});

/**
 * cleo conduit listen — one-shot poll for messages on a topic (A2A, T1252/T1254)
 *
 * Routes to the `conduit.listen` query operation in the dispatch domain.
 */
const listenCommand = defineCommand({
  meta: {
    name: 'listen',
    description: 'One-shot poll for messages on a Conduit topic (A2A)',
  },
  args: {
    topic: {
      type: 'string',
      description: 'Topic name to poll (e.g. "epic-T1149.wave-T1253")',
      required: true,
    },
    limit: {
      type: 'string',
      description: 'Max messages to return (default: 50)',
      default: '50',
    },
    since: {
      type: 'string',
      description: 'Return only messages after this ISO 8601 timestamp (optional)',
    },
    'agent-id': {
      type: 'string',
      description: 'Agent ID to poll as (defaults to active agent)',
      alias: 'a',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'conduit',
      'listen',
      {
        topicName: args.topic,
        limit: Number.parseInt(args.limit, 10),
        since: args.since as string | undefined,
        agentId: args['agent-id'] as string | undefined,
      },
      { command: 'conduit listen' },
    );
  },
});

/**
 * Root conduit command group — registers all 8 conduit subcommands.
 *
 * Dispatches to canonical `conduit.*` registry operations (T964 supersedes ADR-042).
 * Topic subcommands (publish/subscribe/listen) added per T1254.
 */
export const conduitCommand = defineCommand({
  meta: { name: 'conduit', description: 'Manage Conduit inter-agent messaging' },
  subCommands: {
    status: statusCommand,
    peek: peekCommand,
    start: startCommand,
    stop: stopCommand,
    send: sendCommand,
    publish: publishCommand,
    subscribe: subscribeCommand,
    listen: listenCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
