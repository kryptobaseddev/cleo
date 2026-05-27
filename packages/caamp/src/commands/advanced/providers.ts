/**
 * advanced providers command
 */

import type { Command } from 'commander';
import { selectProvidersByMinimumPriority } from '../../core/advanced/orchestration.js';
import { parsePriority, resolveProviders } from './common.js';
import { runLafsCommand } from './lafs.js';

/**
 * Registers the `advanced providers` subcommand for selecting providers by priority tier.
 *
 * @remarks
 * Resolves and filters providers using the advanced wrapper logic, outputting the selected
 * provider set as a LAFS-compliant JSON envelope. Useful for scripted orchestration pipelines.
 *
 * @param parent - The parent `advanced` Command to attach the providers subcommand to
 *
 * @example
 * ```bash
 * caamp advanced providers --min-tier high
 * caamp advanced providers --all --details
 * ```
 *
 * @public
 */
export function registerAdvancedProviders(parent: Command): void {
  parent
    .command('providers')
    .description('Select providers by priority using advanced wrapper logic')
    .option(
      '-a, --agent <name>',
      'Target specific provider(s)',
      (v, prev: string[]) => [...prev, v],
      [],
    )
    .option('--all', 'Use all registry providers (not only detected)')
    .option('--min-tier <tier>', 'Minimum priority tier: high|medium|low', 'low')
    .option('--details', 'Include full provider objects')
    .action(async (opts: { agent: string[]; all?: boolean; minTier: string; details?: boolean }) =>
      runLafsCommand('advanced.providers', opts.details ? 'full' : 'standard', async () => {
        const providers = resolveProviders({ all: opts.all, agent: opts.agent });
        const minTier = parsePriority(opts.minTier);
        const selected = selectProvidersByMinimumPriority(providers, minTier);

        return {
          objective: 'Filter providers by minimum priority tier',
          constraints: {
            minTier,
            selectionMode: opts.all ? 'registry' : 'detected-or-explicit',
          },
          acceptanceCriteria: {
            selectedCount: selected.length,
            orderedByPriority: true,
          },
          data: opts.details
            ? selected
            : selected.map((provider) => ({
                id: provider.id,
                priority: provider.priority,
                status: provider.status,
                configFormat: provider.capabilities.mcp?.configFormat ?? null,
              })),
        };
      }),
    );
}
