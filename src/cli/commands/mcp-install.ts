/**
 * CLI mcp-install command - env-aware MCP server configuration.
 *
 * Detects dev-ts vs prod-npm mode and writes appropriate MCP config
 * to .mcp.json and .agents/mcp/servers.json.
 *
 * @task T4584
 * @epic T4577
 */

import { Command } from 'commander';
import {
  installMcp,
  listMcpTools,
} from '../../core/mcp/index.js';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';

/**
 * Register the mcp-install command.
 * @task T4584
 */
export function registerMcpInstallCommand(program: Command): void {
  program
    .command('mcp-install')
    .description('Configure CLEO MCP server integration (env-aware)')
    .option('--tool <name>', 'Configure a single tool (claude-code, cursor, vscode)')
    .option('--global', 'Use global/user config scope')
    .option('--project', 'Use project-level config scope')
    .option('--all', 'Configure all supported tools in addition to defaults')
    .option('--dry-run', 'Preview changes without writing files')
    .option('--force', 'Overwrite existing cleo config entries')
    .option('--list-tools', 'List detected AI tools')
    .action(async (opts: Record<string, unknown>) => {
      try {
        if (opts['listTools']) {
          const result = await listMcpTools();
          console.log(formatSuccess(result));
          return;
        }

        const result = await installMcp({
          tool: opts['tool'] as string | undefined,
          global: opts['global'] as boolean | undefined,
          project: opts['project'] as boolean | undefined,
          all: opts['all'] as boolean | undefined,
          dryRun: opts['dryRun'] as boolean | undefined,
          force: opts['force'] as boolean | undefined,
        });
        console.log(formatSuccess(result));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
