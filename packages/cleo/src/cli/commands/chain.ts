/**
 * CLI chain command group — WarpChain pipeline operations.
 *
 * Exposes the 5 chain operations registered under the pipeline domain
 * as a native citty subcommand group:
 *
 *   cleo chain show <chainId>              — show a WarpChain definition
 *   cleo chain list                        — list all WarpChain definitions
 *   cleo chain add <file>                  — add a definition from a JSON file
 *   cleo chain instantiate <chainId> <epicId> — instantiate for an epic
 *   cleo chain advance <instanceId> <nextStage> — advance to next stage
 *
 * All subcommands dispatch to `pipeline.chain.*` registry entries via
 * dispatchFromCli.
 *
 * @task T483
 */

import { readFileSync } from 'node:fs';
import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/** cleo chain show — display details for a WarpChain definition */
const showCommand = defineCommand({
  meta: { name: 'show', description: 'Show details for a WarpChain definition' },
  args: {
    chainId: {
      type: 'positional',
      description: 'WarpChain definition ID',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'pipeline',
      'chain.show',
      { chainId: args.chainId },
      { command: 'chain' },
    );
  },
});

/** cleo chain list — list all WarpChain definitions */
const listCommand = defineCommand({
  meta: { name: 'list', description: 'List all WarpChain definitions' },
  async run() {
    await dispatchFromCli('query', 'pipeline', 'chain.list', {}, { command: 'chain' });
  },
});

/** cleo chain add — register a new WarpChain definition from a JSON file */
const addCommand = defineCommand({
  meta: { name: 'add', description: 'Add a new WarpChain definition from a JSON file' },
  args: {
    file: {
      type: 'positional',
      description: 'Path to JSON file containing the WarpChain definition',
      required: true,
    },
  },
  async run({ args }) {
    const chainJson = JSON.parse(readFileSync(args.file, 'utf-8')) as Record<string, unknown>;
    await dispatchFromCli(
      'mutate',
      'pipeline',
      'chain.add',
      { chain: chainJson },
      { command: 'chain' },
    );
  },
});

/** cleo chain instantiate — create a running instance of a WarpChain for an epic */
const instantiateCommand = defineCommand({
  meta: { name: 'instantiate', description: 'Instantiate a WarpChain for an epic' },
  args: {
    chainId: {
      type: 'positional',
      description: 'WarpChain definition ID to instantiate',
      required: true,
    },
    epicId: {
      type: 'positional',
      description: 'Epic ID to attach the instance to',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'pipeline',
      'chain.instantiate',
      { chainId: args.chainId, epicId: args.epicId },
      { command: 'chain' },
    );
  },
});

/** cleo chain advance — move a WarpChain instance to the next stage */
const advanceCommand = defineCommand({
  meta: { name: 'advance', description: 'Advance a WarpChain instance to the next stage' },
  args: {
    instanceId: {
      type: 'positional',
      description: 'WarpChain instance ID to advance',
      required: true,
    },
    nextStage: {
      type: 'positional',
      description: 'Name of the stage to advance to',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'pipeline',
      'chain.advance',
      { instanceId: args.instanceId, nextStage: args.nextStage },
      { command: 'chain' },
    );
  },
});

/**
 * Root chain command group — registers all 5 WarpChain subcommands.
 *
 * Dispatches to `pipeline.chain.*` registry operations.
 */
export const chainCommand = defineCommand({
  meta: { name: 'chain', description: 'WarpChain pipeline management (tier-2 orchestrator)' },
  subCommands: {
    show: showCommand,
    list: listCommand,
    add: addCommand,
    instantiate: instantiateCommand,
    advance: advanceCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
