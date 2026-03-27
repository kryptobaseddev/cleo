/**
 * config show|path commands - LAFS-compliant with JSON-first output
 */

import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import pc from 'picocolors';
import { readConfig } from '../core/formats/index.js';
import {
  ErrorCategories,
  ErrorCodes,
  emitJsonError,
  outputSuccess,
  resolveFormat,
} from '../core/lafs.js';
import { resolveProviderConfigPath } from '../core/paths/standard.js';
import { getProvider } from '../core/registry/providers.js';

/**
 * Registers the `config` command group with show and path subcommands for viewing provider configurations.
 *
 * @remarks
 * The show subcommand outputs LAFS-compliant JSON envelopes by default. The path subcommand
 * intentionally outputs raw paths for shell scripting and does not use LAFS envelopes.
 *
 * @param program - The root Commander program to attach the config command group to
 *
 * @example
 * ```bash
 * caamp config show claude-code --global
 * caamp config path cursor project
 * ```
 *
 * @public
 */
export function registerConfigCommand(program: Command): void {
  const config = program.command('config').description('View provider configuration');

  config
    .command('show')
    .description('Show provider configuration')
    .argument('<provider>', 'Provider ID or alias')
    .option('-g, --global', 'Show global config')
    .option('--json', 'Output as JSON (default)')
    .option('--human', 'Output in human-readable format')
    .action(
      async (providerId: string, opts: { global?: boolean; json?: boolean; human?: boolean }) => {
        const operation = 'config.show';
        const mvi: import('../core/lafs.js').MVILevel = 'standard';

        let format: 'json' | 'human';
        try {
          format = resolveFormat({
            jsonFlag: opts.json ?? false,
            humanFlag: opts.human ?? false,
            projectDefault: 'json',
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          emitJsonError(
            operation,
            mvi,
            ErrorCodes.FORMAT_CONFLICT,
            message,
            ErrorCategories.VALIDATION,
          );
          process.exit(1);
        }

        const provider = getProvider(providerId);

        if (!provider) {
          const message = `Provider not found: ${providerId}`;
          if (format === 'json') {
            emitJsonError(
              operation,
              mvi,
              ErrorCodes.PROVIDER_NOT_FOUND,
              message,
              ErrorCategories.NOT_FOUND,
              {
                providerId,
              },
            );
          } else {
            console.error(pc.red(message));
          }
          process.exit(1);
        }

        const scope = opts.global ? 'global' : 'project';
        const configPath = resolveProviderConfigPath(provider, scope) ?? provider.configPathGlobal;

        if (!existsSync(configPath)) {
          const message = `No config file at: ${configPath}`;
          if (format === 'json') {
            emitJsonError(
              operation,
              mvi,
              ErrorCodes.FILE_NOT_FOUND,
              message,
              ErrorCategories.NOT_FOUND,
              {
                configPath,
                scope,
              },
            );
          } else {
            console.log(pc.dim(message));
          }
          process.exit(1);
        }

        try {
          const data = await readConfig(configPath, provider.configFormat);

          if (format === 'json') {
            outputSuccess(operation, mvi, {
              provider: provider.id,
              config: data,
              format: provider.configFormat,
              scope,
            });
            return;
          }

          // Human-readable output
          console.log(pc.bold(`\n${provider.toolName} config (${configPath}):\n`));
          console.log(JSON.stringify(data, null, 2));
        } catch (err) {
          const message = `Error reading config: ${err instanceof Error ? err.message : String(err)}`;
          if (format === 'json') {
            emitJsonError(
              operation,
              mvi,
              ErrorCodes.FILE_SYSTEM_ERROR,
              message,
              ErrorCategories.INTERNAL,
            );
          } else {
            console.error(pc.red(message));
          }
          process.exit(1);
        }
      },
    );

  config
    .command('path')
    .description('Show config file path (outputs raw path for piping)')
    .argument('<provider>', 'Provider ID or alias')
    .argument('[scope]', 'Scope: project (default) or global', 'project')
    .action((providerId: string, scope: string) => {
      // NOTE: This command intentionally outputs raw paths for shell scripting
      // It does NOT use LAFS envelopes to remain pipe-friendly
      const provider = getProvider(providerId);

      if (!provider) {
        console.error(pc.red(`Provider not found: ${providerId}`));
        process.exit(1);
      }

      if (scope === 'global') {
        console.log(provider.configPathGlobal);
      } else {
        const projectPath = resolveProviderConfigPath(provider, 'project');
        if (projectPath) {
          console.log(projectPath);
        } else {
          console.log(pc.dim(`${provider.toolName} has no project-level config`));
          console.log(provider.configPathGlobal);
        }
      }
    });
}
