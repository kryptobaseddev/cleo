/**
 * mcp install command - LAFS-compliant with JSON-first output
 */

import type { Command } from 'commander';
import pc from 'picocolors';
import {
  ErrorCategories,
  ErrorCodes,
  emitJsonError,
  outputSuccess,
  resolveFormat,
} from '../../core/lafs.js';
import { isHuman } from '../../core/logger.js';
import { buildServerConfig, installMcpServerToAll } from '../../core/mcp/installer.js';
import { recordMcpInstall } from '../../core/mcp/lock.js';
import { getInstalledProviders } from '../../core/registry/detection.js';
import { getProvider } from '../../core/registry/providers.js';
import { parseSource } from '../../core/sources/parser.js';
import type { Provider } from '../../types.js';
import {
  executeCleoInstall,
  mapCompatibilityInstallOptions,
  shouldUseCleoCompatibilityInstall,
} from './cleo.js';

/**
 * Registers the `mcp install` subcommand for installing MCP servers to agent configurations.
 *
 * @remarks
 * Supports URL, npm package, and command sources with per-agent transforms. Automatically
 * delegates to CLEO compatibility install when the source is "cleo" with a channel flag.
 * Records installations in the lock file for tracking.
 *
 * @param parent - The parent `mcp` Command to attach the install subcommand to
 *
 * @example
 * ```bash
 * caamp mcp install https://example.com/server --agent claude-code
 * caamp mcp install my-server --all --global
 * ```
 *
 * @public
 */
export function registerMcpInstall(parent: Command): void {
  parent
    .command('install')
    .description('Install MCP server to agent configs')
    .argument('<source>', 'MCP server source (URL, npm package, or command)')
    .option(
      '-a, --agent <name>',
      'Target specific agent(s)',
      (v, prev: string[]) => [...prev, v],
      [],
    )
    .option(
      '--provider <id>',
      'Target provider ID (alias for --agent)',
      (v, prev: string[]) => [...prev, v],
      [],
    )
    .option('-g, --global', 'Install to global/user config')
    .option('-n, --name <name>', 'Override inferred server name')
    .option('--channel <channel>', 'Managed channel profile (stable|beta|dev)')
    .option('--version <tag>', 'Managed profile tag/version for stable or beta')
    .option('--command <command>', 'Managed dev profile command')
    .option(
      '--arg <arg>',
      'Managed dev command arg (repeatable)',
      (v, prev: string[]) => [...prev, v],
      [],
    )
    .option(
      '--env <kv>',
      'Managed env assignment KEY=value (repeatable)',
      (v, prev: string[]) => [...prev, v],
      [],
    )
    .option('--cleo-dir <path>', 'Managed dev CLEO_DIR override')
    .option('-t, --transport <type>', 'Transport type: http (default) or sse', 'http')
    .option(
      '--header <header>',
      'HTTP header (Key: Value)',
      (v, prev: string[]) => [...prev, v],
      [],
    )
    .option('-y, --yes', 'Skip confirmation')
    .option('--all', 'Install to all detected agents')
    .option('--interactive', 'Guided interactive setup for managed profiles')
    .option('--dry-run', 'Preview without writing')
    .option('--json', 'Output as JSON (default)')
    .option('--human', 'Output in human-readable format')
    .action(
      async (
        source: string,
        opts: {
          agent: string[];
          provider: string[];
          global?: boolean;
          name?: string;
          channel?: string;
          version?: string;
          command?: string;
          arg: string[];
          env: string[];
          cleoDir?: string;
          transport: string;
          header: string[];
          yes?: boolean;
          all?: boolean;
          interactive?: boolean;
          dryRun?: boolean;
          json?: boolean;
          human?: boolean;
        },
      ) => {
        const operation = 'mcp.install';
        const mvi: import('../../core/lafs.js').MVILevel = 'standard';

        let format: 'json' | 'human';
        try {
          format = resolveFormat({
            jsonFlag: opts.json ?? false,
            humanFlag: (opts.human ?? false) || isHuman(),
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

        if (shouldUseCleoCompatibilityInstall(source, opts.channel)) {
          const cleoOpts = mapCompatibilityInstallOptions(opts);
          await executeCleoInstall('install', cleoOpts, operation);
          return;
        }

        const parsed = parseSource(source);
        const serverName = opts.name ?? parsed.inferredName;

        // Parse headers
        const headers: Record<string, string> = {};
        for (const h of opts.header) {
          const idx = h.indexOf(':');
          if (idx > 0) {
            headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
          }
        }

        const config = buildServerConfig(parsed, opts.transport, headers);

        // Determine target providers
        let providers: Provider[];

        if (opts.all) {
          providers = getInstalledProviders();
        } else if (opts.agent.length > 0) {
          providers = opts.agent
            .map((a) => getProvider(a))
            .filter((p): p is Provider => p !== undefined);
        } else if (opts.provider.length > 0) {
          providers = opts.provider
            .map((a) => getProvider(a))
            .filter((p): p is Provider => p !== undefined);
        } else {
          providers = getInstalledProviders();
        }

        if (providers.length === 0) {
          const message = 'No target providers found.';
          if (format === 'json') {
            emitJsonError(
              operation,
              mvi,
              ErrorCodes.PROVIDER_NOT_FOUND,
              message,
              ErrorCategories.NOT_FOUND,
            );
          } else {
            console.error(pc.red(message));
          }
          process.exit(1);
        }

        const scope = opts.global ? ('global' as const) : ('project' as const);

        if (opts.dryRun) {
          if (format === 'json') {
            outputSuccess(operation, mvi, {
              installed: [
                {
                  name: serverName,
                  providers: providers.map((p) => p.id),
                  config,
                },
              ],
              dryRun: true,
            });
          } else {
            console.log(pc.bold('Dry run - would install:'));
            console.log(`  Server: ${pc.bold(serverName)}`);
            console.log(`  Config: ${JSON.stringify(config, null, 2)}`);
            console.log(`  Scope: ${scope}`);
            console.log(`  Providers: ${providers.map((p) => p.id).join(', ')}`);
          }
          return;
        }

        if (format === 'human') {
          console.log(pc.dim(`Installing "${serverName}" to ${providers.length} provider(s)...\n`));
        }

        const results = await installMcpServerToAll(providers, serverName, config, scope);

        const succeeded = results.filter((r) => r.success);
        const _failed = results.filter((r) => !r.success);

        if (format === 'human') {
          for (const r of results) {
            if (r.success) {
              console.log(
                `  ${pc.green('✓')} ${r.provider.toolName.padEnd(22)} ${pc.dim(r.configPath)}`,
              );
            } else {
              console.log(
                `  ${pc.red('✗')} ${r.provider.toolName.padEnd(22)} ${pc.red(r.error ?? 'failed')}`,
              );
            }
          }
        }

        if (succeeded.length > 0) {
          await recordMcpInstall(
            serverName,
            source,
            parsed.type,
            succeeded.map((r) => r.provider.id),
            opts.global ?? false,
          );
        }

        if (format === 'json') {
          outputSuccess(operation, mvi, {
            installed: succeeded.map((r) => ({
              name: serverName,
              providers: [r.provider.id],
              config,
            })),
            dryRun: false,
          });
        } else {
          console.log(pc.bold(`\n${succeeded.length}/${results.length} providers configured.`));
        }
      },
    );
}
