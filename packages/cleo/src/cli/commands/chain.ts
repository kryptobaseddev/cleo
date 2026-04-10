/**
 * CLI chain command group.
 *
 * WarpChain pipeline operations for tier-2 orchestrator workflows.
 * Covers the 5 chain.* operations: show, list, add, instantiate, advance.
 *
 * @task T483
 */

import { readFileSync } from 'node:fs';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

/**
 * Register the `chain` subcommand group on the given program.
 *
 * @param program - Root ShimCommand to attach the `chain` group to.
 */
export function registerChainCommand(program: Command): void {
  const chain = program
    .command('chain')
    .description('WarpChain pipeline management (tier-2 orchestrator)');

  chain
    .command('show <chainId>')
    .description('Show details for a WarpChain definition')
    .action(async (chainId: string) => {
      await dispatchFromCli('query', 'pipeline', 'chain.show', { chainId }, { command: 'chain' });
    });

  chain
    .command('list')
    .description('List all WarpChain definitions')
    .action(async () => {
      await dispatchFromCli('query', 'pipeline', 'chain.list', {}, { command: 'chain' });
    });

  chain
    .command('add <file>')
    .description('Add a new WarpChain definition from a JSON file')
    .action(async (file: string) => {
      const chainJson = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
      await dispatchFromCli(
        'mutate',
        'pipeline',
        'chain.add',
        { chain: chainJson },
        { command: 'chain' },
      );
    });

  chain
    .command('instantiate <chainId> <epicId>')
    .description('Instantiate a WarpChain for an epic')
    .action(async (chainId: string, epicId: string) => {
      await dispatchFromCli(
        'mutate',
        'pipeline',
        'chain.instantiate',
        { chainId, epicId },
        { command: 'chain' },
      );
    });

  chain
    .command('advance <instanceId> <nextStage>')
    .description('Advance a WarpChain instance to the next stage')
    .action(async (instanceId: string, nextStage: string) => {
      await dispatchFromCli(
        'mutate',
        'pipeline',
        'chain.advance',
        { instanceId, nextStage },
        { command: 'chain' },
      );
    });
}
