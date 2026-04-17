/**
 * CLI command group for provider adapter management operations.
 *
 * Exposes all tools.adapter.* operations as a native citty subcommand group:
 *
 *   cleo adapter list     — list all discovered provider adapters
 *   cleo adapter show     — show details for a specific adapter
 *   cleo adapter detect   — detect active providers in current environment
 *   cleo adapter health   — health status for adapters
 *   cleo adapter activate — load and activate a provider adapter
 *   cleo adapter dispose  — dispose one or all adapters
 *
 * Default action (no subcommand) delegates to adapter.list.
 *
 * @task T479
 * @epic T443
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/** cleo adapter list — list all discovered provider adapters */
const listCommand = defineCommand({
  meta: { name: 'list', description: 'List all discovered provider adapters' },
  async run() {
    await dispatchFromCli(
      'query',
      'tools',
      'adapter.list',
      {},
      { command: 'adapter', operation: 'tools.adapter.list' },
    );
  },
});

/** cleo adapter show — show details for a specific adapter */
const showCommand = defineCommand({
  meta: { name: 'show', description: 'Show details for a specific adapter' },
  args: {
    adapterId: {
      type: 'positional',
      description: 'Adapter ID to inspect',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'tools',
      'adapter.show',
      { id: args.adapterId },
      { command: 'adapter', operation: 'tools.adapter.show' },
    );
  },
});

/** cleo adapter detect — detect active providers in the current environment */
const detectCommand = defineCommand({
  meta: { name: 'detect', description: 'Detect active providers in the current environment' },
  async run() {
    await dispatchFromCli(
      'query',
      'tools',
      'adapter.detect',
      {},
      { command: 'adapter', operation: 'tools.adapter.detect' },
    );
  },
});

/** cleo adapter health — show health status for adapters */
const healthCommand = defineCommand({
  meta: { name: 'health', description: 'Show health status for adapters' },
  args: {
    id: {
      type: 'string',
      description: 'Specific adapter ID (omit for all adapters)',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'tools',
      'adapter.health',
      { id: args.id as string | undefined },
      { command: 'adapter', operation: 'tools.adapter.health' },
    );
  },
});

/** cleo adapter activate — load and activate a provider adapter */
const activateCommand = defineCommand({
  meta: { name: 'activate', description: 'Load and activate a provider adapter' },
  args: {
    adapterId: {
      type: 'positional',
      description: 'Adapter ID to activate',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'tools',
      'adapter.activate',
      { id: args.adapterId },
      { command: 'adapter', operation: 'tools.adapter.activate' },
    );
  },
});

/** cleo adapter dispose — dispose one or all adapters */
const disposeCommand = defineCommand({
  meta: { name: 'dispose', description: 'Dispose one or all adapters' },
  args: {
    id: {
      type: 'string',
      description: 'Specific adapter ID to dispose (omit to dispose all)',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'tools',
      'adapter.dispose',
      { id: args.id as string | undefined },
      { command: 'adapter', operation: 'tools.adapter.dispose' },
    );
  },
});

/**
 * Root adapter command group — registers all adapter subcommands.
 *
 * Default run (no subcommand) delegates to adapter.list.
 * Dispatches to `tools.adapter.*` registry operations.
 *
 * @task T479
 * @epic T443
 */
export const adapterCommand = defineCommand({
  meta: {
    name: 'adapter',
    description: 'Provider adapter management: list, show, detect, health, activate, dispose',
  },
  subCommands: {
    list: listCommand,
    show: showCommand,
    detect: detectCommand,
    health: healthCommand,
    activate: activateCommand,
    dispose: disposeCommand,
  },
  async run() {
    await dispatchFromCli(
      'query',
      'tools',
      'adapter.list',
      {},
      { command: 'adapter', operation: 'tools.adapter.list' },
    );
  },
});
