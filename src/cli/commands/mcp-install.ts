/**
 * CLI mcp-install command - env-aware MCP server configuration via CAAMP.
 *
 * Detects installed providers via CAAMP, generates the appropriate
 * cleo-mcp server entry based on env mode, and installs to all
 * detected provider configs.
 *
 * @task T4676
 * @epic T4663
 */

import { Command } from 'commander';
import { detectEnvMode, generateMcpServerEntry } from '../../core/mcp/index.js';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import {
  getInstalledProviders,
  installMcpServerToAll,
  installMcpServer,
  getProvider,
  type McpServerConfig,
  type Provider,
} from '@cleocode/caamp';

/**
 * Register the mcp-install command.
 * @task T4676
 */
export function registerMcpInstallCommand(program: Command): void {
  program
    .command('mcp-install')
    .description('Configure CLEO MCP server integration (env-aware, via CAAMP)')
    .option('--tool <name>', 'Configure a single tool/provider (claude-code, cursor, windsurf, etc.)')
    .option('--global', 'Use global/user config scope')
    .option('--project', 'Use project-level config scope')
    .option('--all', 'Configure all detected providers')
    .option('--dry-run', 'Preview changes without writing files')
    .option('--force', 'Overwrite existing cleo config entries')
    .option('--list-tools', 'List detected AI tools/providers')
    .action(async (opts: Record<string, unknown>) => {
      try {
        if (opts['listTools']) {
          const providers = getInstalledProviders();
          const result = {
            providers: providers.map(p => ({
              id: p.id,
              name: p.toolName,
              vendor: p.vendor,
              priority: p.priority,
              instructFile: p.instructFile,
              configFormat: p.configFormat,
            })),
            count: providers.length,
          };
          console.log(formatSuccess(result));
          return;
        }

        const env = detectEnvMode();
        const serverEntry = generateMcpServerEntry(env) as McpServerConfig;
        const scope = opts['global'] ? 'global' as const : 'project' as const;
        const projectDir = process.cwd();

        // If a specific tool is requested, install only to that provider
        if (opts['tool']) {
          const provider = getProvider(opts['tool'] as string);
          if (!provider) {
            console.error(formatError(new CleoError(
              4,
              `Unknown provider: ${opts['tool']}. Use --list-tools to see available providers.`,
            )));
            process.exit(4);
            return;
          }

          if (opts['dryRun']) {
            console.log(formatSuccess({
              env: { mode: env.mode, source: env.source },
              serverEntry,
              results: [{ target: provider.id, action: 'would_write' }],
              dryRun: true,
            }));
            return;
          }

          const result = await installMcpServer(
            provider, 'cleo', serverEntry, scope, projectDir,
          );
          console.log(formatSuccess({
            env: { mode: env.mode, source: env.source },
            serverEntry,
            results: [{
              target: result.provider.id,
              action: result.success ? 'wrote' : 'error',
              path: result.configPath,
              error: result.error,
            }],
          }));
          return;
        }

        // Default: install to all detected providers (or all if --all)
        let providers: Provider[];
        if (opts['all']) {
          providers = getInstalledProviders();
        } else {
          // Default: install to high-priority detected providers
          providers = getInstalledProviders()
            .filter(p => p.priority === 'high' || p.priority === 'medium');
        }

        if (opts['dryRun']) {
          console.log(formatSuccess({
            env: { mode: env.mode, source: env.source },
            serverEntry,
            results: providers.map(p => ({
              target: p.id, action: 'would_write',
            })),
            dryRun: true,
          }));
          return;
        }

        const results = await installMcpServerToAll(
          providers, 'cleo', serverEntry, scope, projectDir,
        );

        console.log(formatSuccess({
          env: { mode: env.mode, source: env.source },
          serverEntry,
          results: results.map(r => ({
            target: r.provider.id,
            action: r.success ? 'wrote' : 'error',
            path: r.configPath,
            error: r.error,
          })),
        }));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
