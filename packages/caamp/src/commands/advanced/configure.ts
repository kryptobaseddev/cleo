/**
 * advanced configure command
 */

import type { Command } from 'commander';
import { configureProviderGlobalAndProject } from '../../core/advanced/orchestration.js';
import { getProvider } from '../../core/registry/providers.js';
import { readMcpOperations, readTextInput } from './common.js';
import { LAFSCommandError, runLafsCommand } from './lafs.js';

/**
 * Registers the `advanced configure` subcommand for configuring global and project scope in one operation.
 *
 * @remarks
 * Combines MCP operations and instruction content for both global and project scopes into a single
 * command targeting one provider. Reduces multiple CLI invocations to a single atomic operation.
 *
 * @param parent - The parent `advanced` Command to attach the configure subcommand to
 *
 * @example
 * ```bash
 * caamp advanced configure --agent claude-code --global-mcp-file global.json
 * ```
 *
 * @public
 */
export function registerAdvancedConfigure(parent: Command): void {
  parent
    .command('configure')
    .description('Configure global + project scope for one provider in one operation')
    .requiredOption('-a, --agent <name>', 'Target provider ID or alias')
    .option('--global-mcp-file <path>', 'JSON file for global MCP operations')
    .option('--project-mcp-file <path>', 'JSON file for project MCP operations')
    .option('--instruction <text>', 'Instruction content for both scopes')
    .option('--instruction-file <path>', 'Instruction content file for both scopes')
    .option('--instruction-global <text>', 'Instruction content for global scope')
    .option('--instruction-global-file <path>', 'Instruction content file for global scope')
    .option('--instruction-project <text>', 'Instruction content for project scope')
    .option('--instruction-project-file <path>', 'Instruction content file for project scope')
    .option('--project-dir <path>', 'Project directory to resolve project-scope paths')
    .option('--details', 'Include detailed write results')
    .action(
      async (opts: {
        agent: string;
        globalMcpFile?: string;
        projectMcpFile?: string;
        instruction?: string;
        instructionFile?: string;
        instructionGlobal?: string;
        instructionGlobalFile?: string;
        instructionProject?: string;
        instructionProjectFile?: string;
        projectDir?: string;
        details?: boolean;
      }) =>
        runLafsCommand('advanced.configure', opts.details ? 'full' : 'standard', async () => {
          const provider = getProvider(opts.agent);
          if (!provider) {
            throw new LAFSCommandError(
              'E_ADVANCED_PROVIDER_NOT_FOUND',
              `Unknown provider: ${opts.agent}`,
              'Check `caamp providers list` for valid provider IDs/aliases.',
            );
          }

          const globalMcp = opts.globalMcpFile ? await readMcpOperations(opts.globalMcpFile) : [];
          const projectMcp = opts.projectMcpFile
            ? await readMcpOperations(opts.projectMcpFile)
            : [];

          const sharedInstruction = await readTextInput(opts.instruction, opts.instructionFile);
          const globalInstruction = await readTextInput(
            opts.instructionGlobal,
            opts.instructionGlobalFile,
          );
          const projectInstruction = await readTextInput(
            opts.instructionProject,
            opts.instructionProjectFile,
          );

          let instructionContent: string | { global?: string; project?: string } | undefined;

          if (globalInstruction || projectInstruction) {
            instructionContent = {
              ...(globalInstruction ? { global: globalInstruction } : {}),
              ...(projectInstruction ? { project: projectInstruction } : {}),
            };
          } else if (sharedInstruction) {
            instructionContent = sharedInstruction;
          }

          if (globalMcp.length === 0 && projectMcp.length === 0 && !instructionContent) {
            throw new LAFSCommandError(
              'E_ADVANCED_VALIDATION_NO_OPS',
              'No configuration operations were provided.',
              'Provide MCP files and/or instruction content.',
            );
          }

          const result = await configureProviderGlobalAndProject(provider, {
            globalMcp: globalMcp.map((entry) => ({
              serverName: entry.serverName,
              config: entry.config,
            })),
            projectMcp: projectMcp.map((entry) => ({
              serverName: entry.serverName,
              config: entry.config,
            })),
            instructionContent,
            projectDir: opts.projectDir,
          });

          const globalFailures = result.mcp.global.filter((entry) => !entry.success);
          const projectFailures = result.mcp.project.filter((entry) => !entry.success);

          if (globalFailures.length > 0 || projectFailures.length > 0) {
            throw new LAFSCommandError(
              'E_ADVANCED_CONFIGURE_FAILED',
              'One or more MCP writes failed during configure operation.',
              'Inspect the failed write entries and provider config paths, then retry.',
              true,
              result,
            );
          }

          return {
            objective: 'Configure global and project settings in one operation',
            constraints: {
              provider: provider.id,
              globalMcpOps: globalMcp.length,
              projectMcpOps: projectMcp.length,
              instructionMode: instructionContent
                ? typeof instructionContent === 'string'
                  ? 'shared'
                  : 'scoped'
                : 'none',
            },
            acceptanceCriteria: {
              globalWrites: result.mcp.global.length,
              projectWrites: result.mcp.project.length,
            },
            data: opts.details
              ? result
              : {
                  providerId: result.providerId,
                  configPaths: result.configPaths,
                  globalWrites: result.mcp.global.length,
                  projectWrites: result.mcp.project.length,
                  instructionUpdates: {
                    global: result.instructions.global?.size ?? 0,
                    project: result.instructions.project?.size ?? 0,
                  },
                },
          };
        }),
    );
}
