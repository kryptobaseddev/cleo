/**
 * CLI provider command group — CAAMP provider registry operations.
 *
 * Covers all tools.provider.* operations:
 *   provider list          (query)  — list registered providers
 *   provider detect        (query)  — detect active provider in current environment
 *   provider inject-status (query)  — show inject status for project/global scope
 *   provider supports      (query)  — check if a provider supports a capability
 *   provider hooks         (query)  — list providers by hook event support
 *   provider inject        (mutate) — inject provider references into AGENTS.md
 *
 * Default action (no subcommand) dispatches to `provider.list`.
 *
 * @task T479
 * @epic T443
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/** cleo provider list — list all registered CAAMP providers */
const listCommand = defineCommand({
  meta: { name: 'list', description: 'List all registered CAAMP providers' },
  args: {
    limit: {
      type: 'string',
      description: 'Maximum providers to return',
    },
    offset: {
      type: 'string',
      description: 'Offset for pagination',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'tools',
      'provider.list',
      {
        limit: args.limit ? Number.parseInt(args.limit, 10) : undefined,
        offset: args.offset ? Number.parseInt(args.offset, 10) : undefined,
      },
      { command: 'provider', operation: 'tools.provider.list' },
    );
  },
});

/** cleo provider detect — detect active provider in the current environment */
const detectCommand = defineCommand({
  meta: {
    name: 'detect',
    description: 'Detect which provider is active in the current environment',
  },
  async run() {
    await dispatchFromCli(
      'query',
      'tools',
      'provider.detect',
      {},
      { command: 'provider', operation: 'tools.provider.detect' },
    );
  },
});

/** cleo provider inject-status — show provider injection status for project or global scope */
const injectStatusCommand = defineCommand({
  meta: {
    name: 'inject-status',
    description: 'Show provider injection status for project or global scope',
  },
  args: {
    scope: {
      type: 'string',
      description: 'Scope: project or global (default: project)',
      default: 'project',
    },
    content: {
      type: 'string',
      description: 'Content string to check against',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'tools',
      'provider.inject.status',
      {
        scope: args.scope,
        content: args.content as string | undefined,
      },
      { command: 'provider', operation: 'tools.provider.inject.status' },
    );
  },
});

/** cleo provider supports <provider-id> <capability> — check if a provider supports a capability */
const supportsCommand = defineCommand({
  meta: {
    name: 'supports',
    description: 'Check if a provider supports a capability (e.g., spawn.supportsSubagents)',
  },
  args: {
    providerId: {
      type: 'positional',
      description: 'Provider ID to check',
      required: true,
    },
    capability: {
      type: 'positional',
      description: 'Capability to check (e.g., spawn.supportsSubagents)',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'tools',
      'provider.supports',
      { providerId: args.providerId, capability: args.capability },
      { command: 'provider', operation: 'tools.provider.supports' },
    );
  },
});

/** cleo provider hooks <event> — list providers that support a specific hook event */
const hooksCommand = defineCommand({
  meta: {
    name: 'hooks',
    description: 'List providers that support a specific hook event (e.g., onSessionStart)',
  },
  args: {
    event: {
      type: 'positional',
      description: 'Hook event name (e.g., onSessionStart)',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'tools',
      'provider.hooks',
      { event: args.event },
      { command: 'provider', operation: 'tools.provider.hooks' },
    );
  },
});

/** cleo provider inject — inject provider references into AGENTS.md */
const injectCommand = defineCommand({
  meta: {
    name: 'inject',
    description: 'Inject provider references into AGENTS.md (project or global scope)',
  },
  args: {
    scope: {
      type: 'string',
      description: 'Scope: project or global (default: project)',
      default: 'project',
    },
    references: {
      type: 'string',
      description: 'Provider reference IDs to inject (comma-separated)',
    },
    content: {
      type: 'string',
      description: 'Content string to inject directly',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'tools',
      'provider.inject',
      {
        scope: args.scope,
        references: args.references as string | undefined,
        content: args.content as string | undefined,
      },
      { command: 'provider', operation: 'tools.provider.inject' },
    );
  },
});

/**
 * Root provider command group — CAAMP provider registry.
 *
 * Defaults to `list` when invoked with no subcommand.
 */
export const providerCommand = defineCommand({
  meta: {
    name: 'provider',
    description: 'CAAMP provider registry: list, detect, supports, hooks, inject',
  },
  subCommands: {
    list: listCommand,
    detect: detectCommand,
    'inject-status': injectStatusCommand,
    supports: supportsCommand,
    hooks: hooksCommand,
    inject: injectCommand,
  },
  async run() {
    await dispatchFromCli(
      'query',
      'tools',
      'provider.list',
      {},
      { command: 'provider', operation: 'tools.provider.list' },
    );
  },
});
