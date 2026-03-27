/**
 * advanced batch command
 */

import type { Command } from 'commander';
import {
  installBatchWithRollback,
  selectProvidersByMinimumPriority,
} from '../../core/advanced/orchestration.js';
import {
  parsePriority,
  readMcpOperations,
  readSkillOperations,
  resolveProviders,
} from './common.js';
import { LAFSCommandError, runLafsCommand } from './lafs.js';

/**
 * Registers the `advanced batch` subcommand for rollback-capable batch install of MCP and skills.
 *
 * @remarks
 * Installs MCP servers and skills from JSON files in a single atomic operation with automatic
 * rollback on failure. Supports minimum priority tier filtering and project directory resolution.
 *
 * @param parent - The parent `advanced` Command to attach the batch subcommand to
 *
 * @example
 * ```bash
 * caamp advanced batch --mcp-file mcp.json --skills-file skills.json
 * caamp advanced batch --mcp-file mcp.json --min-tier medium
 * ```
 *
 * @public
 */
export function registerAdvancedBatch(parent: Command): void {
  parent
    .command('batch')
    .description('Run rollback-capable batch install for MCP + skills')
    .option(
      '-a, --agent <name>',
      'Target specific provider(s)',
      (v, prev: string[]) => [...prev, v],
      [],
    )
    .option('--all', 'Use all registry providers (not only detected)')
    .option('--min-tier <tier>', 'Minimum priority tier: high|medium|low', 'low')
    .option('--mcp-file <path>', 'JSON file containing McpBatchOperation[]')
    .option('--skills-file <path>', 'JSON file containing SkillBatchOperation[]')
    .option('--project-dir <path>', 'Project directory to resolve project-scope paths')
    .option('--details', 'Include detailed operation result')
    .action(
      async (opts: {
        agent: string[];
        all?: boolean;
        minTier: string;
        mcpFile?: string;
        skillsFile?: string;
        projectDir?: string;
        details?: boolean;
      }) =>
        runLafsCommand('advanced.batch', opts.details ? 'full' : 'standard', async () => {
          const baseProviders = resolveProviders({ all: opts.all, agent: opts.agent });
          const minimumPriority = parsePriority(opts.minTier);
          const providers = selectProvidersByMinimumPriority(baseProviders, minimumPriority);

          const mcp = opts.mcpFile ? await readMcpOperations(opts.mcpFile) : [];
          const skills = opts.skillsFile ? await readSkillOperations(opts.skillsFile) : [];

          if (mcp.length === 0 && skills.length === 0) {
            throw new LAFSCommandError(
              'E_ADVANCED_VALIDATION_NO_OPS',
              'No operations provided.',
              'Provide --mcp-file and/or --skills-file.',
            );
          }

          if (providers.length === 0) {
            throw new LAFSCommandError(
              'E_ADVANCED_NO_TARGET_PROVIDERS',
              'No target providers resolved for this batch operation.',
              'Use --all or pass provider IDs with --agent.',
            );
          }

          const result = await installBatchWithRollback({
            providers,
            minimumPriority,
            mcp,
            skills,
            projectDir: opts.projectDir,
          });

          if (!result.success) {
            throw new LAFSCommandError(
              'E_ADVANCED_BATCH_FAILED',
              result.error ?? 'Batch operation failed.',
              'Check rollbackErrors and input configs, then retry.',
              true,
              result,
            );
          }

          return {
            objective: 'Install MCP and skills with rollback safety',
            constraints: {
              minimumPriority,
              providerCount: providers.length,
              mcpOps: mcp.length,
              skillOps: skills.length,
            },
            acceptanceCriteria: {
              success: result.success,
              rollbackPerformed: result.rollbackPerformed,
            },
            data: opts.details
              ? result
              : {
                  providerCount: result.providerIds.length,
                  mcpApplied: result.mcpApplied,
                  skillsApplied: result.skillsApplied,
                  rollbackPerformed: result.rollbackPerformed,
                },
          };
        }),
    );
}
